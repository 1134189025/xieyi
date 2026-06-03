# API 接口文档

更新时间：2026-06-02

本文档基于当前项目源码整理，服务端入口为 `packages/server/src/index.ts`，路由集中在 `packages/server/src/routes`，实时通知在 `packages/server/src/ws/index.ts`。

## 1. 基础约定

| 项目 | 说明 |
| --- | --- |
| API 前缀 | `/api` |
| 请求格式 | JSON |
| 请求头 | `Content-Type: application/json` |
| 鉴权方式 | `Authorization: Bearer <token>` |
| Token 来源 | `POST /api/auth/login` |
| 公开接口 | `/api/health`、`/api/auth/login`、`/api/orders`、`/api/orders/track/:trackingToken` |
| Worker/Admin 接口 | 需要 Bearer Token |
| WebSocket | Socket.IO，命名空间为 `/orders`、`/worker`、`/admin`，不带 `/api` 前缀 |

### 1.1 通用错误响应

```json
{
  "error": "错误描述",
  "code": "ERROR_CODE"
}
```

说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `error` | string | 错误描述 |
| `code` | string/null | 业务错误码，部分错误可能没有该字段 |

常见 HTTP 状态：

| HTTP 状态 | 含义 |
| --- | --- |
| `400` | 请求参数不合法 |
| `401` | 未登录、Token 无效或已过期 |
| `403` | 权限不足 |
| `404` | 资源不存在 |
| `409` | 状态冲突，例如订单不能完成或取消 |
| `429` | 请求过于频繁 |
| `500` | 服务端未处理异常 |
| `502` | 上游支付或队列处理失败 |
| `503` | 系统维护或暂无可用资源 |

### 1.2 订单状态

| 状态 | 含义 | 是否最终状态 |
| --- | --- | --- |
| `CREATING_PAYMENT` | 订单已创建，正在排队生成支付信息 | 否 |
| `PENDING_PAYMENT` | 支付信息已生成，等待支付完成 | 否 |
| `PAYMENT_COMPLETED` | 支付已完成 | 是 |
| `FAILED` | 支付生成或上游流程失败 | 是 |
| `EXPIRED` | 支付超时过期 | 是 |
| `CANCELLED` | 订单被管理员取消 | 是 |

### 1.3 鉴权和角色

| 角色 | 可访问范围 |
| --- | --- |
| 未登录 | 健康检查、登录、创建订单、查询自己的追踪订单 |
| `WORKER` | Worker 订单队列、完成订单、Worker 实时通知 |
| `ADMIN` | 所有 Worker 接口、管理端订单、兑换码、工人账号、系统设置、管理端实时通知 |

## 2. 健康检查

### GET `/api/health`

检查服务是否可用。

请求：

```bash
curl http://localhost:3000/api/health
```

响应：

```json
{
  "status": "ok",
  "timestamp": "2026-06-02T00:00:00.000Z"
}
```

## 3. 登录接口

### POST `/api/auth/login`

用户登录，返回 JWT Token 和用户信息。

权限：无。

请求体：

| 字段 | 类型 | 必填 | 规则 | 说明 |
| --- | --- | --- | --- | --- |
| `username` | string | 是 | 1 到 50 字符 | 用户名 |
| `password` | string | 是 | 1 到 200 字符 | 密码 |

