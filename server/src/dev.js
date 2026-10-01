// 一键本地开发：启动 SMTP 模拟器 + API（5174）+ Vite 前端（5173，已配代理）
import { spawn } from 'node:child_process';
const procs = [
  ['smtp-simulator', ['server/src/smtp-simulator.js'], {}],
  ['api', ['server/src/server.js'], {}],
  ['vite', ['node_modules/vite/bin/vite.js'], { cwd: 'client' }],
];
const children = procs.map(([name, args, o]) => {
  const c = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, ...o });
  c.on('exit', (code) => { if (code) console.error('[dev]', name, 'exited with', code); });
  return c;
});
function shutdown(code) { for (const c of children) c.kill(); process.exit(code || 0); }
process.on('SIGINT', () => shutdown(0));
