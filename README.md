# Pix 协议支付平台

巴西 Pix 协议支付 Web 平台，支持三种角色：管理员、工人、客户。

**客户**输入兑换码 + ChatGPT Session → 后端自动生成巴西 Pix 二维码 → **工人**扫码付款并标记完成 → **管理员**管理兑换码、工人和查看数据看板。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React + Vite + TailwindCSS + Recharts |
| 后端 | Express + TypeScript + Socket.io |
| 数据库 | PostgreSQL + Prisma ORM |
| 认证 | JWT + bcrypt |
| 实时通信 | Socket.io (WebSocket) |

## 项目结构

```
packages/
├── core/       # Stripe Pix 协议核心模块（可独立使用）
├── server/     # Express 后端 API + WebSocket
└── web/        # React 前端
```

## 部署教程

### 环境要求

- Node.js >= 20.18.1
- PostgreSQL >= 14
- npm >= 9

### 1. 克隆仓库

```bash
git clone https://github.com/1134189025/xieyi.git
cd xieyi
```

### 2. 安装依赖

```bash
npm install
```

### 3. 准备 PostgreSQL 数据库

**方式一：Docker（推荐）**

```bash
docker run -d \
  --name pix-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=pix_payment \
  -p 5432:5432 \
  postgres:16
```

**方式二：本地 PostgreSQL**

创建数据库：

```sql
CREATE DATABASE pix_payment;
```

### 4. 配置环境变量

```bash
cp packages/server/.env.example packages/server/.env
```

编辑 `packages/server/.env`：

```env
# 数据库连接（根据实际情况修改用户名密码）
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pix_payment

# JWT 密钥（务必改成随机字符串）
JWT_SECRET=REPLACE_WITH_RANDOM_32_PLUS_CHAR_SECRET

# Session 加密密钥（64位 hex 字符串）
SESSION_ENCRYPTION_KEY=REPLACE_WITH_64_HEX_CHAR_KEY

# 管理员初始账号（首次启动自动创建）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=REPLACE_WITH_STRONG_ADMIN_PASSWORD

# 服务端口
PORT=3000

# 前端地址（CORS 用）
CORS_ORIGIN=http://localhost:5173
```

> 生成随机密钥：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。`SESSION_ENCRYPTION_KEY` 必须是 64 位 hex；`JWT_SECRET` 和 `ADMIN_PASSWORD` 必须替换为非占位、非默认的强随机值，否则服务端会拒绝启动。

### 5. 初始化数据库

```bash
cd packages/server
npx prisma migrate dev --name init
```

### 6. 启动服务

**开发模式（两个终端）：**

```bash
# 终端 1：启动后端
cd packages/server
npm run dev

# 终端 2：启动前端
cd packages/web
npm run dev
```

访问 `http://localhost:5173`，管理员用 `.env` 中配置的账号登录。

**生产模式：**

```bash
# 构建前端
cd packages/web
npm run build

# 启动后端（将前端静态文件交给 nginx 或后端托管）
cd packages/server
npm run start
```

### 7. 生产环境部署（Linux 服务器）

```bash
# 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 PostgreSQL
sudo apt-get install -y postgresql
sudo -u postgres createdb pix_payment

# 克隆并安装
git clone https://github.com/1134189025/xieyi.git
cd xieyi
npm install

# 配置环境变量
cp packages/server/.env.example packages/server/.env
nano packages/server/.env  # 编辑配置

# 初始化数据库
cd packages/server
npx prisma migrate dev --name init

# 构建前端
cd ../web
npm run build

# 使用 pm2 管理后端进程
npm install -g pm2
cd ../server
pm2 start "npx tsx src/index.ts" --name pix-server
pm2 save
pm2 startup
```

**Nginx 反向代理配置（可选）：**

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 前端静态文件
    location / {
        root /path/to/xieyi/packages/web/dist;
        try_files $uri $uri/ /index.html;
    }

    # 后端 API
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## 使用流程

### 管理员

1. 登录后台 → 进入「兑换码」页面 → 批量生成兑换码
2. 进入「工人管理」→ 创建工人账号
3. 在「看板」查看订单统计和工人绩效

### 客户

1. 访问首页，输入兑换码 + ChatGPT Session（accessToken 或 session cookie）
2. 系统自动生成 Pix 二维码
3. 页面实时显示订单状态，完成后自动更新

### 工人

1. 登录后台 → 看到待处理订单和 Pix 二维码
2. 用手机扫码完成 Pix 支付
3. 点击「标记已完成」

## 核心流程

```
客户提交兑换码 + Session
        ↓
后端验证兑换码 → 提取 accessToken
        ↓
调用 ChatGPT Checkout API → 生成巴西 Stripe 长链接
        ↓
调用 Stripe 协议支付 → 生成 Pix 二维码
        ↓
工人领取订单 → 扫码或复制 Pix 付款码 → 自动检测或手动标记完成 → WebSocket 实时通知客户
```

## API 端点

| Method | Path | 说明 | 认证 |
|--------|------|------|------|
| POST | /api/auth/login | 登录 | 无 |
| POST | /api/orders | 客户提交订单 | 无 |
| GET | /api/orders/track/:token | 查询订单状态 | 无 |
| GET | /api/worker/orders | 未领取和当前工人已领取的待支付订单 | Worker/Admin |
| GET | /api/worker/summary | 当前工人今日完成数 | Worker/Admin |
| POST | /api/worker/orders/:id/claim | 领取订单 | Worker/Admin |
| POST | /api/worker/orders/:id/complete | 标记已领取订单完成 | Worker/Admin |
| POST | /api/admin/redemption-codes | 批量生成兑换码 | Admin |
| GET | /api/admin/redemption-codes | 兑换码列表 | Admin |
| POST | /api/admin/workers | 创建工人 | Admin |
| GET | /api/admin/workers | 工人列表 | Admin |
| GET | /api/admin/orders | 所有订单 | Admin |
| GET | /api/admin/dashboard | 统计数据 | Admin |

## CLI 工具（独立使用）

原有的 CLI 工具仍可独立使用：

```bash
# 从 HAR 提取 Pix 支付数据
npx tsx packages/core/cli.ts from-har --har <har-file> --out ./output

# 纯 HTTP 协议支付
npx tsx packages/core/cli.ts direct --checkout-url <url> --out ./output
```

## 注意事项

- `direct` 模式可能因 Stripe 风控字段缺失而失败，后端会将此类订单标记为 FAILED
- ChatGPT Session 数据在后端使用 AES-256-GCM 加密存储，Pix 生成成功后自动清除
- 客户提交订单接口有限流保护（5 次/分钟/IP）
- Pix 二维码过期后订单自动标记为 EXPIRED