请求示例：

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"your-password\"}"
```

成功响应：

```json
{
  "token": "jwt-token",
  "user": {
    "id": "user-id",
    "username": "admin",
    "role": "ADMIN",
    "displayName": "Administrator"
  }
}
```

失败响应：

| HTTP 状态 | 说明 |
| --- | --- |
| `400` | 参数不合法 |
| `401` | 用户名或密码错误 |
| `429` | 登录尝试过多 |

### GET `/api/auth/me`

获取当前登录用户信息。

权限：已登录用户。

请求示例：

```bash
curl http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer <token>"
```

成功响应：

```json
{
  "user": {
    "id": "user-id",
    "username": "admin",
    "role": "ADMIN",
    "displayName": "Administrator"
  }
}
```

## 4. 公开订单接口

### POST `/api/orders`

提交兑换码和 ChatGPT session，创建排队订单。

权限：无。

注意：

| 项目 | 说明 |
| --- | --- |
| 返回 `202` | 表示订单已接收并进入生成支付流程，不代表最终支付成功 |
| 最终成功 | 需要后续查询到 `PAYMENT_COMPLETED`，或通过 Socket.IO 收到完成事件 |
| 限流 | 创建订单接口受 `CREATE_ORDER_RATE_LIMIT_PER_MIN` 控制，默认配置为每分钟 30 次 |

请求体：

| 字段 | 类型 | 必填 | 规则 | 说明 |
| --- | --- | --- | --- | --- |
| `redemptionCode` | string | 是 | 1 到 20 字符，自动 trim | 兑换码 |
| `session` | string | 是 | 10 到 10000 字符，自动 trim | ChatGPT session/access token 数据 |

请求示例：

```bash
curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d "{\"redemptionCode\":\"ABCD-2345\",\"session\":\"your-session-value\"}"
```

成功响应：`202 Accepted`

```json
{
  "trackingToken": "tracking-token",
  "status": "CREATING_PAYMENT",
  "pixCode": null,
  "pixQrPngBase64": null,
  "pixExpiresAt": null,
  "pixImageUrl": null,
  "completedAt": null,
  "createdAt": "2026-06-02T00:00:00.000Z",
  "errorMessage": null,
  "queueEstimate": {
    "ordersAhead": 0,
    "position": 1,
    "pendingTotal": 1,
    "estimatedQueueSeconds": 0,
    "secondsPerOrder": 300,
    "calculationSource": "generation_queue",
    "calculatedAt": "2026-06-02T00:00:00.000Z",
    "currentGenerationCount": 0
  }
}
```

常见失败：

| HTTP 状态 | `code` | 说明 |
| --- | --- | --- |
| `400` | `INVALID_CODE` | 兑换码不存在 |
| `400` | `CODE_USED` | 兑换码已使用 |
| `400` | 空或未返回 | 请求参数不合法 |
| `409` | `ORDER_CREATE_BUSY` | 订单创建繁忙 |
| `429` | 空或未返回 | 请求频率超过限制 |
| `502` | `ORDER_QUEUE_UNAVAILABLE` | 订单排队失败 |
| `502` | `PAYMENT_FAILED` | 支付创建失败 |
| `503` | `MAINTENANCE_MODE` | 系统维护中 |

### GET `/api/orders/track/:trackingToken`

根据追踪 token 查询订单状态。

权限：无。

路径参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `trackingToken` | string | 创建订单时返回的追踪 token |

请求示例：

```bash
curl http://localhost:3000/api/orders/track/tracking-token
```

成功响应：

```json
{
  "trackingToken": "tracking-token",
  "status": "PENDING_PAYMENT",
  "pixCode": "000201...",
  "pixQrPngBase64": "base64-png",
  "pixExpiresAt": "2026-06-02T00:30:00.000Z",
  "pixImageUrl": "https://example.com/pix.png",
  "completedAt": null,
  "createdAt": "2026-06-02T00:00:00.000Z",
  "errorMessage": null,
  "queueEstimate": {
    "ordersAhead": 0,
    "position": 1,
    "pendingTotal": 1,
    "estimatedQueueSeconds": 0,
    "secondsPerOrder": 300,
    "calculationSource": "default",
    "calculatedAt": "2026-06-02T00:00:05.000Z"
  }
}
```

失败响应：

| HTTP 状态 | 说明 |
| --- | --- |
| `404` | 订单不存在 |

## 5. Worker 接口

Worker 接口统一需要 `WORKER` 或 `ADMIN` 权限。

### GET `/api/worker/orders`

查询待支付订单队列。

权限：`WORKER`、`ADMIN`。

查询参数：

| 参数 | 类型 | 必填 | 默认值 | 规则 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `page` | number | 否 | `1` | 最小 `1` | 页码 |
| `limit` | number | 否 | `20` | `1` 到 `100` | 每页数量 |

请求示例：

```bash
curl "http://localhost:3000/api/worker/orders?page=1&limit=50" \
  -H "Authorization: Bearer <token>"
