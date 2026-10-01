// 极简 SMTP 客户端（明文，面向本地模拟器），点填充 + 可区分临时/永久/无应答
import net from 'node:net';
import { config } from './config.js';

export class SmtpError extends Error {
  constructor(message, code) { super(message); this.code = code; this.transient = code >= 400 && code < 500; }
}

export function buildMimeMessage({ from, to, subject, html, text, messageId, headers = {} }) {
  const enc = (v) => {
    const needs = /[^\x20-\x7E]/.test(v);
    return needs ? `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=` : v;
  };
  const boundary = '----mcamp' + Math.random().toString(36).slice(2);
  const lines = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  lines.push(`Subject: ${enc(subject)}`);
  lines.push(`Message-ID: <${messageId}>`);
  lines.push('MIME-Version: 1.0');
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Buffer.from(text || stripHtml(html), 'utf8').toString('base64'));
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/html; charset=utf-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Buffer.from(html, 'utf8').toString('base64'));
  lines.push('');
  lines.push(`--${boundary}--`);
  const raw = lines.join('\r\n').replace(/\r?\n/g, '\r\n');
  return dotStuff(raw);
}

function dotStuff(raw) {
  return raw.split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
}
function stripHtml(html) {
  return String(html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// 发送一封；返回 { code, response, messageId }
export function sendMail({ from, to, raw, messageId, connectTimeoutMs = config.smtp.connectTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: config.smtp.host, port: config.smtp.port });
    let buffer = '';
    let step = 0;
    let settled = false;
    let stage = 'connect';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new SmtpError(`timeout at ${stage}`, 450));
    }, connectTimeoutMs);

    const fail = (err) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); reject(err); } };
    const ok = (val) => { if (!settled) { settled = true; clearTimeout(timer); try { socket.end(); } catch {} resolve(val); } };

    socket.on('error', (err) => fail(new SmtpError('socket: ' + err.message, 450)));
    // 对端在未应答前关闭连接（应答丢失/连接被切）：立即按未知投递处理
    socket.on('close', () => { if (!settled) fail(new SmtpError('connection closed before final response', 450)); });

    const commands = [
      null, // 等待问候
      `EHLO localhost`,
      `MAIL FROM:<${from}>`,
      `RCPT TO:<${to}>`,
      'DATA',
      raw + '\r\n.',
      null, // 等待回执后 QUIT
    ];

    const sendNext = (code, line) => {
      stage = `step${step}`;
      if (step === 0 && !(code >= 200 && code < 300)) return fail(new SmtpError('greeting failed: ' + line, code || 450));
      if (step === 1 && !(code >= 200 && code < 300)) return fail(new SmtpError('EHLO failed: ' + line, code));
      if (step === 2 && !(code >= 200 && code < 300)) return fail(new SmtpError('MAIL FROM failed: ' + line, code));
      if (step === 3 && !(code >= 200 && code < 300)) {
        // 5xx 永久失败（如退订硬拦截），4xx 临时
        return fail(new SmtpError('RCPT failed: ' + line, code));
      }
      if (step === 4 && code !== 354) return fail(new SmtpError('DATA not accepted: ' + line, code));
      if (step === 5 && !(code >= 200 && code < 300)) return fail(new SmtpError('data rejected: ' + line, code));
      step++;
      if (step === 6) return ok({ code, response: line, messageId });
      const cmd = commands[step];
      socket.write(cmd + '\r\n');
    };

    socket.on('connect', () => { stage = 'greeting'; });
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      // SMTP 多行：最终行格式 "code SP text"
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        // 多行中间行形如 "250-..."，等最终行
        if (/^\d{3}-/.test(line)) continue;
        const m = line.match(/^(\d{3})\s?(.*)$/);
        if (!m) continue;
        const code = Number(m[1]);
        // 应答丢失场景：服务器在 DATA 后什么都不回，由超时兜底
        if (step === 5 && code === 0) continue;
        sendNext(code, m[2] || line);
      }
    });
  });
}
