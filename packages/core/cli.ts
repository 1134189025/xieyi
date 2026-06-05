import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateBrazilBillingProfile } from './brazil-profile.ts';
import { loadStripePixProtocolFromHarFile } from './har-extractor.ts';
import { writePixQrArtifacts } from './qr-code.ts';
import {
  buildConfirmRequestBody,
  buildPaymentMethodRequestBody,
  createDirectStripePixPayment,
  createStripeRuntimeIdentifiers,
  parseCheckoutSessionId,
  type StripeHttpTransport,
  type StripeRiskFields,
} from './stripe-pix-protocol.ts';

interface ParsedArgs {
  command: string;
  options: Map<string, string>;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.command === 'from-har') {
    const harPath = requiredOption(args, 'har');
    const outputDir = args.options.get('out') ?? path.resolve('协议支付', 'output');
    const protocol = await loadStripePixProtocolFromHarFile(harPath);
    const artifactFiles = await writePixQrArtifacts({
      outputDir,
      pixCode: protocol.pix.data,
      fileBaseName: 'pix',
    });
    await writeJson(path.join(outputDir, 'protocol-report.json'), protocol);
    await writeJson(path.join(outputDir, 'risk-fields.json'), protocol.riskFields);
    await writeJson(path.join(outputDir, 'profile.json'), protocol.profile);

    console.log(JSON.stringify({ outputDir, artifactFiles, pixCode: protocol.pix.data }, null, 2));
    return;
  }

  if (args.command === 'build-bodies') {
    const checkoutUrl = requiredOption(args, 'checkout-url');
    const outputDir = args.options.get('out') ?? path.resolve('协议支付', 'output');
    const protocolFromHar = args.options.get('har')
      ? await loadStripePixProtocolFromHarFile(String(args.options.get('har')))
      : undefined;
    const profile = protocolFromHar?.profile ?? generateBrazilBillingProfile();
    const checkoutSessionId = parseCheckoutSessionId(checkoutUrl);
    const identifiers = protocolFromHar?.identifiers ?? createStripeRuntimeIdentifiers();
    const clientSessionId = protocolFromHar?.clientSessionId ?? cryptoRandomToken();
    const checkoutConfigId = protocolFromHar?.checkoutConfigId;
    const riskFields = protocolFromHar?.riskFields;

    await mkdir(outputDir, { recursive: true });
    await writeJson(path.join(outputDir, 'random-profile.json'), profile);
    await writeText(
      path.join(outputDir, 'payment-method-body.txt'),
      buildPaymentMethodRequestBody({
        checkoutSessionId,
        clientSessionId,
        checkoutConfigId,
        identifiers,
        profile,
      }).toString(),
    );
    if (riskFields) {
      await writeText(
        path.join(outputDir, 'confirm-body.txt'),
        buildConfirmRequestBody({
          checkoutSessionId,
          paymentMethodId: protocolFromHar.paymentMethodId,
          returnUrl: checkoutUrl,
          clientSessionId,
          checkoutConfigId,
          identifiers,
          riskFields,
        }).toString(),
      );
    }

    console.log(JSON.stringify({ outputDir, profile }, null, 2));
    return;
  }

  if (args.command === 'live') {
    const checkoutUrl = requiredOption(args, 'checkout-url');
    const outputDir = args.options.get('out') ?? path.resolve('协议支付', 'output');
    const protocolFromHar = args.options.get('har')
      ? await loadStripePixProtocolFromHarFile(String(args.options.get('har')))
      : undefined;
    const profile = protocolFromHar?.profile ?? generateBrazilBillingProfile();
    const identifiers = protocolFromHar?.identifiers ?? createStripeRuntimeIdentifiers();
    const riskFields = args.options.get('risk-json')
      ? (JSON.parse(await readFile(String(args.options.get('risk-json')), 'utf8')) as Partial<StripeRiskFields>)
      : protocolFromHar?.riskFields;
    const result = await createDirectStripePixPayment({
      checkoutUrl,
      profile,
      riskFields,
      identifiers,
      clientSessionId: protocolFromHar?.clientSessionId ?? cryptoRandomToken(),
      checkoutConfigId: protocolFromHar?.checkoutConfigId,
    });

    const artifactFiles = await writePixQrArtifacts({
      outputDir,
      pixCode: result.pix.data,
      fileBaseName: 'pix-live',
    });
    await writeJson(path.join(outputDir, 'live-result.json'), {
      ...result,
      profile,
      artifactFiles,
    });
    console.log(JSON.stringify({ outputDir, artifactFiles, pixCode: result.pix.data }, null, 2));
    return;
  }

  if (args.command === 'direct') {
    const checkoutUrl = requiredOption(args, 'checkout-url');
    const outputDir = args.options.get('out') ?? path.resolve('协议支付', 'output-direct');
    const profile = args.options.get('profile-json')
      ? JSON.parse(await readFile(String(args.options.get('profile-json')), 'utf8'))
      : generateBrazilBillingProfile();
    const riskFields = args.options.get('risk-json')
      ? (JSON.parse(await readFile(String(args.options.get('risk-json')), 'utf8')) as Partial<StripeRiskFields>)
      : undefined;
    const transport = new RecordingStripeHttpTransport(outputDir);

    try {
      const result = await createDirectStripePixPayment({
        checkoutUrl,
        profile,
        riskFields,
        transport,
      });
      const artifactFiles = await writePixQrArtifacts({
        outputDir,
        pixCode: result.pix.data,
        fileBaseName: 'pix-direct',
      });
      await writeJson(path.join(outputDir, 'direct-result.json'), {
        ...result,
        profile,
        artifactFiles,
      });
      console.log(JSON.stringify({ outputDir, artifactFiles, pixCode: result.pix.data }, null, 2));
    } catch (error: unknown) {
      await writeJson(path.join(outputDir, 'direct-error.json'), {
        message: error instanceof Error ? error.message : String(error),
        profile,
      });
      throw error;
    }
    return;
  }

  printUsageAndExit();
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const options = new Map<string, string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options.set(key, value);
    index += 1;
  }

  return { command, options };
}

