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

## 开发启动

需要三个进程：

```bash
# 终端 1：API + WebSocket
npm --workspace @pix/server run dev

# 终端 2：Pix 生成 worker
npm --workspace @pix/server run start:worker

# 终端 3：前端
npm --workspace @pix/web run dev
```

访问 `http://localhost:5173`。

## 生产 PM2

API 和 worker 必须分开管理，避免 API 扩容时重复承担生成任务。

```bash
npm install -g pm2

pm2 start "npm --workspace @pix/server run start" --name pix-api
pm2 start "npm --workspace @pix/server run start:worker" --name pix-worker

pm2 save
pm2 startup
```

调整吞吐时优先调 `PIX_WORKER_CONCURRENCY` 和 worker 进程数；客户提交高峰不会直接失败，合法订单会留在队列等待。

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

## API 摘要

| Method | Path | 说明 | 认证 |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | 登录 | 无 |
| POST | `/api/orders` | 创建排队订单，返回追踪 token | 无 |
| GET | `/api/orders/track/:token` | 查询订单与排队估算 | 无 |
| GET | `/api/worker/orders` | 全部待支付订单 | Worker/Admin |
| GET | `/api/worker/summary` | 总体/今日/本周完成数 | Worker/Admin |
| POST | `/api/worker/orders/:id/complete` | 标记待支付订单完成 | Worker/Admin |
| GET | `/api/admin/dashboard` | 看板统计和队列指标 | Admin |
| GET/PUT | `/api/admin/settings/proxy` | ChatGPT/Stripe 代理池 | Admin |
| GET/PUT | `/api/admin/settings/maintenance-mode` | 维护模式 | Admin |
| GET/PUT | `/api/admin/settings/auto-payment-detection` | 自动检测开关 | Admin |
