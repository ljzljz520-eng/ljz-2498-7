// 渲染进程池：fork worker，崩溃自动重启；任务失败可换进程重试
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class RenderPool {
  constructor(size = 2) {
    this.size = size;
    this.workers = [];
    this.seq = 0;
    this.stats = { started: 0, restarts: 0, crashes: 0, jobs: 0 };
    for (let i = 0; i < size; i++) this.workers.push(this.#spawn());
  }

  #spawn() {
    const child = fork(path.join(__dirname, 'render-worker.js'), [], {
      env: { ...process.env, WORKER_BOOTED: process.env.RENDER_CRASH_ON_BOOT === '1' ? '' : '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.stats.started++;
    const w = { child, busy: false, alive: true, ready: false, queue: [] };
    child.on('message', (msg) => {
      if (msg.ready) { w.ready = true; return; }
      const job = w.queue.find((j) => j.id === msg.id);
      if (!job) return;
      w.queue = w.queue.filter((j) => j.id !== msg.id);
      w.busy = false;
      job.done(msg);
    });
    child.on('exit', (code) => {
      w.alive = false; w.ready = false; w.busy = false;
      if (!w.expected) {
        this.stats.crashes++;
        // 让在途任务失败（调用方会重试）
        for (const job of w.queue) job.done({ ok: false, error: `render worker exited (code ${code})` });
        w.queue = [];
        const idx = this.workers.indexOf(w);
        if (idx >= 0) {
          this.stats.restarts++;
          this.workers[idx] = this.#spawn();
        }
      }
    });
    return w;
  }

  #acquire() {
    return new Promise((resolve) => {
      const tryPick = () => {
        const ready = this.workers.filter((w) => w.alive && w.ready && !w.busy);
        if (ready.length) { resolve(ready[0]); return true; }
        return false;
      };
      if (!tryPick()) {
        const t = setInterval(() => { if (tryPick()) clearInterval(t); }, 15);
      }
    });
  }

  async #runOnce(job) {
    const w = await this.#acquire();
    this.stats.jobs++;
    const id = ++this.seq;
    return new Promise((resolve) => {
      const payload = { ...job, id };
      w.busy = true;
      w.queue.push({ id, done: resolve });
      w.child.send(payload, (err) => {
        if (err) resolve({ ok: false, error: String(err.message || err) });
      });
    });
  }

  // 遇到 worker 退出类错误会换进程重试
  async run(job, { tries = 3 } = {}) {
    let last;
    for (let attempt = 0; attempt < tries; attempt++) {
      const res = await this.#runOnce(job);
      if (res.ok) return res.result;
      last = res;
      if (!/exited|channel closed|channel closed before/i.test(String(res.error))) {
        const err = new Error(res.error);
        err.renderError = true;
        throw err;
      }
      await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
    }
    throw Object.assign(new Error(last.error || 'render failed'), { renderError: true });
  }

  async stop() {
    for (const w of this.workers) { w.expected = true; try { w.child.kill(); } catch {} }
  }
}
