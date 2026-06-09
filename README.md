# Pix 协议支付平台

这是一个 Pix 协议支付 Web 平台，包含客户提交页、工人处理页和管理员后台。

核心流程：

1. 客户提交兑换码和 ChatGPT Session。
2. API 原子预占兑换码并创建 `CREATING_PAYMENT` 订单。
3. API 把 Pix 生成任务投递到 Redis + BullMQ 队列，并立即返回追踪链接。
4. 独立 worker 进程按并发配置生成 ChatGPT checkout 和 Stripe Pix。
5. 生成成功后订单变为 `PENDING_PAYMENT`，工人页显示二维码或 Pix 付款码。
6. 工人手动标记完成，或自动检测 Stripe SetupIntent 成功后，订单变为 `PAYMENT_COMPLETED`。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React + Vite + TailwindCSS + Recharts |
| 后端 | Express + TypeScript + Socket.io |
| 队列 | Redis + BullMQ |
| 数据库 | PostgreSQL + Prisma ORM |
| 认证 | JWT + bcrypt |

## 环境要求

- Node.js >= 20.18.1
- PostgreSQL >= 14
- Redis >= 6
- npm >= 9

## 安装

```bash
npm install
```

## 环境变量

`packages/server/.env` 至少需要：

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pix_payment
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=REPLACE_WITH_RANDOM_32_PLUS_CHAR_SECRET
SESSION_ENCRYPTION_KEY=REPLACE_WITH_64_HEX_CHAR_KEY
ADMIN_USERNAME=admin
ADMIN_PASSWORD=REPLACE_WITH_STRONG_ADMIN_PASSWORD
PORT=3000
CORS_ORIGIN=http://localhost:5173

# 客户提交限流，只限制同 IP 提交速度，不控制 Pix 生成并发
CREATE_ORDER_RATE_LIMIT_PER_MIN=30

# 后台 Pix 生成 worker 并发
PIX_WORKER_CONCURRENCY=5

# API 维护循环：过期本地 Pix、检测 Stripe/外包支付终态。多 API 实例部署时只保留一个实例为 true
ENABLE_PAYMENT_MAINTENANCE=true
```

生成 64 位 hex 密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 数据库

```bash
cd packages/server
npx prisma migrate dev
npm run db:generate
```

生产部署不要使用 `migrate dev`，应在完成构建和配置检查后执行：

```bash
cd packages/server
npx prisma migrate deploy
npm run db:generate
```

## 开发启动

需要三个进程：

```bash
# 终端 1：API + WebSocket
npm --workspace @pix/server run dev

# 终端 2：Pix 生成 worker
npm --workspace @pix/server run dev:worker

# 终端 3：前端
npm --workspace @pix/web run dev
```

访问 `http://localhost:5173`。

## 生产 PM2

API 和 worker 必须分开管理，避免 API 扩容时重复承担生成任务。

```bash
npm install -g pm2
npm install
npm run build
npx prisma migrate deploy --schema packages/server/prisma/schema.prisma
npm --workspace @pix/server run db:generate

pm2 start "npm --workspace @pix/server run start" --name pix-api
pm2 start "npm --workspace @pix/server run start:worker" --name pix-worker

pm2 save
pm2 startup
```

调整吞吐时优先调 `PIX_WORKER_CONCURRENCY` 和 worker 进程数；客户提交高峰不会直接失败，合法订单会留在队列等待。API 多实例部署时，只有一个实例应设置 `ENABLE_PAYMENT_MAINTENANCE=true`，其余 API 实例设为 `false`，避免重复扫描支付状态。

## Nginx 真实 IP

后端启用了 `app.set('trust proxy', 1)`，限流按真实客户端 IP 计算。Nginx 需要传递真实 IP：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /socket.io/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## 排队策略

- `POST /api/orders` 正常返回 `202` 和 `trackingToken`。
- 并发满时任务保持在 BullMQ `waiting` 或 `delayed`，不会因为队列积压拒单。
- 只有管理员开启维护模式时，新订单才会被拒绝，且不会占用兑换码。
- 生成失败后订单变为 `FAILED`，兑换码会释放复用，追踪页只显示安全错误提示。
- 工人页只显示 `PENDING_PAYMENT` 订单，不显示排队生成中的订单。

## 代理池维护

后台系统设置包含：

- `ChatGPT 代理池`：用于 Session 解析和 ChatGPT checkout 请求。
- `Stripe 代理池`：用于 Stripe Pix 三步请求和自动检测 SetupIntent。
- `维护模式`：手动拒绝新订单，适合停机维护或代理池全不可用时使用。
- `自动检测支付完成`：开启后后端定时扫描 Stripe 状态。

代理格式为每行一个：

```text
host:port:username:password
```

代理失败规则：

- 超时、网络错误、408、429、5xx 会计入失败。
- 无效 Session、账号无资格、兑换码错误不惩罚代理。
- 单代理连续失败 3 次后冷却 10 分钟。
- job 重试时会重新选择健康代理。
- 日志只记录订单 id、阶段、代理脱敏标识、错误码和耗时，不应记录 Session、Pix code、client secret 或代理密码。

## 管理指标

Dashboard 显示：

- 总已完成、今日已完成、本周已完成。
- 队列等待数、处理中数、失败任务数。
- 最老等待时间、平均生成耗时、近 1 小时成功率。
- ChatGPT 和 Stripe 代理池健康数量。

## 常用命令

