// 渲染子进程：每帧请求一行 JSON，返回一行 JSON。可被杀死以模拟渲染进程退出。
import fs from 'node:fs';
import { config } from './config.js';
import { checkTemplate, renderHtml } from './mail-template.js';

function crashMaybe(job) {
  // 启动即崩溃 或 对带 crash 标记的任务崩溃一次（消费哨兵）
  if (process.env.RENDER_CRASH_ON_BOOT === '1' && !process.env.WORKER_BOOTED) {
    process.env.WORKER_BOOTED = '1';
    process.exit(7);
  }
  if (job && job.crash && fs.existsSync(config.crashSentinel)) {
    try { fs.unlinkSync(config.crashSentinel); } catch {}
    process.exit(7);
  }
}

process.on('message', (job) => {
  try {
    crashMaybe(job);
    if (job.type === 'check') {
      const result = checkTemplate(job.template);
      process.send({ id: job.id, ok: true, result });
    } else if (job.type === 'render') {
      const html = renderHtml(job.template, job.vars, job.opts || {});
      process.send({ id: job.id, ok: true, result: { html } });
    } else if (job.type === 'ping') {
      process.send({ id: job.id, ok: true, result: { pong: true } });
    } else {
      process.send({ id: job.id, ok: false, error: 'unknown job type' });
    }
  } catch (err) {
    process.send({ id: job.id, ok: false, error: String(err && err.message || err) });
  }
});

process.send({ ready: true, pid: process.pid });
crashMaybe(null);
