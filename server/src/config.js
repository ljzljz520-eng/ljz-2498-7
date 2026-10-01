import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), '.data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const config = {
  dataDir: DATA_DIR,
  dbFile: process.env.DB_FILE || path.join(DATA_DIR, 'app.db'),
  port: Number(process.env.PORT || 5174),
  clientDist: path.resolve(process.cwd(), 'client', 'dist'),
  publicBase: process.env.PUBLIC_BASE || 'http://localhost:5174',
  smtp: {
    host: process.env.SMTP_HOST || '127.0.0.1',
    port: Number(process.env.SMTP_PORT || 2525),
    connectTimeoutMs: Number(process.env.SMTP_CONNECT_TIMEOUT || 2000),
  },
  retry: {
    maxAttempts: Number(process.env.MAX_ATTEMPTS || 3),
    baseDelayMs: Number(process.env.RETRY_BASE_MS || 200),
    pumpIntervalMs: Number(process.env.PUMP_INTERVAL_MS || 150),
  },
  // sentinel file path used by render child process to simulate a one-shot crash
  crashSentinel: process.env.RENDER_CRASH_SENTINEL || path.join(DATA_DIR, 'render-crash-once'),
};
