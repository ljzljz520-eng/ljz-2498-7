// 投递编排：候选批 -> 整批快照 -> 领取任务时逐人复查 -> 幂等发送 -> 重试/确认
import crypto from 'node:crypto';
import { db, logEvent } from './db.js';
import { config } from './config.js';
import { renderHtml, appendTracking, hashForUrl, validateUrl } from './mail-template.js';
import { sendMail, buildMimeMessage, SmtpError } from './smtp-client.js';

const FROM = process.env.MAIL_FROM || 'campaign@example.test';

export function isUnsubscribed(email) {
  return !!db.prepare('SELECT 1 FROM unsubscribes WHERE email = ? COLLATE NOCASE').get(email);
}

// 生成整批订阅快照指纹
export function buildSnapshot(batchId) {
  const members = db.prepare('SELECT id, email FROM recipients WHERE batch_id = ?').all(batchId);
  const unsubNow = new Set(
    db.prepare(`SELECT lower(email) e FROM unsubscribes
                WHERE lower(email) IN (${members.map(() => '?').join(',')})`)
      .all(...members.map((m) => m.email.toLowerCase())).map((r) => r.e)
  );
  const states = members.map((m) => `${m.email}:${unsubNow.has(m.email.toLowerCase()) ? 'U' : 'S'}`).sort();
  const fingerprint = crypto.createHash('sha256').update(states.join('|')).digest('hex');
  return { at: Date.now(), total: members.length, unsubscribed: unsubNow.size, fingerprint };
}

export function diffSnapshot(batchId, snapshot) {
  const current = buildSnapshot(batchId);
  const before = new Map((snapshot.states || []).map((s) => [s.email, s.state]));
  const members = db.prepare('SELECT email FROM recipients WHERE batch_id = ?').all(batchId);
  const changed = [];
  for (const m of members) {
    const now = isUnsubscribed(m.email) ? 'U' : 'S';
    if (before.has(m.email) && before.get(m.email) !== now) {
      changed.push({ email: m.email, from: before.get(m.email), to: now });
    }
  }
  return { changed, currentFingerprint: current.fingerprint, same: current.fingerprint === snapshot.fingerprint };
}

export function makeTokens(batchId) {
  const upd = db.prepare("UPDATE recipients SET token = ? WHERE id = ?");
  const rows = db.prepare('SELECT id FROM recipients WHERE batch_id = ? AND token = ?').all(batchId, '');
  const tx = db.transaction((rs) => { for (const r of rs) upd.run(crypto.randomBytes(12).toString('hex'), r.id); });
  tx(rows);
}

// 把模板中的 http(s) 链接登记到 links 表并返回短链路径；退订链接永不进入
function makeLinkRegistrar(batchId) {
  const ins = db.prepare(`INSERT OR IGNORE INTO links (batch_id, url_hash, url) VALUES (?, ?, ?)`);
  return (url) => {
    const hash = hashForUrl(url);
    ins.run(batchId, hash, url);
    return `/c/link/${batchId}/${hash}`;
  };
}

function unsubscribeUrl(recipient) {
  return `${config.publicBase}/u/${recipient.token}`;
}

function buildMessage(recipient, tpl, batch, tracking) {
  const vars = {
    ...JSON.parse(recipient.vars_json || '{}'),
    name: recipient.name,
    email: recipient.email,
    unsubscribe_url: unsubscribeUrl(recipient),
    preferences_url: `${config.publicBase}/p/${recipient.token}`,
  };
  const registerUrl = makeLinkRegistrar(batch.id);
  const html = renderHtml(tpl.body_html, vars, {
    publicBase: config.publicBase,
    batchToken: batch.token,
    tracking: { batch: batch.token, ...tracking, ...JSON.parse(tpl.tracking_json || '{}') },
    registerUrl,
  });
  const subject = renderHtml(tpl.subject, vars, {});
  const messageId = `${batch.token}-${recipient.id}@mailcamp`;
  const raw = buildMimeMessage({
    from: FROM, to: recipient.email, subject, html,
    messageId,
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl(recipient)}>` },
  });
  return { raw, messageId, subject };
}

// 幂等：message_id 唯一回执，重复成功只确认一次
function recordReceipt(recipient, code, response) {
  db.prepare(`INSERT OR IGNORE INTO delivery_receipts (message_id, recipient_id, code, response, received_at)
              VALUES (?, ?, ?, ?, ?)`).run(recipient.message_id, recipient.id, code, response, Date.now());
}

// 发送前 / 领取时的单收件人复查（事务内抢占式领取）
function claimNext(batchId) {
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM recipients
      WHERE batch_id = ? AND status IN ('pending','prepared','attempted')
        AND attempts < ?
      ORDER BY id LIMIT 1`).get(batchId, config.retry.maxAttempts);
    if (!row) return null;
    // 领取即复查订阅状态
    if (isUnsubscribed(row.email)) {
      db.prepare(`UPDATE recipients SET status='suppressed', error='unsubscribed before claim' WHERE id=?`).run(row.id);
      logEvent(batchId, row.id, 'suppressed', 'unsubscribed at claim time');
      return claimNext(batchId);
    }
    const next = row.status === 'pending' ? 'prepared' : row.status;
    db.prepare(`UPDATE recipients SET status=?, attempts = attempts + 1, last_attempt_at=? WHERE id=?`)
      .run(next, Date.now(), row.id);
    return db.prepare('SELECT * FROM recipients WHERE id = ?').get(row.id);
  })();
}

