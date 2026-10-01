// 本地邮件接收模拟器：SMTP 服务 + HTTP 收件箱/故障注入控制
// 用法: node server/src/smtp-simulator.js  (SMTP 默认 2525, HTTP 默认 2526)
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SMTP_PORT = Number(process.env.SIM_SMTP_PORT || 2525);
const HTTP_PORT = Number(process.env.SIM_HTTP_PORT || 2526);
const STORE = path.join(config.dataDir, 'sim-messages.json');

const STATE = {
  messages: fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : [],
  // faults: [{ match: email|'*', type: 'tempfail'|'drop_response'|'close', stage: 'data'|'rcpt', once: true }]
  faults: [],
  // holds: { [email]: { socket, send, resolved } } 消息已收但暂不回执
  holds: {},
};
const persist = () => fs.writeFileSync(STORE, JSON.stringify(STATE.messages));

function takeFault(rcpt) {
  const i = STATE.faults.findIndex(
    (f) => f.match === '*' || f.match.toLowerCase() === String(rcpt || '').toLowerCase()
  );
  if (i < 0) return null;
  const f = STATE.faults[i];
  if (f.once !== false) STATE.faults.splice(i, 1);
  return f;
}
function peekFault(rcpt) {
  return STATE.faults.find(
    (f) => f.match === '*' || f.match.toLowerCase() === String(rcpt || '').toLowerCase()
  ) || null;
}

function parseMessage(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  const headerBlock = sep >= 0 ? raw.slice(0, sep) : raw;
  const headers = {};
  for (const line of headerBlock.split('\r\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  const dec = (v) => String(v || '').replace(/=\?UTF-8\?B\?(.*?)\?=/g, (_, b) =>
    Buffer.from(b, 'base64').toString('utf8'));
  return {
    messageId: String(headers['message-id'] || '').replace(/[<>]/g, ''),
    subject: dec(headers.subject),
    from: headers.from || '',
    headers,
    body: sep >= 0 ? raw.slice(sep + 4) : raw,
  };
}

const smtp = net.createServer((socket) => {
  let rcpt = null;
  let dataMode = false;
  let dataBuf = '';
  const send = (code, text) => socket.write(`${code} ${text}\r\n`);
  send(220, 'mailcamp-simulator ESMTP ready');

  socket.on('data', (chunk) => {
    if (dataMode) {
      dataBuf += chunk.toString();
      if (!/\r?\n\.\r?\n$/.test(dataBuf)) return;
      dataMode = false;
      let raw = dataBuf.replace(/\r?\n\.\r?\n$/, '');
      raw = raw.replace(/\r\n\.\./g, '\r\n.');
      const fault = takeFault(rcpt);
      const held = STATE.holds[String(rcpt || '').toLowerCase()] || null;

      if (fault && fault.type === 'tempfail') {
        send(451, 'temporary local error, please retry');
        return;
      }
      if (fault && fault.type === 'close') { socket.destroy(); return; }

      const parsed = parseMessage(raw);
      // MTA 幂等：相同 Message-ID 的重投不再产生第二封，但仍正常应答
      const dup = STATE.messages.find((x) => x.messageId && x.messageId === parsed.messageId);
      const msg = { ...parsed, to: rcpt, received_at: Date.now() };
      if (fault && fault.type === 'drop_response') {
        // 已收下邮件但不发送 250，模拟应答丢失
        msg.fault = 'drop_response';
        if (!dup) { STATE.messages.push(msg); persist(); }
        setTimeout(() => socket.destroy(), 40);
        return;
      }
      // hold：消息已落地，但在测试显式放行前不回 250（用于确定性复现竞态）
      if (held) {
        if (!dup) { STATE.messages.push(msg); persist(); }
        held.socket = socket; held.send = send; held.resolved = false;
        return;
      }
      if (!dup) { STATE.messages.push(msg); persist(); }
      else {
        // 可观察到去重：在 HTTP 列表计数里体现 dedup 次数
        dup.duplicateDeliveries = (dup.duplicateDeliveries || 0) + 1;
        persist();
      }
      send(250, dup ? '2.0.0 Ok: duplicate message-id accepted' : '2.0.0 Ok: message accepted');
      return;
    }

    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      const sp = line.indexOf(' ');
      const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      const arg = sp < 0 ? '' : line.slice(sp + 1);
      const addr = ((arg.match(/<([^>]*)>/) || [])[1] || arg || '').trim();
      switch (cmd) {
        case 'EHLO': case 'HELO': send(250, 'mailcamp-simulator greets you'); break;
        case 'MAIL': send(250, 'sender ok'); break;
        case 'RCPT': {
          rcpt = addr;
          const f = peekFault(rcpt);
          if (f && f.type === 'tempfail' && f.stage === 'rcpt') {
            takeFault(rcpt);
            send(451, 'temporary local error at RCPT, try again');
          } else if (f && f.type === 'close' && f.stage === 'rcpt') {
            takeFault(rcpt); socket.destroy();
          } else {
            send(250, 'recipient ok');
          }
          break;
        }
        case 'DATA': send(354, 'start mail input'); dataMode = true; dataBuf = ''; break;
        case 'RSET': send(250, 'reset'); break;
        case 'NOOP': send(250, 'ok'); break;
        case 'QUIT': send(221, 'bye'); socket.end(); break;
        default: send(500, 'unknown command');
      }
    }
  });
  socket.on('error', () => socket.destroy());
});

