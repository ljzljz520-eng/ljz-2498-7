import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'render-worker.js');

export class RendererPool {
  constructor({ timeoutMs = 5000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.worker = null;
    this.starting = null;
  }

  async startWorker() {
    if (this.worker && !this.worker.killed) return this.worker;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const child = fork(workerFile, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.stdout.on('data', (chunk) => process.stdout.write(`[renderer] ${chunk}`));
      child.stderr.on('data', (chunk) => process.stderr.write(`[renderer] ${chunk}`));
      child.on('message', (message) => {
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.type === 'error') {
          const error = new Error(message.error.message);
          error.code = message.error.code;
          error.details = message.error.details;
          item.reject(error);
        } else {
          item.resolve(message.result);
        }
      });
      child.on('exit', (code, signal) => {
        this.worker = null;
        this.starting = null;
        for (const [id, item] of this.pending) {
          clearTimeout(item.timer);
          item.reject(Object.assign(new Error('renderer process exited before result'), {
            code: 'RENDERER_CRASH',
            exitCode: code,
            signal,
            requestId: id,
          }));
        }
        this.pending.clear();
      });
      await once(child, 'spawn');
      this.worker = child;
      return child;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async request(type, payload) {
    const id = this.nextId++;
    const child = await this.startWorker();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        child.kill('SIGKILL');
        reject(Object.assign(new Error('renderer request timed out'), { code: 'RENDERER_TIMEOUT' }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, type, ...payload }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  validate(template) {
    return this.request('validate', { template });
  }

  render(template, context = {}) {
    return this.request('render', { template, context });
  }

  async crashAfterReply() {
    return this.request('crash-after-reply', {});
  }

  async stop() {
    if (this.worker) {
      const child = this.worker;
      this.worker = null;
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => {});
    }
  }
}