async function deliverOne(batchId, recipient) {
  const tpl = db.prepare(`SELECT t.* FROM template_versions t
                         JOIN send_batches b ON b.template_version_id = t.id WHERE b.id = ?`).get(batchId);
  const batch = db.prepare('SELECT * FROM send_batches WHERE id = ?').get(batchId);
  const tracking = {};
  const { raw, messageId, subject } = buildMessage(recipient, tpl, batch, tracking);

  if (!recipient.message_id) {
    db.prepare('UPDATE recipients SET message_id=?, status=? WHERE id=?')
      .run(messageId, 'prepared', recipient.id);
  }
  logEvent(batchId, recipient.id, 'prepared', `attempt=${recipient.attempts}`);
  db.prepare('UPDATE recipients SET status=?, last_attempt_at=? WHERE id=?')
    .run('attempted', Date.now(), recipient.id);
  logEvent(batchId, recipient.id, 'attempted', 'smtp connected');

  try {
    const res = await sendMail({ from: FROM, to: recipient.email, raw, messageId });
    recordReceipt({ ...recipient, message_id: messageId }, res.code, res.response);
    // 确认前最后一次复查：应答返回前用户可能已退订（消息已在 MTA 落地）
    if (isUnsubscribed(recipient.email)) {
      // 已送达无法撤回：保留 confirmed 并记录“确认后退订”竞态
      db.prepare(`UPDATE recipients SET status='confirmed', smtp_response=?, confirmed_at=?,
                  error='unsubscribed during in-flight delivery; receipt retained' WHERE id=?`)
        .run(`${res.code} ${res.response}`, Date.now(), recipient.id);
      logEvent(batchId, recipient.id, 'unsubscribed_after_confirm', 'unsubscribe landed before receipt; delivery acknowledged, retained');
    } else {
      db.prepare(`UPDATE recipients SET status='confirmed', smtp_response=?, confirmed_at=?, error=NULL WHERE id=?`)
        .run(`${res.code} ${res.response}`, Date.now(), recipient.id);
      logEvent(batchId, recipient.id, 'confirmed', `${res.code}`);
    }
  } catch (err) {
    if (err instanceof SmtpError && err.transient) {
      // 临时失败：保留 attempted，等待 pump 重试（attempts 已在领取时递增）
      db.prepare('UPDATE recipients SET status=?, error=? WHERE id=?')
        .run('attempted', `4xx: ${err.message}`.slice(0, 200), recipient.id);
      logEvent(batchId, recipient.id, 'retry_scheduled', String(err.code));
    } else if (err instanceof SmtpError && err.code && err.code >= 500) {
      db.prepare("UPDATE recipients SET status='failed', error=? WHERE id=?")
        .run(`5xx: ${err.message}`.slice(0, 200), recipient.id);
      logEvent(batchId, recipient.id, 'failed_permanent', String(err.code));
    } else {
      // 超时/连接丢失 = 应答可能已到达 => 视作未知投递，保留 attempted 走重试，
      // 依赖模拟器端 message-id 去重 + 回执表幂等
      db.prepare("UPDATE recipients SET status='attempted', error=? WHERE id=?")
        .run(`uncertain: ${err.message}`.slice(0, 200), recipient.id);
      logEvent(batchId, recipient.id, 'response_lost', err.message.slice(0, 80));
    }
  }
}

// 确认后再退订的竞态：收件人已 confirmed 不撤回投递，但登记原因（后续批次不再发送）
export function noteConfirmedUnsubscribe(email) {
  const rows = db.prepare(`SELECT r.id, r.batch_id, r.status FROM recipients r
                           JOIN unsubscribes u ON lower(u.email)=lower(r.email)
                           WHERE r.status='confirmed'`).all();
  for (const r of rows) logEvent(r.batch_id, r.id, 'unsubscribed_after_confirm', 'delivery already acknowledged');
  return rows.length;
}

export class Pump {
  constructor() { this.timers = new Map(); this.running = new Set(); }

  start(batchId) {
    if (this.timers.has(batchId)) return;
    db.prepare("UPDATE send_batches SET status='sending' WHERE id=?").run(batchId);
    const tick = async () => {
      if (this.running.has(batchId)) return;
      this.running.add(batchId);
      try {
        // 每次循环最多顺序处理若干收件人
        for (let i = 0; i < 8; i++) {
          const recipient = claimNext(batchId);
          if (!recipient) break;
          await deliverOne(batchId, recipient);
        }
      } finally { this.running.delete(batchId); }

      const pending = db.prepare(`SELECT COUNT(*) c FROM recipients
        WHERE batch_id=? AND status IN ('pending','prepared','attempted') AND attempts < ?`)
        .get(batchId, config.retry.maxAttempts).c;
      // 无在途/可重试任务时，把重试耗尽仍处于 attempted/prepared 的收件人置为终态
      if (pending === 0) {
        db.prepare(`UPDATE recipients SET status='failed',
                    error = COALESCE(error,'retries exhausted')
                    WHERE batch_id=? AND status IN ('attempted','prepared') AND attempts >= ?`)
          .run(batchId, config.retry.maxAttempts);
        const failed = db.prepare(`SELECT COUNT(*) c FROM recipients WHERE batch_id=? AND status='failed'`).get(batchId).c;
        db.prepare("UPDATE send_batches SET status=? WHERE id=?")
          .run(failed ? 'done_with_failures' : 'done', batchId);
        clearInterval(this.timers.get(batchId));
        this.timers.delete(batchId);
      }
    };
    const t = setInterval(tick, config.retry.pumpIntervalMs);
    this.timers.set(batchId, t);
    tick();
  }

  stopAll() { for (const t of this.timers.values()) clearInterval(t); this.timers.clear(); }
}
