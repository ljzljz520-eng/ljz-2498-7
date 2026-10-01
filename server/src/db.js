import Database from './sqlite-wasm.js';
import { config } from './config.js';

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'editor',
  created_at INTEGER NOT NULL
);

-- 受众：按版本快照存放（每次导入/更新生成新版本，行不可变）
CREATE TABLE IF NOT EXISTS audiences (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  UNIQUE(name, version)
);
CREATE TABLE IF NOT EXISTS audience_members (
  id INTEGER PRIMARY KEY,
  audience_id INTEGER NOT NULL REFERENCES audiences(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  vars_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(audience_id, email)
);

-- 退订记录：全局按邮箱生效，记录时间与操作者（用户自助 / 管理员 / 竞态取消）
CREATE TABLE IF NOT EXISTS unsubscribes (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT 'user',
  campaign_id INTEGER
);

-- 订阅状态也冗余记录在成员侧（subscribed / unsubscribed），以 unsubscribes 表为准
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS user_groups (
  user_id INTEGER NOT NULL REFERENCES users(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  PRIMARY KEY(user_id, group_id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- 固定到同一发布版的主题/预览文案/正文/跟踪参数
CREATE TABLE IF NOT EXISTS template_versions (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  version INTEGER NOT NULL,
  subject TEXT NOT NULL,
  preheader TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL,
  tracking_json TEXT NOT NULL DEFAULT '{}',
  -- 渲染校验结果随发布快照冻结
  check_json TEXT NOT NULL DEFAULT '{}',
  published_at INTEGER NOT NULL,
  UNIQUE(campaign_id, version)
);

CREATE TABLE IF NOT EXISTS campaign_groups (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(campaign_id, group_id)
);

-- 候选发送批：引用固定受众版本 + 固定模板发布版
CREATE TABLE IF NOT EXISTS send_batches (
  id INTEGER PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  template_version_id INTEGER NOT NULL REFERENCES template_versions(id),
  audience_id INTEGER NOT NULL REFERENCES audiences(id),
  group_id INTEGER REFERENCES campaign_groups(id),
  status TEXT NOT NULL DEFAULT 'candidate', -- candidate -> ready -> sending -> done (| aborted)
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  -- 整批快照：建批时冻结订阅状态指纹
  snapshot_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS recipients (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES send_batches(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  vars_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- pending|prepared|attempted|confirmed|suppressed|failed
  token TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  message_id TEXT,
  smtp_response TEXT,
  confirmed_at INTEGER,
  error TEXT,
  UNIQUE(batch_id, email)
);
CREATE INDEX IF NOT EXISTS idx_recipients_status ON recipients(batch_id, status);

-- 投递追踪：短链映射（退订链接永不进入此表/永不被改写）
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES send_batches(id),
  url_hash TEXT NOT NULL,
  url TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  UNIQUE(batch_id, url_hash)
);

-- 幂等键：message_id 唯一，重复回执只确认一次
CREATE TABLE IF NOT EXISTS delivery_receipts (
  id INTEGER PRIMARY KEY,
  message_id TEXT UNIQUE NOT NULL,
  recipient_id INTEGER NOT NULL REFERENCES recipients(id),
  code INTEGER,
  response TEXT,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_log (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`);

export function logEvent(batchId, recipientId, event, detail = '') {
  db.prepare(
    `INSERT INTO delivery_log (batch_id, recipient_id, event, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(batchId, recipientId, event, detail, Date.now());
}