// ---------- HTTP 控制面 ----------
const httpServer = http.createServer((req, res) => {
  const j = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return j(200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/messages') {
    const to = url.searchParams.get('to');
    const list = to ? STATE.messages.filter((m) => m.to === to) : STATE.messages;
    return j(200, list.map(redact));
  }
  if (req.method === 'GET' && url.pathname.startsWith('/messages/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const m = STATE.messages.find((x) => x.messageId === id);
    return m ? j(200, redact(m, true)) : j(404, { error: 'not found' });
  }
  if (req.method === 'POST' && url.pathname === '/faults') {
    return readBody(req, (body) => {
      const f = { match: body.match || '*', type: body.type || 'tempfail', stage: body.stage || 'data', once: body.once !== false };
      STATE.faults.push(f);
      j(200, { ok: true, faults: STATE.faults });
    });
  }
  if (req.method === 'GET' && url.pathname === '/faults') return j(200, STATE.faults);
  if (req.method === 'DELETE' && url.pathname === '/faults') { STATE.faults = []; return j(200, { ok: true }); }
  // 对某收件人挂起回执：消息落地但不回 250
  if (req.method === 'POST' && url.pathname === '/holds') {
    return readBody(req, (body) => {
      STATE.holds[String(body.email || '').toLowerCase()] = {};
      j(200, { ok: true });
    });
  }
  // 放行：返回被挂起邮件的状态（是否已到达），并补发 250
  const hm = url.pathname.match(/^\/holds\/(.+)\/release$/);
  if (hm && req.method === 'POST') {
    const key = decodeURIComponent(hm[1]).toLowerCase();
    const h = STATE.holds[key];
    if (!h) return j(404, { error: 'no hold' });
    if (h.socket && !h.resolved) { h.resolved = true; h.send(250, '2.0.0 Ok: released after hold'); }
    delete STATE.holds[key];
    return j(200, { ok: true, messageArrived: !!h.socket });
  }
  if (req.method === 'GET' && url.pathname === '/holds') {
    return j(200, Object.fromEntries(Object.entries(STATE.holds).map(([k, v]) => [k, { arrived: !!v.socket }])));
  }
  if (req.method === 'POST' && url.pathname === '/reset') {
    for (const h of Object.values(STATE.holds)) { try { h.socket && h.send(451, 'reset'); } catch {} }
    STATE.messages = []; STATE.faults = []; STATE.holds = {}; persist();
    return j(200, { ok: true });
  }
  j(404, { error: 'not found' });
});

// 收件箱对外不暴露个性化正文全文，仅返回结构、前若干字符与安全标记，便于断言“不泄露正文”
function decodeAllBody(m) {
  // MIME 正文为 base64 块，逐段解码拼接
  return String(m.body || '').split(/\s+/).map((b64) => {
    try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return ''; }
  }).join('');
}
function redact(m, full = false) {
  const decoded = decodeAllBody(m);
  return {
    messageId: m.messageId, to: m.to, from: m.from, subject: m.subject,
    received_at: m.received_at, fault: m.fault || null,
    bodyPreview: String(m.body || '').slice(0, 80),
    bodyLength: String(m.body || '').length,
    duplicateDeliveries: m.duplicateDeliveries || 0,
    // 安全断言标记（布尔值，不回传正文）
    hasUnsubscribeUrl: /\/u\/[a-f0-9]{24}/.test(decoded),
    unsubscribeRewrittenAsShortlink: /href="https?:\/\/[^"]*\/c\/link\/[^"]*"[^>]*>[^<]*退订/.test(decoded),
    listUnsubscribeHeader: (m.headers['list-unsubscribe'] || ''),
  };
}
function readBody(req, cb) {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { cb({}); } });
}

smtp.listen(SMTP_PORT, () => console.log(`[sim] SMTP on ${SMTP_PORT}`));
httpServer.listen(HTTP_PORT, () => console.log(`[sim] control on ${HTTP_PORT}`));
