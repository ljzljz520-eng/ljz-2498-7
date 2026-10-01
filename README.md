# 邮件活动编辑台（Mail Campaign Workbench）

从空项目搭建的端到端邮件营销系统：Vue 模块编辑器（浅/深色 + 客户端能力差异预览）、
独立渲染子进程（崩溃自动重启）、关系库存放受众版本/退订记录/候选发送批、
整批快照 + 逐收件人领取复查、幂等投递与失败重试，本地 SMTP 接收模拟器验收。

## 架构

```
client/                 Vue 3 + Vite（编辑器、预览、批次台、日志）
  src/components/
    TemplateEditor.vue  模块编辑器 + 浅/深色 & 高/低能力客户端预览 + 校验/发布
    Audiences.vue       受众不可变版本导入 + 退订登记
    Batches.vue         候选批、快照对比、发送；prepared/attempted/confirmed 三态徽标
    Logs.vue            投递事件时间线（不含个性化正文）
server/src/
  db.js                 关系模式（audiences/audience_members/unsubscribes/
                        template_versions/send_batches/recipients/links/
                        delivery_receipts/delivery_log/groups...）
  sqlite-wasm.js        sql.js(WASM) 的 better-sqlite3 风格同步封装（免原生编译）
  mail-template.js      上下文转义、模板校验、深色可读性、链接白名单、短链改写
  render-worker.js      渲染/校验子进程（可被杀死以模拟渲染进程退出）
  render-pool.js        进程池：崩溃监控、自动重启、任务换进程重试
  smtp-client.js        极简 SMTP 客户端（点填充、4xx/5xx/无应答分类、close 处理）
  smtp-simulator.js     本地接收模拟器：SMTP(2525)+控制HTTP(2526)，
                        故障注入 tempfail/drop_response/close/hold，按 Message-ID 去重
  delivery.js           整批快照、抢占式领取+复查、幂等回执、重试 pump、竞态对账
  server.js             HTTP API + 静态资源托管
  seed.js               演示数据（用户/分组/示例活动/受众）
```

## 关键设计

- **发布冻结**：主题、预览文案、正文 HTML、跟踪参数作为同一行 `template_versions`
  不可变快照；候选批引用固定的模板发布版 + 受众版本。
- **个性化转义**：`{{name}}` 默认 HTML 上下文转义，`{{x|u}}` URL 转义；
  `{{{raw}}}` 仅对白名单系统变量（`unsubscribe_url` 等）放行，其余原样保留。
- **退订链接保护**：锚点带 `data-no-rewrite` 或 href 命中退订特征时，短链改写完全跳过；
  改写后再做一次“退订 href 仍存在”的完整性断言；退订 URL 永不进入 `links` 表。
- **两道退订闸**：
  1. *整批快照*：批次 ready 时冻结每位收件人订阅指纹，已退订者直接 suppressed，
     之后可用 `/diff` 对比发送前是否漂移；
  2. *领取复查*：pump 抢占式领取每个任务的事务里再查一次 `unsubscribes`，
     覆盖“快照后、领取前”退订；重试重新领取 attempted 任务时同样复查。
- **确认后退订竞态**：应答返回前若已退订，消息既已在 MTA 落地则不撤回，
  收件人保留 `confirmed` 并记录 `unsubscribed_after_confirm`（可在日志页看到）。
- **幂等投递**：Message-ID 由 `batchToken-recipientId` 确定；`delivery_receipts`
  对 Message-ID 唯一；模拟器对重投去重，应答丢失重投只产生一封。
- **重试**：4xx / 连接关闭 / 超时 → 保留 `attempted`，由 pump 按 attempts 上限重试，
  耗尽置 `failed`，批次以 `done_with_failures` 收尾。
- **三态可观察**：`prepared`（已构造、已分配 Message-ID）→ `attempted`（已连接并发出）
  → `confirmed`（收到 2xx 回执，回执落库）。
- **渲染隔离**：校验/渲染在 forked 子进程中执行；进程异常退出时池自动重启并把任务
  交给新进程重试，编辑器“校验（模拟渲染进程退出）”按钮可一键验证。
- **日志不泄露正文**：`delivery_log` 只记录事件类型、邮箱、SMTP 状态码，
  不含变量值与渲染 HTML；模拟器收件箱列表同样不回传正文，只给布尔安全标记。
- **分组授权**：用户属于全局分组，活动挂载分组；建批/ready/send 均校验成员关系，
  非 admin 跨组返回 403。

## 运行

```bash
npm install
(cd client && npm install)

# 方式一：一键开发（模拟器 2525 / 控制 2526 / API 5174 / Vite 5173）
npm run dev
# 打开 http://localhost:5173

# 方式二：生产式（构建后由 API 托管）
(cd client && npm run build)
npm run simulator   # SMTP 2525 + 控制 2526
npm start           # http://localhost:5174
```

模拟器控制：`GET/POST/DELETE http://localhost:2526/{messages,faults,holds}/...`

## 验收（测试）

```bash
npm test
```

19 个测试（8 单元 + 11 端到端，每个 E2E 使用独立临时数据目录与端口），覆盖：

| 需求 | 测试 |
| --- | --- |
| 深色不可读 | `dark_unreadable` 阻止发布 |
| 无退订入口 | `no_unsubscribe` / `unsubscribe_hidden` 阻止发布 |
| 分组越权 | 非组员建批 403，admin 放行 |
| 响应丢失后重投 | `drop_response` 后重试，Message-ID 去重，仅一封 |
| 451 临时失败 | 自动重试成功 |
| 渲染进程退出 | 子进程崩溃 → 池重启 → 校验仍成功 |
| 确认后退订竞态 | hold 挂起回执 → 退订 → 放行，confirmed 保留且有事件 |
| 领取时复查 | ready 后退订，领取瞬间 suppressed，不发信，快照 diff 可查 |
| 三态 | prepared/attempted/confirmed 事件齐全 |
| 日志安全 | 日志不含个性化值与正文 |
| 短链/退订保护 | 普通链接 302 并带冻结跟踪参数，退订从不入短链表 |

前端左上可切换用户（Alice=growth / Bob=billing / Admin）以演示分组越权；
“受众版本”页可手工登记退订以复现发送中竞态。
