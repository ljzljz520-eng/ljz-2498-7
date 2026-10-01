// HTTP API：编辑器/模板校验发布、受众版本、候选批、快照与发送、退订、短链跳转
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, logEvent } from './db.js';
import { config } from './config.js';
import { seed } from './seed.js';
import { checkTemplate, renderHtml, renderString } from './mail-template.js';
import { RenderPool } from './render-pool.js';
import { Pump, buildSnapshot, diffSnapshot, makeTokens, isUnsubscribed } from './delivery.js';

seed();
const pool = new RenderPool(2);
const pump = new Pump();

const SAMPLE_VARS = {
  name: '示例用户', email: 'demo@example.test', city: '上海',
  unsubscribe_url: `${config.publicBase}/u/DEMOTOKEN`,
  preferences_url: `${config.publicBase}/p/DEMOTOKEN`,
};

function currentUser(req) {
  // 演示鉴权：X-User-Id，默认 1
  const id = Number(req.headers['x-user-id'] || 1);
  return db.prepare('SELECT * FROM users WHERE id=?').get(id) || db.prepare('SELECT * FROM users WHERE id=1').get();
}
function userGroupIds(userId) {
  return new Set(db.prepare('SELECT group_id FROM user_groups WHERE user_id=?').all(userId).map((r) => r.group_id));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
const j = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

async function api(req, res, url) {
  const user = currentUser(req);
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
  const p = url.pathname;

  // --- 模板：沙箱渲染 ---
  if (p === '/api/render' && req.method === 'POST') {
    const { subject = '', preheader = '', bodyHtml = '', vars } = body;
    const useVars = vars && typeof vars === 'object' ? { ...SAMPLE_VARS, ...vars } : SAMPLE_VARS;
    const result = await pool.run({
      type: 'render',
      template: bodyHtml,
      vars: useVars,
      opts: { publicBase: config.publicBase, batchToken: 'preview', tracking: body.tracking || {} },
    });
    return j(res, 200, {
      subject: renderString(subject, useVars),
      preheader: renderString(preheader, useVars),
      html: result.html,
    });
  }

  // --- 模板：发布前检查（渲染子进程执行，崩溃自动重启重试） ---
  if (p === '/api/check' && req.method === 'POST') {
    const crash = !!body.crash;
    const result = await pool.run(
      { type: 'check', template: { subject: body.subject, preheader: body.preheader, bodyHtml: body.bodyHtml }, crash },
      { tries: crash ? 4 : 2 }
    );
    return j(res, 200, { ...result, pool: pool.stats });
  }

  // --- 活动 ---
  if (p === '/api/campaigns' && req.method === 'GET') {
    return j(res, 200, db.prepare(`
      SELECT c.*, (SELECT MAX(version) FROM template_versions tv WHERE tv.campaign_id=c.id) template_version
      FROM campaigns c ORDER BY c.id`).all());
  }
  if (p === '/api/campaigns' && req.method === 'POST') {
    const info = db.prepare('INSERT INTO campaigns (name, created_by, created_at) VALUES (?,?,?)')
      .run(body.name || '未命名活动', user.id, Date.now());
    const insCG = db.prepare('INSERT INTO campaign_groups (campaign_id, group_id, name, created_at) VALUES (?,?,?,?)');
    for (const [gid, gn] of [[1, 'growth'], [2, 'billing']]) insCG.run(info.lastInsertRowid, gid, gn, Date.now());
    return j(res, 200, { id: info.lastInsertRowid });
  }

  let m;
  if ((m = p.match(/^\/api\/campaigns\/(\d+)$/)) && req.method === 'GET') {
    const cid = Number(m[1]);
    const versions = db.prepare('SELECT id, version, subject, preheader, published_at, check_json, tracking_json FROM template_versions WHERE campaign_id=? ORDER BY version DESC').all(cid);
    return j(res, 200, { campaign: db.prepare('SELECT * FROM campaigns WHERE id=?').get(cid), versions });
  }

  // --- 发布模板版本：主题/预览/正文/跟踪参数冻结到同一发布版 ---
  if ((m = p.match(/^\/api\/campaigns\/(\d+)\/publish$/)) && req.method === 'POST') {
    const cid = Number(m[1]);
    const check = await pool.run({
      type: 'check',
      template: { subject: body.subject, preheader: body.preheader, bodyHtml: body.bodyHtml },
    });
    if (!check.ok) return j(res, 422, { error: 'template_invalid', check });
    const row = db.prepare('SELECT COALESCE(MAX(version),0)+1 v FROM template_versions WHERE campaign_id=?').get(cid);
    const info = db.prepare(`INSERT INTO template_versions
      (campaign_id, version, subject, preheader, body_html, tracking_json, check_json, published_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      cid, row.v, body.subject, body.preheader || '', body.bodyHtml,
      JSON.stringify(body.tracking || {}), JSON.stringify(check), Date.now());
    return j(res, 200, { id: info.lastInsertRowid, version: row.v, check });
  }
  if ((m = p.match(/^\/api\/template-versions\/(\d+)$/)) && req.method === 'GET') {
    return j(res, 200, db.prepare('SELECT * FROM template_versions WHERE id=?').get(Number(m[1])));
  }

  // --- 受众版本 ---
  if (p === '/api/audiences' && req.method === 'GET') {
    return j(res, 200, db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM audience_members m WHERE m.audience_id=a.id) size
      FROM audiences a ORDER BY a.id DESC`).all());
  }
  if (p === '/api/audiences' && req.method === 'POST') {
    // 文本导入：每行 "email,名字,city=xx"；生成不可变新版本
    const name = body.name || '导入名单';
    const prev = db.prepare('SELECT COALESCE(MAX(version),0)+1 v FROM audiences WHERE name=?').get(name).v;
    const parsed = [];
    const emailRe = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
    for (const line of String(body.csv || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [email, nm = '', extra = ''] = line.split(',').map((x) => x.trim());
      if (!emailRe.test(email)) continue;
      const vars = {};
      for (const kv of extra.split(';')) {
        const [k, ...v] = kv.split('='); if (k && v.length) vars[k.trim()] = v.join('=').trim();
      }
      parsed.push({ email, name: nm, vars });
    }
    const info = db.prepare('INSERT INTO audiences (name, version, created_by, created_at, size) VALUES (?,?,?,?,?)')
      .run(name, prev, user.id, Date.now(), parsed.length);
    const ins = db.prepare('INSERT INTO audience_members (audience_id, email, name, vars_json) VALUES (?,?,?,?)');
    const tx = db.transaction(() => { for (const x of parsed) ins.run(info.lastInsertRowid, x.email, x.name, JSON.stringify(x.vars)); });
    tx();
    return j(res, 200, { id: info.lastInsertRowid, version: prev, imported: parsed.length });
  }
  if ((m = p.match(/^\/api\/audiences\/(\d+)\/members$/)) && req.method === 'GET') {
    return j(res, 200, db.prepare('SELECT email, name, vars_json FROM audience_members WHERE audience_id=?').all(Number(m[1])));
  }

  // --- 退订 ---
  if (p === '/api/unsubscribe' && req.method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email.includes('@')) return j(res, 400, { error: 'bad email' });
    db.prepare('INSERT OR IGNORE INTO unsubscribes (email, created_at, reason, campaign_id) VALUES (?,?,?,?)')
      .run(email, Date.now(), body.reason || 'user', body.campaignId || null);
    // 抑制尚未进入 SMTP 在途的任务；attempted 表示消息可能已在 MTA，交由确认时对账
    db.prepare(`UPDATE recipients SET status='suppressed', error='unsubscribed before in-flight'
      WHERE lower(email)=lower(?) AND status IN ('pending','prepared')`).run(email);
    const rows = db.prepare(`SELECT batch_id, id FROM recipients WHERE lower(email)=lower(?) AND status='confirmed'`).all(email);
    for (const r of rows) logEvent(r.batch_id, r.id, 'unsubscribed_after_confirm', 'confirmed delivery retained');
    return j(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/u\/([A-Za-z0-9]+)$/)) && req.method === 'GET') {
    const r = db.prepare('SELECT * FROM recipients WHERE token=?').get(m[1]);
    res.writeHead(302, { location: `/unsubscribed.html?email=${encodeURIComponent(r ? r.email : '')}` });
    return res.end();
  }
  if ((m = p.match(/^\/u\/([A-Za-z0-9]+)\/confirm$/)) && req.method === 'POST') {
    const r = db.prepare('SELECT * FROM recipients WHERE token=?').get(m[1]);
    if (r) {
      db.prepare('INSERT OR IGNORE INTO unsubscribes (email, created_at, reason, campaign_id) VALUES (?,?,?,?)')
        .run(r.email.toLowerCase(), Date.now(), 'link', r.batch_id);
      db.prepare(`UPDATE recipients SET status='suppressed' WHERE id=? AND status IN ('pending','prepared')`).run(r.id);
      logEvent(r.batch_id, r.id, 'unsubscribed_after_confirm', 'via one-click link');
    }
    return j(res, 200, { ok: true });
  }

  // --- 候选发送批 ---
  if (p === '/api/batches' && req.method === 'GET') {
    const rows = db.prepare(`SELECT b.*, c.name campaign_name FROM send_batches b
      JOIN campaigns c ON c.id=b.campaign_id ORDER BY b.id DESC`).all();
    return j(res, 200, rows);
  }
  if (p === '/api/batches' && req.method === 'POST') {
    // 创建候选批：固定模板发布版 + 受众版本 + 分组（越权校验）
    const tpl = db.prepare('SELECT * FROM template_versions WHERE id=?').get(Number(body.templateVersionId));
    if (!tpl) return j(res, 404, { error: 'template version not found' });
    const aud = db.prepare('SELECT * FROM audiences WHERE id=?').get(Number(body.audienceId));
    if (!aud) return j(res, 404, { error: 'audience not found' });
    const groupId = body.groupId ? Number(body.groupId) : null;
    if (groupId !== null) {
      const g = db.prepare('SELECT * FROM campaign_groups WHERE group_id=? AND campaign_id=?').get(groupId, tpl.campaign_id);
      if (!g) return j(res, 404, { error: 'group not found in campaign' });
      if (user.role !== 'admin' && !userGroupIds(user.id).has(groupId)) {
        return j(res, 403, { error: 'group_forbidden', message: '分组越权：你不属于该分组' });
      }
    }
    const token = crypto.randomBytes(8).toString('hex');
    const info = db.prepare(`INSERT INTO send_batches
      (token, campaign_id, template_version_id, audience_id, group_id, status, created_by, created_at)
      VALUES (?,?,?,?,?, 'candidate', ?, ?)`)
      .run(token, tpl.campaign_id, tpl.id, aud.id, groupId, user.id, Date.now());
    const bid = info.lastInsertRowid;
    const members = db.prepare('SELECT * FROM audience_members WHERE audience_id=?').all(aud.id);
    const insR = db.prepare(`INSERT INTO recipients (batch_id, email, name, vars_json) VALUES (?,?,?,?)
      ON CONFLICT(batch_id, email) DO NOTHING`);
    const tx = db.transaction(() => {
      for (const mm of members) insR.run(bid, mm.email, mm.name, mm.vars_json);
    });
    tx();
    makeTokens(bid);
    return j(res, 200, { id: bid, token, recipients: members.length });
  }

  if ((m = p.match(/^\/api\/batches\/(\d+)\/ready$/)) && req.method === 'POST') {
    const bid = Number(m[1]);
    const batch = db.prepare('SELECT * FROM send_batches WHERE id=?').get(bid);
    if (!batch) return j(res, 404, { error: 'batch not found' });
    if (batch.group_id && user.role !== 'admin' && !userGroupIds(user.id).has(batch.group_id)) {
      return j(res, 403, { error: 'group_forbidden' });
    }
    // 整批快照：冻结每位收件人订阅状态
    const snap = buildSnapshot(bid);
    const states = db.prepare('SELECT email FROM recipients WHERE batch_id=?').all(bid).map((r) => ({
      email: r.email, state: isUnsubscribed(r.email) ? 'U' : 'S',
    }));
    snap.states = states;
    db.prepare("UPDATE send_batches SET status='ready', ready_at=?, snapshot_json=? WHERE id=?")
      .run(Date.now(), JSON.stringify(snap), bid);
    // 冻结快照里已退订的直接抑制
    db.prepare(`UPDATE recipients SET status='suppressed', error='unsubscribed in batch snapshot'
      WHERE batch_id=? AND lower(email) IN (SELECT lower(email) FROM unsubscribes)`).run(bid);
    return j(res, 200, { ok: true, snapshot: snap });
  }
  if ((m = p.match(/^\/api\/batches\/(\d+)\/diff$/)) && req.method === 'GET') {
    const bid = Number(m[1]);
    const batch = db.prepare('SELECT * FROM send_batches WHERE id=?').get(bid);
    if (!batch.snapshot_json || batch.snapshot_json === '{}') return j(res, 400, { error: 'no snapshot' });
    return j(res, 200, diffSnapshot(bid, JSON.parse(batch.snapshot_json)));
  }
  if ((m = p.match(/^\/api\/batches\/(\d+)\/send$/)) && req.method === 'POST') {
    const bid = Number(m[1]);
    const batch = db.prepare('SELECT * FROM send_batches WHERE id=?').get(bid);
    if (!batch) return j(res, 404, { error: 'batch not found' });
    if (batch.group_id && user.role !== 'admin' && !userGroupIds(user.id).has(batch.group_id)) {
      return j(res, 403, { error: 'group_forbidden' });
    }
    if (!['ready', 'sending', 'done', 'done_with_failures'].includes(batch.status)) {
      return j(res, 409, { error: 'batch not ready' });
    }
    pump.start(bid);
    return j(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/batches\/(\d+)$/)) && req.method === 'GET') {
    const bid = Number(m[1]);
    const batch = db.prepare('SELECT * FROM send_batches WHERE id=?').get(bid);
    const recipients = db.prepare(`SELECT id, email, name, status, attempts, last_attempt_at,
      confirmed_at, smtp_response, error, message_id FROM recipients WHERE batch_id=? ORDER BY id`).all(bid);
    const counts = {};
    for (const r of recipients) counts[r.status] = (counts[r.status] || 0) + 1;
    return j(res, 200, { batch, recipients, counts });
  }
  if ((m = p.match(/^\/api\/batches\/(\d+)\/links$/)) && req.method === 'GET') {
    const bid = Number(m[1]);
    return j(res, 200, db.prepare('SELECT url_hash, url, clicks FROM links WHERE batch_id=?').all(bid));
  }
  if ((m = p.match(/^\/api\/batches\/(\d+)\/log$/)) && req.method === 'GET') {
    const bid = Number(m[1]);
    // 日志只含事件与状态码，不含个性化正文/变量值
    const logs = db.prepare(`SELECT event, detail, created_at,
      (SELECT email FROM recipients WHERE id=recipient_id) email
      FROM delivery_log WHERE batch_id=? ORDER BY id`).all(bid);
    return j(res, 200, logs);
  }

  // --- 短链跳转（退订链接不会出现在 links 表） ---
  if ((m = p.match(/^\/c\/link\/(\d+)\/([a-f0-9]+)$/)) && req.method === 'GET') {
    const link = db.prepare('SELECT * FROM links WHERE batch_id=? AND url_hash=?').get(Number(m[1]), m[2]);
    if (!link) { res.writeHead(404); return res.end('not found'); }
    db.prepare('UPDATE links SET clicks=clicks+1 WHERE id=?').run(link.id);
    res.writeHead(302, { location: link.url });
    return res.end();
  }
  if (p.startsWith('/c/') || p.startsWith('/p/')) { res.writeHead(404); return res.end(); }

  if (p === '/api/health') return j(res, 200, { ok: true, pool: pool.stats });

  return j(res, 404, { error: 'not found', path: p });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/u/') || url.pathname.startsWith('/c/link')) {
      return await api(req, res, url);
    }
    // 静态前端
    let filePath = path.join(config.clientDist, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(config.clientDist) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(config.clientDist, 'index.html');
    }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    j(res, 500, { error: String(err.message || err) });
  }
});

server.listen(config.port, () => console.log(`[api] http://localhost:${config.port}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { pump.stopAll(); await pool.stop(); process.exit(0); });
