// 演示数据：用户（含分组）、受众版本、示例活动
import { db } from './db.js';

export function seed() {
  const now = Date.now();
  const insUser = db.prepare('INSERT OR IGNORE INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)');
  insUser.run(1, 'alice@example.test', 'Alice', 'editor', now);
  insUser.run(2, 'bob@example.test', 'Bob', 'editor', now);
  insUser.run(3, 'admin@example.test', 'Admin', 'admin', now);

  const insGroup = db.prepare('INSERT OR IGNORE INTO groups (id, name) VALUES (?,?)');
  insGroup.run(1, 'growth'); insGroup.run(2, 'billing');
  const ug = db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?,?)');
  ug.run(1, 1); ug.run(2, 2); ug.run(3, 1); ug.run(3, 2);

  const insCamp = db.prepare('INSERT OR IGNORE INTO campaigns (id, name, created_by, created_at) VALUES (?,?,?,?)');
  insCamp.run(1, '十月新品速递', 1, now);
  const insCG = db.prepare('INSERT OR IGNORE INTO campaign_groups (campaign_id, group_id, name, created_at) VALUES (?,?,?,?)');
  insCG.run(1, 1, 'growth', now);
  insCG.run(1, 2, 'billing', now);

  const existing = db.prepare('SELECT MAX(version) v FROM audiences WHERE name=?').get('十月名单');
  if (!existing.v) {
    const info = db.prepare('INSERT INTO audiences (name, version, created_by, created_at, size) VALUES (?,?,?,?,?)')
      .run('十月名单', 1, 1, now, 4);
    const aid = info.lastInsertRowid;
    const members = [
      ['zhang@example.test', '张伟', { city: '上海' }],
      ['li@example.test', '李娜', { city: '北京' }],
      ['wang@example.test', '王芳 <script>', { city: '深圳' }], // 含需转义字符
      ['zhao@example.test', '赵强', { city: '杭州' }],
    ];
    const insM = db.prepare('INSERT INTO audience_members (audience_id, email, name, vars_json) VALUES (?,?,?,?)');
    for (const [email, name, vars] of members) insM.run(aid, email, name, JSON.stringify(vars));
  }
}