function requiredOption(args: ParsedArgs, key: string): string {
  const value = args.options.get(key);
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

function cryptoRandomToken(): string {
  return randomUUID();
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${value}\n`, 'utf8');
}

function printUsageAndExit(): never {
  console.log(`Usage:
  npx tsx ./协议支付/cli.ts from-har --har C:/Users/11341/Downloads/pay.openai.com.har --out ./协议支付/output
  npx tsx ./协议支付/cli.ts build-bodies --checkout-url <pay.openai.com/c/pay/cs_...> --out ./协议支付/output
  npx tsx ./协议支付/cli.ts direct --checkout-url <pay.openai.com/c/pay/cs_...> --out ./协议支付/output-direct
  npx tsx ./协议支付/cli.ts live --checkout-url <pay.openai.com/c/pay/cs_...> --risk-json ./协议支付/output/risk-fields.json --out ./协议支付/output

Notes:
  from-har only extracts the captured protocol and writes Pix code/QR artifacts.
  direct uses only HTTP requests; if Stripe requires browser-generated risk fields, the error is written to direct-error.json.
  live requires fresh Stripe risk fields from the same checkout session; stale HAR values may be rejected.
`);
  throw new Error('Command required');
}

class RecordingStripeHttpTransport implements StripeHttpTransport {
  private sequence = 0;

  constructor(private readonly outputDir: string) {}

  async postForm(url: string, body: URLSearchParams, options: { timeoutMs?: number } = {}): Promise<unknown> {
    this.sequence += 1;
    await mkdir(this.outputDir, { recursive: true });
    await writeText(path.join(this.outputDir, `${String(this.sequence).padStart(2, '0')}-request.txt`), `${url}\n${body}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        origin: 'https://pay.openai.com',
        referer: 'https://pay.openai.com/',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      },
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const text = await response.text();
    await writeText(path.join(this.outputDir, `${String(this.sequence).padStart(2, '0')}-response.txt`), text);

    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`Stripe request failed: ${response.status} ${text.slice(0, 500)}`);
    }
    return json;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
