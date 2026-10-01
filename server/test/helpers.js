// 测试辅助：独立数据目录 + 启动模拟器与 API
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

export function startSimulator(dataDir, port = 2625, cport = 2626) {
  const p = spawn(process.execPath, ['server/src/smtp-simulator.js'], {
    cwd: ROOT,
    env: { ...process.env, SIM_SMTP_PORT: String(port), SIM_HTTP_PORT: String(cport), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('simulator boot timeout')), 4000);
    p.stdout.on('data', (d) => { if (String(d).includes('control on')) { clearTimeout(t); resolve(p); } });
    p.stderr.on('data', (d) => process.stderr.write('[sim] ' + d));
    p.on('exit', (c) => { if (c !== 0) reject(new Error('sim exited ' + c)); });
  });
}

export function startApi(dataDir, port = 5674, smtpPort = 2625) {
  const p = spawn(process.execPath, ['server/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir, PORT: String(port), SMTP_PORT: String(smtpPort),
      PUBLIC_BASE: `http://localhost:${port}`,
      PUMP_INTERVAL_MS: '60', RETRY_BASE_MS: '10', SMTP_CONNECT_TIMEOUT: '15000',
      RENDER_CRASH_SENTINEL: path.join(dataDir, 'render-crash-once'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('api boot timeout')), 6000);
    p.stdout.on('data', (d) => { if (String(d).includes('[api]')) { clearTimeout(t); resolve(p); } });
    p.stderr.on('data', (d) => process.stderr.write('[api] ' + d));
    p.on('exit', (c) => { if (c !== 0) reject(new Error('api exited ' + c)); });
  });
}

export async function api(port, method, p, body, userId = 1) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json', 'X-User-Id': String(userId) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DARK_BAD_HTML = (extra = '') => `
<h1 style="color:#001020;">标题</h1>
<p style="color:#0a1a2a;">正文文字，深色模式下不可读。</p>
<p><a href="https://example.test/x">链接</a></p>
<p><a data-no-rewrite href="http://localhost/unsubscribe?t=1">退订</a></p>${extra}`;

export const GOOD_HTML = (extra = '') => `
<h1 style="color:#111111;background-color:#ffffff;">你好 {{name}}</h1>
<p style="color:#1a1a1a;background-color:#ffffff;">城市：{{city}}</p>
<p><a href="https://example.test/products">查看商品</a></p>
<p><a data-no-rewrite href="{{{unsubscribe_url}}}">退订此类邮件</a></p>
<style>@media (prefers-color-scheme: dark){ body{color:#e8eaed;background-color:#121214;} }</style>${extra}`;