```bash
npm --workspace @pix/server run db:generate
npm --workspace @pix/server run test
npm --workspace @pix/server run typecheck
npm --workspace @pix/web run test
npm --workspace @pix/web run typecheck
npm --workspace @pix/web run build
git diff --check
```

## 生产冒烟检查

仓库提供 `npm run smoke:prod` 用于上线后快速检查运行中的 API。默认只执行只读检查：

- `/api/health`
- `/api/ready`
- 管理员登录

生产环境建议显式设置目标地址和管理员账号：

```bash
PIX_BASE_URL=https://your-domain.example
PIX_ADMIN_USERNAME=admin
PIX_ADMIN_PASSWORD=your-admin-password
npm run smoke:prod
```

也兼容使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。`PIX_BASE_URL` 未设置时默认检查 `http://127.0.0.1:3000`。默认不会创建订单或删除任何兑换码。

需要验证写入链路时再显式打开开关：

```bash
# 生成 2 个本地兑换码，创建 1 个公开订单，并按本次 smoke 批次删除未使用码
PIX_SMOKE_WRITE=1 npm run smoke:prod

# 额外导入 2 个外包测试码、列出并按本次 smoke 批次删除未使用外包码
PIX_SMOKE_WRITE=1 PIX_SMOKE_OUTSOURCED=1 npm run smoke:prod
```

外包写入检查必须同时设置 `PIX_SMOKE_WRITE=1`，单独设置 `PIX_SMOKE_OUTSOURCED=1` 会被脚本拒绝。写入检查会使用 `smoke-<时间戳>` 批次标签，并且删除接口只按本次批次清理未使用码；不要在生产库手动复用这个批次标签。

## 真实小流量端到端验证

仓库还提供 `npm run smoke:e2e` 用于受控 staging/小流量环境。这个脚本会创建真实测试订单，并等待 Pix worker、ChatGPT/Stripe 和可选外包买家 API 链路返回业务状态；它不是普通健康检查。

脚本默认拒绝执行，必须同时确认写入和真实外部请求风险：

```bash
PIX_BASE_URL=https://your-staging.example
PIX_ADMIN_USERNAME=admin
PIX_ADMIN_PASSWORD=your-admin-password
PIX_E2E_WRITE=1
PIX_E2E_ACK_RISK=I_UNDERSTAND_REAL_EXTERNAL_REQUESTS
PIX_E2E_SESSION='real ChatGPT accessToken or session JSON'
PIX_E2E_MODE=local
npm run smoke:e2e
```

`PIX_E2E_MODE=local` 会验证：创建本地兑换码、提交真实订单、等待 Pix 生成到 `PENDING_PAYMENT`、用管理员身份调用工人批量领取接口并确认能拿到 Pix 载荷。默认不会自动把订单标记完成；只有显式设置 `PIX_E2E_LOCAL_COMPLETE=1` 才会调用工人完成接口，这一步属于人工付款完成模拟，不代表 Stripe 真实付款。

`PIX_E2E_MODE=outsourced` 会验证：导入外包兑换码（可选但推荐设置 `PIX_E2E_OUTSOURCED_CODE`）、创建真实订单、等待 Pix 生成并提交到外包买家端 API，然后轮询公开追踪接口直到 `PAYMENT_COMPLETED` 或 `FAILED`。如果当前后台付款处理方式和 `PIX_E2E_MODE` 不一致，脚本默认拒绝切换；只有在受控环境显式设置 `PIX_E2E_ALLOW_SETTING_UPDATE=1` 才会更新后台付款处理方式。

可选参数：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PIX_E2E_MODE` | `local` | `local` 或 `outsourced` |
| `PIX_E2E_TIMEOUT_MS` | `600000` | 等待订单到达目标状态的最长时间 |
| `PIX_E2E_POLL_MS` | `5000` | 轮询公开追踪接口的间隔 |
| `PIX_E2E_OUTSOURCED_CODE` | 无 | 外包模式下导入到本次批次的真实外包兑换码 |
| `PIX_E2E_ALLOW_SETTING_UPDATE` | `0` | 是否允许脚本切换后台付款处理方式 |
| `PIX_E2E_LOCAL_COMPLETE` | `0` | 本地模式下是否调用工人完成接口 |

## API 摘要

| Method | Path | 说明 | 认证 |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | 登录 | 无 |
| POST | `/api/orders` | 创建排队订单，返回追踪 token | 无 |
| GET | `/api/orders/track/:token` | 查询订单与排队估算 | 无 |
| GET | `/api/worker/orders/mine` | 当前工人已领取任务 | Worker/Admin |
| GET | `/api/worker/orders/available` | 当前可领取任务 | Worker/Admin |
| POST | `/api/worker/orders/claim-batch` | 批量领取最多 10 单 | Worker/Admin |
| POST | `/api/worker/orders/:id/renew` | 续租已领取任务 | Worker/Admin |
| POST | `/api/worker/orders/:id/release` | 释放已领取任务 | Worker/Admin |
| GET | `/api/worker/summary` | 总体/今日/本周完成数 | Worker/Admin |
| POST | `/api/worker/orders/:id/complete` | 标记待支付订单完成 | Worker/Admin |
| GET | `/api/admin/dashboard` | 看板统计和队列指标 | Admin |
| GET/PUT | `/api/admin/settings/proxy` | ChatGPT/Stripe 代理池 | Admin |
| GET/PUT | `/api/admin/settings/maintenance-mode` | 维护模式 | Admin |
| GET/PUT | `/api/admin/settings/auto-payment-detection` | 自动检测开关 | Admin |