```

成功响应：

```json
{
  "orders": [
    {
      "id": "order-id",
      "trackingToken": "tracking-token",
      "status": "PENDING_PAYMENT",
      "pixCode": "000201...",
      "pixQrPngBase64": "base64-png",
      "pixExpiresAt": "2026-06-02T00:30:00.000Z",
      "pixImageUrl": "https://example.com/pix.png",
      "createdAt": "2026-06-02T00:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 50
}
```

### GET `/api/worker/summary`

查询 Worker 完成统计。

权限：`WORKER`、`ADMIN`。

请求示例：

```bash
curl http://localhost:3000/api/worker/summary \
  -H "Authorization: Bearer <token>"
```

成功响应：

```json
{
  "completedTotal": 100,
  "completedToday": 10,
  "completedThisWeek": 50,
  "claimedCount": 2,
  "availableCount": 8
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `completedTotal` | 当前 Worker 历史完成总数 |
| `completedToday` | 当前 Worker 上海自然日内完成数 |
| `completedThisWeek` | 当前 Worker 上海自然周内完成数 |
| `claimedCount` | 当前 Worker 有效领取中的待支付订单数 |
| `availableCount` | 当前可领取的待支付订单数，不包含其他 Worker 有效领取中的订单 |

### POST `/api/worker/orders/claim-batch`

固定批量领取待支付订单。每次最多领取 10 单；可领取订单不足 10 单时，领取当前全部可领取订单。

权限：`WORKER`、`ADMIN`。

请求示例：

```bash
curl -X POST http://localhost:3000/api/worker/orders/claim-batch \
  -H "Authorization: Bearer <token>"
```

成功响应：

```json
{
  "orders": [
    {
      "id": "order-id",
      "trackingToken": "tracking-token",
      "status": "PENDING_PAYMENT",
      "pixCode": "000201...",
      "pixQrPngBase64": "base64-png",
      "pixExpiresAt": "2026-06-02T00:30:00.000Z",
      "pixImageUrl": "https://example.com/pix.png",
      "claimedById": "worker-id",
      "claimedAt": "2026-06-02T00:00:00.000Z",
      "claimExpiresAt": "2026-06-02T00:30:00.000Z",
      "createdAt": "2026-06-02T00:00:00.000Z"
    }
  ],
  "claimedCount": 1
}
```

说明：返回 `claimedCount=0` 表示当前没有可领取订单。批量领取只处理 `PENDING_PAYMENT` 且未被有效领取或领取已过期的订单。

### POST `/api/worker/orders/:orderId/complete`

将待支付订单标记为支付完成。

权限：`WORKER`、`ADMIN`。

路径参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `orderId` | string | 订单 ID |

请求示例：

```bash
curl -X POST http://localhost:3000/api/worker/orders/order-id/complete \
  -H "Authorization: Bearer <token>"
```

成功响应：

```json
{
  "id": "order-id",
  "status": "PAYMENT_COMPLETED",
  "completedAt": "2026-06-02T00:10:00.000Z"
}
```

失败响应：

| HTTP 状态 | 说明 |
| --- | --- |
| `404` | 订单不存在 |
| `409` | 订单不是 `PENDING_PAYMENT`，不能完成 |

## 6. Admin 接口

Admin 接口统一需要 `ADMIN` 权限。

### 6.1 兑换码管理

#### POST `/api/admin/redemption-codes`

批量生成兑换码。

请求体：

| 字段 | 类型 | 必填 | 规则 | 说明 |
| --- | --- | --- | --- | --- |
| `count` | number | 是 | 整数，1 到 500 | 生成数量 |
| `batchLabel` | string | 否 | 最长 100 字符 | 批次标签 |

请求示例：

```bash
curl -X POST http://localhost:3000/api/admin/redemption-codes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d "{\"count\":10,\"batchLabel\":\"2026-06-02\"}"
```

成功响应：`201 Created`

```json
{
  "codes": [
    {
      "id": "code-id",
      "code": "ABCD-2345",
      "createdAt": "2026-06-02T00:00:00.000Z"
    }
  ],
  "batchLabel": "2026-06-02"
}
```

#### GET `/api/admin/redemption-codes`

查询兑换码列表。

查询参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | string | 否 | `all` | `unused`、`used`、`all` |
| `batchLabel` | string | 否 | 无 | 批次标签 |
| `page` | number | 否 | `1` | 页码 |
| `limit` | number | 否 | `50` | 每页数量，最大 `100` |

成功响应：

```json
{
  "codes": [
    {
      "id": "code-id",
      "code": "ABCD-2345",
      "batchLabel": "2026-06-02",
      "usedAt": null,
      "createdAt": "2026-06-02T00:00:00.000Z",
      "order": null
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 50
}
```

#### DELETE `/api/admin/redemption-codes/:id`

删除未使用的兑换码。

成功响应：

```json
{
  "success": true
}
```

失败响应：

| HTTP 状态 | 说明 |
| --- | --- |
| `404` | 兑换码不存在 |
| `409` | 已使用的兑换码不能删除 |

### 6.2 工人账号管理

#### POST `/api/admin/workers`

创建 Worker 账号。

请求体：

| 字段 | 类型 | 必填 | 规则 | 说明 |
| --- | --- | --- | --- | --- |
| `username` | string | 是 | 2 到 50 字符 | 登录用户名 |
| `password` | string | 是 | 6 到 200 字符 | 登录密码 |
| `displayName` | string | 否 | 最长 100 字符 | 显示名称 |

成功响应：`201 Created`

```json
{
  "id": "worker-id",
  "username": "worker01",
  "displayName": "Worker 01",
  "role": "WORKER",
  "enabled": true,
  "deletedAt": null,
  "createdAt": "2026-06-02T00:00:00.000Z"
}
```

失败响应：

| HTTP 状态 | 说明 |
| --- | --- |
| `409` | 用户名已存在 |

#### GET `/api/admin/workers`

查询未删除的 Worker 列表。禁用账号仍会返回，方便管理员恢复；软删除账号不会返回。

成功响应：

```json
{
  "workers": [
    {
      "id": "worker-id",
      "username": "worker01",
      "displayName": "Worker 01",
      "enabled": true,
      "deletedAt": null,
      "completedTotal": 12,
      "completedToday": 2,
      "completedThisWeek": 7,
      "claimedCount": 0,
      "lastCompletedAt": "2026-06-02T10:00:00.000Z",
      "createdAt": "2026-06-02T00:00:00.000Z"
    }
  ]
}
```

说明：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否允许该 Worker 登录和领取任务 |
| `deletedAt` | `null` 表示未删除；软删除账号不会出现在该列表 |
| `claimedCount` | 当前有效领取任务数；禁用账号会释放当前领取任务，因此应为 `0` |

#### PATCH `/api/admin/workers/:id`

更新 Worker。

请求体：

| 字段 | 类型 | 必填 | 规则 | 说明 |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | 否 | - | 是否启用 |
| `password` | string | 否 | 6 到 200 字符 | 新密码 |
| `displayName` | string | 否 | 最长 100 字符 | 显示名称 |

成功响应：

```json
{
  "id": "worker-id",
  "username": "worker01",
  "displayName": "Worker 01",
  "enabled": true,
  "deletedAt": null
}
```

#### DELETE `/api/admin/workers/:id`

软删除 Worker 账号。删除后账号不可登录、不可恢复、不会出现在 Worker 列表和 Dashboard 当前绩效榜；历史订单的领取人和完成人归属继续保留。

成功响应：

```json
{
  "success": true
}
```

说明：当前实现不是物理删除账号，而是设置 `deletedAt` 并禁用账号。删除时会释放该账号当前有效领取的待支付订单，但不会清空历史订单的 `completedById`。

### 6.3 订单管理

#### GET `/api/admin/orders`

查询订单列表。

查询参数：

| 参数 | 类型 | 必填 | 默认值 | 规则 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `page` | number | 否 | `1` | 最小 `1` | 页码 |
| `limit` | number | 否 | `50` | `1` 到 `100` | 每页数量 |
| `status` | string | 否 | 无 | 订单状态枚举 | 按状态过滤 |

成功响应：

```json
{
  "orders": [
    {
      "id": "order-id",
      "trackingToken": "tracking-token",
      "status": "PENDING_PAYMENT",
      "pixCode": "000201...",
      "checkoutSessionId": "checkout-session-id",
      "errorMessage": null,
      "completedAt": null,
      "createdAt": "2026-06-02T00:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 50
}
```

#### PATCH `/api/admin/orders/:id`

取消订单。

请求体：

| 字段 | 类型 | 必填 | 规则 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | string | 是 | 只能是 `CANCELLED` | 目标状态 |

请求示例：

```bash
curl -X PATCH http://localhost:3000/api/admin/orders/order-id \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d "{\"status\":\"CANCELLED\"}"
```

成功响应：

```json
{
  "id": "order-id",
  "status": "CANCELLED"
}
```

失败响应：

| HTTP 状态 | 说明 |
| --- | --- |
| `404` | 订单不存在 |
| `409` | 当前订单状态不能取消 |

### 6.4 看板

#### GET `/api/admin/dashboard`

获取管理看板统计。

成功响应：

```json
{
  "totals": {
    "totalOrders": 100,
    "pendingOrders": 5,
    "completedOrders": 80,
    "completedTotal": 80,
    "completedToday": 10,
    "completedThisWeek": 30,
    "failedOrders": 10,
    "cancelledOrders": 3,
    "expiredOrders": 2,
    "totalCodes": 200,
    "unusedCodes": 100
  },
  "queue": {
    "waitingCount": 0,
    "activeCount": 0,
    "delayedCount": 0,
    "averageGenerationSeconds": 20,
    "successRateLastHour": 100
  },
  "proxyHealth": {
    "chatGpt": {
      "total": 1,
      "healthy": 1,
      "coolingDown": 0
    },
    "stripe": {
      "total": 1,
      "healthy": 1,
      "coolingDown": 0
    }
  },
  "dailyTrend": [
    {
      "date": "2026-06-02",
      "created": 10,
      "completed": 8,
      "failed": 1
    }
  ]
}
```

### 6.5 系统设置

#### GET `/api/admin/settings/proxy`

查询代理池配置。

成功响应：

```json
{
  "chatGpt": {
    "enabled": true,
    "proxies": [
      {
        "id": "proxy-id",
        "host": "127.0.0.1",
        "port": 7890,
        "username": "user",
        "maskedProxy": "http://user:****@127.0.0.1:7890",
        "consecutiveFailures": 0,
        "coolingDownUntil": null,
        "healthy": true
      }
    ]
  },
  "stripe": {
    "enabled": false,
    "proxies": []
  }
}
```

#### PUT `/api/admin/settings/proxy`

更新代理池配置。

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `chatGptProxyPool` | string/null | 否 | ChatGPT 代理池，多行文本，每行一个代理 |
| `stripeProxyPool` | string/null | 否 | Stripe 代理池，多行文本，每行一个代理 |

代理格式：

```text
host:port:username:password
```

请求示例：

```bash
curl -X PUT http://localhost:3000/api/admin/settings/proxy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d "{\"chatGptProxyPool\":\"127.0.0.1:7890:user:pass\",\"stripeProxyPool\":null}"
```

#### GET `/api/admin/settings/maintenance-mode`

查询维护模式。

成功响应：

```json
{
  "enabled": false
}
```

#### PUT `/api/admin/settings/maintenance-mode`

更新维护模式。

请求体：

```json
{
  "enabled": true
}
```

成功响应：

```json
{
  "enabled": true
}
```

#### GET `/api/admin/settings/auto-payment-detection`

查询自动支付检测开关。

成功响应：

```json
{
  "enabled": true
}
```

#### PUT `/api/admin/settings/auto-payment-detection`

更新自动支付检测开关。

请求体：

```json
{
  "enabled": false
}
```

成功响应：

```json
{
  "enabled": false
}
```

## 7. Socket.IO 实时通知

Socket.IO 命名空间不带 `/api` 前缀。

### 7.1 客户订单追踪：`/orders`

权限：无。

用途：客户根据 `trackingToken` 接收自己的订单状态变化。

客户端连接：

```ts
import { io } from 'socket.io-client';

const socket = io('/orders', {
  transports: ['websocket', 'polling'],
});

socket.on('connect', () => {
  socket.emit('join', { trackingToken: 'tracking-token' });
});

socket.on('order:status', (payload) => {
  console.log(payload);
});
```

客户端事件：

| 事件 | 方向 | 负载 | 说明 |
| --- | --- | --- | --- |
| `join` | 客户端 -> 服务端 | `{ "trackingToken": "tracking-token" }` | 加入订单房间 |

服务端事件：

| 事件 | 方向 | 负载 | 说明 |
| --- | --- | --- | --- |
| `order:status` | 服务端 -> 客户端 | 订单公开状态 | 订单状态变化 |

`order:status` 负载：

```json
{
  "id": "order-id",
  "trackingToken": "tracking-token",
  "status": "PAYMENT_COMPLETED",
  "completedAt": "2026-06-02T00:10:00.000Z"
}
```

限制：

| 限制 | 说明 |
| --- | --- |
| 单连接最多加入 5 个订单房间 | 超过后服务端忽略新的 `join` |
| `trackingToken` 格式 | 只接受 8 到 64 位的字母、数字、下划线、短横线 |

### 7.2 Worker 实时队列：`/worker`

权限：`WORKER`、`ADMIN`。

客户端连接：

```ts
import { io } from 'socket.io-client';

const socket = io('/worker', {
  auth: { token: 'jwt-token' },
  transports: ['websocket', 'polling'],
});

socket.on('order:new', (payload) => {
  console.log('new order', payload);
});

socket.on('order:completed', (payload) => {
  console.log('completed order', payload);
});
```

服务端事件：

| 事件 | 说明 |
| --- | --- |
| `order:new` | 新订单支付信息已准备好，可进入 Worker 队列 |
| `order:completed` | 订单状态变为完成或状态变化通知 |

`order:new` 负载：

```json
{
  "id": "order-id",
  "trackingToken": "tracking-token",
  "status": "PENDING_PAYMENT",
  "pixCode": "000201...",
  "pixQrPngBase64": "base64-png",
  "pixExpiresAt": "2026-06-02T00:30:00.000Z",
  "pixImageUrl": "https://example.com/pix.png",
  "createdAt": "2026-06-02T00:00:00.000Z"
}
```

`order:completed` 负载：

```json
{
  "id": "order-id",
  "trackingToken": "tracking-token",
  "status": "PAYMENT_COMPLETED",
  "completedAt": "2026-06-02T00:10:00.000Z"
}
```

### 7.3 Admin 实时队列：`/admin`

权限：`ADMIN`。

事件与 `/worker` 类似：

| 事件 | 说明 |
| --- | --- |
| `order:new` | 新订单支付信息已准备好 |
| `order:completed` | 订单状态变化或支付完成 |

## 8. 大量兑换推荐接入流程

大量兑换时，不建议直接无限并发请求 `/api/orders`。推荐使用“提交队列 + 本地任务表 + WebSocket 实时通知 + 轮询兜底”。

### 8.1 推荐流程

| 步骤 | 动作 | 使用接口 | 成功条件 | 失败条件 |
| --- | --- | --- | --- | --- |
| 1 | 准备任务 | 本地任务表 | 每条任务有 `redemptionCode` 和 `session` | 数据缺失或重复 |
| 2 | 限速提交兑换 | `POST /api/orders` | 返回 `202` 和 `trackingToken` | `INVALID_CODE`、`CODE_USED`、`429`、`502`、`503` |
| 3 | 保存追踪信息 | 本地任务表 | 保存 `trackingToken` 和当前状态 | 保存失败 |
| 4 | 等待支付生成 | `GET /api/orders/track/:trackingToken` 或 `/worker` Socket | 状态变为 `PENDING_PAYMENT` | 状态变为 `FAILED/EXPIRED/CANCELLED` |
| 5 | 等待支付完成 | `/orders`、`/worker` 或 `/admin` Socket | 状态变为 `PAYMENT_COMPLETED` | 状态变为 `FAILED/EXPIRED/CANCELLED` |
| 6 | 兜底确认 | `GET /api/orders/track/:trackingToken` | 查到最终状态 | 长时间无变化，按业务超时处理 |

### 8.2 本地任务表建议

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 本地任务 ID |
| `redemptionCode` | string | 兑换码 |
| `session` | string | session/access token 数据，建议加密保存 |
| `trackingToken` | string/null | `/api/orders` 返回的追踪 token |
| `submitStatus` | string | `PENDING`、`SUBMITTED`、`SUBMIT_FAILED` |
| `paymentStatus` | string | 订单状态枚举 |
| `errorCode` | string/null | API 返回的错误码 |
| `errorMessage` | string/null | API 返回的错误描述 |
| `createdAt` | datetime | 创建时间 |
| `updatedAt` | datetime | 更新时间 |

### 8.3 兑换结果判定

| 场景 | 判定 |
| --- | --- |
| `POST /api/orders` 返回 `202` | 只表示兑换任务提交成功，不代表最终支付成功 |
| 查询到 `CREATING_PAYMENT` | 支付还在生成中 |
| 查询到 `PENDING_PAYMENT` | 支付信息已生成，等待支付 |
| 查询到 `PAYMENT_COMPLETED` | 最终成功 |
| 查询到 `FAILED` | 最终失败 |
| 查询到 `EXPIRED` | 最终失败或过期 |
| 查询到 `CANCELLED` | 最终取消 |

### 8.4 批量提交限速建议

| 项目 | 建议 |
| --- | --- |
| 提交并发 | 控制在较低并发，例如 1 到 5 个 worker |
| 提交速率 | 不超过服务端 `CREATE_ORDER_RATE_LIMIT_PER_MIN` |
| 失败重试 | 只对 `429`、临时网络错误、部分 `502/503` 做有限重试 |
| 不建议重试 | `INVALID_CODE`、`CODE_USED`、参数错误 |
| 轮询间隔 | 初始 3 到 5 秒，长时间未完成后可退避到 10 到 30 秒 |
| 状态落库 | 每次状态变化立即保存，避免进程重启后丢任务 |

## 9. 最小批量兑换伪代码

```ts
type LocalTask = {
  id: string;
  redemptionCode: string;
  session: string;
  trackingToken?: string;
  submitStatus: 'PENDING' | 'SUBMITTED' | 'SUBMIT_FAILED';
  paymentStatus?: string;
  errorCode?: string;
  errorMessage?: string;
};

async function submitTask(task: LocalTask) {
  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redemptionCode: task.redemptionCode,
        session: task.session,
      }),
    });

    const body = await response.json();
    if (!response.ok) {
      task.submitStatus = 'SUBMIT_FAILED';
      task.errorCode = body.code ?? null;
      task.errorMessage = body.error ?? '提交失败';
      return task;
    }

    task.submitStatus = 'SUBMITTED';
    task.trackingToken = body.trackingToken;
    task.paymentStatus = body.status;
    return task;
  } catch (error) {
    task.submitStatus = 'SUBMIT_FAILED';
    task.errorMessage = error instanceof Error ? error.message : '网络错误';
    return task;
  }
}

async function refreshTask(task: LocalTask) {
  if (!task.trackingToken) return task;

  const response = await fetch(`/api/orders/track/${task.trackingToken}`);
  const body = await response.json();

  if (!response.ok) {
    task.errorCode = body.code ?? null;
    task.errorMessage = body.error ?? '查询失败';
    return task;
  }

  task.paymentStatus = body.status;
  task.errorMessage = body.errorMessage;
  return task;
}
```

## 10. 对外集成检查清单

| 检查项 | 说明 |
| --- | --- |
| 保存 `trackingToken` | 没有它就无法查询公开订单状态 |
| 区分提交成功和支付成功 | `202` 只代表任务进入队列 |
| 使用最终状态判定结果 | 以 `PAYMENT_COMPLETED/FAILED/EXPIRED/CANCELLED` 为准 |
| WebSocket 加轮询兜底 | 防止断线漏事件 |
| 控制提交速度 | 避免触发限流和队列压力 |
| 加密保存 session | session 属于敏感信息 |
| 记录错误码 | 方便区分兑换码问题、维护模式、上游失败和限流 |
