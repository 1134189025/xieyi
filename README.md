# Pix 协议支付模块

这个目录把巴西 Pix 支付链路拆成可复用的协议操作：

1. 随机生成巴西账单资料：姓名、邮箱、CPF、地址。
2. 构造 `POST https://api.stripe.com/v1/payment_methods`，创建 Pix `pm_...`。
3. 构造 `POST https://api.stripe.com/v1/payment_pages/{cs_...}/confirm`，提交 Pix 支付确认。
4. 从 Stripe 返回中提取 Pix 复制粘贴代码、Stripe instructions 链接和二维码图片地址。
5. 本地生成 `pix-code.txt` 和 `pix-qrcode.png`。

## 重要限制

`confirm` 请求里的 `init_checksum`、`js_checksum`、`px3`、`pxvid`、`pxcts`、`passive_captcha_token`、`rv_timestamp` 是 Stripe 风控字段，需要从同一次 checkout 页面实时产生。HAR 里能提取这些字段用于复盘和构造请求，但旧 HAR 字段不一定能用于新的 live 链接。

## 从 HAR 输出 Pix 代码和二维码

```powershell
npx tsx ./协议支付/cli.ts from-har --har C:/Users/11341/Downloads/pay.openai.com.har --out ./协议支付/output
```

输出文件：

- `output/pix-code.txt`
- `output/pix-qrcode.png`
- `output/protocol-report.json`
- `output/risk-fields.json`
- `output/profile.json`

## 只构造协议请求体

```powershell
npx tsx ./协议支付/cli.ts build-bodies --checkout-url "https://pay.openai.com/c/pay/cs_live_xxx" --har C:/Users/11341/Downloads/pay.openai.com.har --out ./协议支付/output
```

输出：

- `output/payment-method-body.txt`
- `output/confirm-body.txt`
- `output/random-profile.json`

## Live 协议请求

```powershell
npx tsx ./协议支付/cli.ts live --checkout-url "https://pay.openai.com/c/pay/cs_live_xxx" --risk-json ./协议支付/output/risk-fields.json --out ./协议支付/output
```

这个命令会真实请求 Stripe。要稳定成功，需要 `risk-json` 来自当前 checkout session 的新鲜字段。
