# 邮件活动编辑台

一个从空目录搭建的全栈邮件活动工作台：Vue 3 负责模块编辑、浅/深色和客户端能力预览；Node.js 后端在独立渲染进程中发布和渲染模板；文件型关系库存放受众版本、退订记录和候选发送批；本地 SMTP 模拟器用于验收幂等投递、重投和回执。

## 快速启动

```bash
npm install
npm run dev:mail   # 终端 1：本地 SMTP 接收模拟器，默认 127.0.0.1:2525
npm run dev:api    # 终端 2：API，http://127.0.0.1:3000
npm run dev:web    # 终端 3：Vite，http://127.0.0.1:5173
```

持续领取任务：

```bash
SEND_LOOP=1 npm run dev:api
```

也可以在界面点击“领取并重投”，或调用：

```bash
curl -X POST http://127.0.0.1:3000/api/batches/process?limit=20
```

## 测试

```bash
npm test
npm run build
```

测试会启动临时 API、临时关系库和随机端口 SMTP 模拟器，不需要外部服务。当前覆盖：

- 深色低对比和无退订入口阻断发布；
- 分组越权读取与发送；
- HTML/URL 上下文个性化转义；
- 退订链接保护，不被短链/跟踪参数流程删除或改写；
- 整批快照漂移和逐收件人订阅状态复查；
- 领取任务后确认退订的竞态；
- SMTP 最终响应丢失后的稳定 Message-ID 重投与重复识别；
- 渲染子进程退出、自动重启、失败重试和最终回执；
- 前端三态：已准备、已尝试投递、已确认回执；
- 日志不输出主题、预览、正文、邮箱等个性化正文。

## 数据模型

关系结构定义在 `backend/db/schema.js`，事务实现位于 `backend/db/relational.js`。默认数据文件为 `data/campaigns.json`，可通过 `CAMPAIGN_DB` 覆盖。

- `groups`：调用方分组和允许访问的分组；
- `audience_members`：成员当前订阅状态；
- `audience_versions`：不可变受众快照、人数和 checksum；
- `campaigns` / `campaign_versions`：活动及固定发布版；
- `send_batches`：候选批、模板版本、受众版本、快照 checksum 和批状态；
- `recipient_tasks`：逐收件人快照、状态、尝试次数、稳定 Message-ID、下次重试时间；
- `delivery_attempts`：每次渲染/SMTP 尝试的阶段和结果；
- `unsubscribe_records`：退订 token 哈希和确认时间。

> 本环境的原生 SQLite 包无法在当前 arm64/Node 组合中完成编译，因此实现了带表结构、外键和原子 rename 持久化的文件型关系存储；schema 可直接映射到 SQLite/PostgreSQL。

## 发布版固定内容

`POST /api/campaigns/:id/publish` 在独立渲染进程中复查并冻结：

- 主题；
- 预览文案；
- 正文 HTML；
- tracking base 与 tracking 参数；
- 校验报告；
- canonical payload 和 checksum。

候选批只引用 `campaign_version_id` 与 `audience_version_id`，发送时不会读取草稿，避免发布后内容漂移。

## 模板和链接安全

渲染逻辑位于 `backend/templates/render.js` 与 `backend/templates/links.js`：

- HTML 文本占位符按 HTML 上下文转义；
- `href` 占位符按 URL 组件转义，再解析绝对 URL；
- 禁止 `javascript:`、`data:`、`vbscript:`、`file:`、脚本标签、iframe/object 和内联事件；
- 普通 http/https 链接才追加发布版 tracking 参数；
- `rel="unsubscribe"`、`data-unsubscribe="true"` 或 `data-no-shortlink="true"` 的退订锚点保持原 URL，不追加 tracking；
- 退订 https 链接必须带 `unsubscribe_token`，也支持 mailto；
- 深色模式检查显式背景和 WCAG AA 4.5:1 对比度，并展示 Gmail/Apple Mail/Outlook 能力差异。

## 订阅竞态和双层校验

1. 建批前：发布版模板必须通过校验，并固化合格受众版本；
2. 领取任务时：重新读取成员当前状态和确认退订表；
3. 真正渲染/发送前：再做一次逐收件人复查。

因此“领取后、发送前确认退订”的任务会变为 `skipped_after_claim`，不会进入 SMTP。

## 幂等投递和重试

每个任务根据 `batch_id + task_id + CAMPAIGN_SECRET` 生成稳定 Message-ID。

- 未发送：`prepared`（已准备）；
- 已发送但没有最终 SMTP 响应：`attempted_delivery`（已尝试投递）；
- 收到最终 250：`confirmed_receipt`（已确认回执）；
- `RESPONSE_LOST`、SMTP 4xx、传输错误、渲染器崩溃为可重试；
- 重投使用同一 Message-ID，模拟器识别重复并返回幂等 250；
- 超过最大尝试次数后进入 `failed_retry_exhausted`。

## 本地邮件接收模拟器

`backend/mail/smtp-simulator.js` 是极简 ESMTP 接收器：

- 保存 envelope、Message-ID、原始邮件、确认状态和重复次数；
- 第一次遇到 `X-Sim-Fail: response-lost` 时保存邮件后断开连接；
- 同一 Message-ID 重投时返回“duplicate idempotent accepted”；
- 可通过 `MAIL_OUTBOX` 写入不含原始正文的摘要文件。

测试使用内存 outbox，避免把个性化正文落盘。

## API 摘要

- `GET /api/groups`
- `POST /api/seed`
- `POST /api/groups/:id/members`
- `POST /api/groups/:id/audience-versions`
- `POST /api/campaigns`
- `POST /api/campaigns/:id/publish`
- `GET /api/campaigns/:id/versions`
- `POST /api/templates/validate`
- `POST /api/batches`
- `GET /api/batches` / `GET /api/batches/:id`
- `POST /api/batches/process?taskId=...&limit=...`
- `GET|POST /unsubscribe/:token`

写操作通过 `x-group-id` 表示调用分组。

## 日志策略

结构化日志只记录 ID、阶段、错误码和计数。`backend/security/redact.js` 会隐藏 subject、preview、body/html、email、recipient、content、personal、name 等字段；退订 URL 在路径日志中被替换为 `[redacted-token]`。SMTP 原始正文只保存在模拟器内存，生产日志不会打印渲染结果。
