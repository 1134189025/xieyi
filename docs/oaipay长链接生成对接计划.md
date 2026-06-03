# oaipay 长链接生成对接计划

## 目标

将当前本地创建 ChatGPT checkout 长链接的步骤替换为调用 oaipay：

```text
ChatGPT accessToken
-> POST https://oaipay.im-run.com/api/long-link
-> 返回可解析的 checkout 长链接
-> 继续走本项目现有 Stripe Pix 协议生成二维码
```

本次只替换长链接来源，不改变客户下单、BullMQ 排队、worker 生成 Pix、工人领取、二维码展示、手动完成和自动检测主流程。

## 对接决策

- oaipay 请求固定使用 `link_type=hosted`、`billing_country=BR`、`checkout_ui_mode=hosted`、`payment_locale=pt-BR`。
- `accessToken` 仍来自客户提交的 accessToken 或包含 `accessToken/access_token/at` 的 JSON。
- 现有 ChatGPT 代理池选出的代理会透传给 oaipay 的 `proxy` 字段；Stripe 代理池仍只用于后续 Pix 协议请求。
- oaipay 响应优先读取 `stripe_hosted_url`，其次读取 `long_url`。
- 返回 URL 必须能被现有 Stripe/Pix 协议识别出 `cs_` checkout session id，否则订单失败，不继续生成 Pix。
- 不新增数据库字段，继续用 `orders.checkout_url` 保存最终用于 Pix 协议的 checkout 长链接。
- 原有本地直连 ChatGPT checkout 生成逻辑暂时隐藏，不作为默认路径，也不在前端或后台暴露切换开关。

## 错误处理

- oaipay `401/422`、`ok=false`、缺少可用 URL 或 URL 不能解析为 checkout session，统一视为 `CHATGPT_CHECKOUT_FAILED`。
- oaipay `408/429/5xx`、超时和网络错误保留为可重试失败，继续交给 BullMQ 的 3 次 job 重试处理。
- 日志和诊断不得记录完整 accessToken、代理密码、Pix code 或 SetupIntent client secret。
- 生成最终失败时继续通过 `failCreatingPaymentOrder()` 释放兑换码、清空 session，并广播失败状态。

## 验证

- `chatgpt-session.service.test.ts` 覆盖 oaipay 成功、非法 URL、业务失败、可重试失败。
- `pix-generation.service.test.ts` 覆盖 worker 仍把 oaipay 长链接交给现有 `generatePixPayment()`。
- 回归执行 `npm --workspace @pix/server run test`、`npm --workspace @pix/web run test`、`npm run typecheck`、`npm run build`。
- 外部健康检查验证 `https://oaipay.im-run.com/api/health` 返回 `{"ok":true}`。
