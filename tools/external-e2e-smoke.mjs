#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const baseUrlInput = process.env.PIX_BASE_URL;
const baseUrl = normalizeBaseUrl(baseUrlInput ?? 'http://127.0.0.1:3000');
const confirmedBaseUrl = process.env.PIX_E2E_CONFIRM_BASE_URL ?? '';
const adminUsername = process.env.PIX_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME;
const adminPassword = process.env.PIX_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
const mode = normalizeMode(process.env.PIX_E2E_MODE ?? 'local');
const enableWriteChecks = parseFlag(process.env.PIX_E2E_WRITE);
const allowSettingUpdate = parseFlag(process.env.PIX_E2E_ALLOW_SETTING_UPDATE);
const allowExistingOutsourcedCode = parseFlag(process.env.PIX_E2E_USE_EXISTING_OUTSOURCED_CODE);
const localClaim = parseFlag(process.env.PIX_E2E_LOCAL_CLAIM);
const localManualComplete = parseFlag(process.env.PIX_E2E_LOCAL_COMPLETE);
const riskAcknowledgement = process.env.PIX_E2E_ACK_RISK ?? '';
const outsourcedActivationCode = process.env.PIX_E2E_OUTSOURCED_CODE ?? '';
const timeoutMs = parsePositiveInt(process.env.PIX_E2E_TIMEOUT_MS, 10 * 60 * 1000);
const pollMs = parsePositiveInt(process.env.PIX_E2E_POLL_MS, 5_000);
const batchLabel = `e2e-${mode}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
let sessionInput = '';

const summary = {
  baseUrl,
  mode,
  batchLabel,
  health: null,
  ready: null,
  admin: null,
  maintenanceMode: null,
  proxyPrecheck: null,
  dashboardBaseline: null,
  paymentProcessing: null,
  importedOutsourcedCode: null,
  createdLocalCode: null,
  createdOrder: null,
  adminOrderSubmission: null,
  terminalOrder: null,
  finalAdminOrder: null,
  localWorkerCheck: null,
  cleanup: null,
};

try {
  assertWriteIntent();

  const health = await requestJson('/api/health');
  summary.health = health.status ?? null;

  const ready = await requestJson('/api/ready');
  summary.ready = ready;

  if (!adminUsername || !adminPassword) {
    throw new Error('PIX_ADMIN_USERNAME/PIX_ADMIN_PASSWORD or ADMIN_USERNAME/ADMIN_PASSWORD is required');
  }
  const login = await requestJson('/api/auth/login', {
    method: 'POST',
    body: { username: adminUsername, password: adminPassword },
  });
  const adminToken = assertString(login.token, 'admin login token');
  summary.admin = {
    username: login.user?.username ?? adminUsername,
    role: login.user?.role ?? null,
  };

  await runPreflightChecks(adminToken);

  if (mode === 'outsourced' && outsourcedActivationCode.trim()) {
    summary.importedOutsourcedCode = await importOutsourcedCode(adminToken);
  }

  summary.paymentProcessing = await ensurePaymentProcessingMode(adminToken);

  const localCode = await createLocalRedemptionCode(adminToken);
  summary.createdLocalCode = { code: maskCode(localCode), batchLabel };

  const createdOrder = await requestJson('/api/orders', {
    method: 'POST',
    expectedStatus: 202,
    body: {
      redemptionCode: localCode,
      session: sessionInput.trim(),
    },
  });
  const trackingToken = assertString(createdOrder.trackingToken, 'created order tracking token');
  summary.createdOrder = {
    trackingToken,
    status: createdOrder.status ?? null,
    paymentHandler: createdOrder.paymentHandler ?? null,
  };

  if (mode === 'local') {
    summary.terminalOrder = await waitForLocalPixReady(trackingToken);
    summary.localWorkerCheck = await verifyLocalWorkerQueue(adminToken, trackingToken);
    if (localManualComplete) {
      summary.localWorkerCheck.completed = await completeClaimedOrder(adminToken, summary.localWorkerCheck.orderId);
      summary.terminalOrder = await requestJson(`/api/orders/track/${encodeURIComponent(trackingToken)}`);
    }
  } else {
    summary.adminOrderSubmission = await waitForOutsourcedSubmission(adminToken, trackingToken);
    summary.terminalOrder = await waitForOutsourcedTerminalStatus(trackingToken);
    summary.finalAdminOrder = await getAdminOrderByTrackingToken(adminToken, trackingToken);
    validateOutsourcedFinalState(summary.terminalOrder, summary.finalAdminOrder);
  }

  summary.cleanup = await cleanup(adminToken);
  console.log(JSON.stringify({ ok: true, summary }, null, 2));
} catch (error) {
  try {
    if (summary.admin && adminUsername && adminPassword) {
      const login = await requestJson('/api/auth/login', {
        method: 'POST',
        body: { username: adminUsername, password: adminPassword },
      });
      await cleanup(login.token);
    }
  } catch {
    // Cleanup is best-effort; report the original failure below.
  }
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    summary,
  }, null, 2));
  process.exitCode = 1;
}

function assertWriteIntent() {
  if (!enableWriteChecks) {
    throw new Error('PIX_E2E_WRITE=1 is required because external E2E creates real test orders');
  }
  if (!baseUrlInput) {
    throw new Error('PIX_BASE_URL is required for external E2E; do not rely on the localhost default');
  }
  if (normalizeBaseUrl(confirmedBaseUrl) !== baseUrl) {
    throw new Error('PIX_E2E_CONFIRM_BASE_URL must exactly match PIX_BASE_URL');
  }
  if (riskAcknowledgement !== 'I_UNDERSTAND_REAL_EXTERNAL_REQUESTS') {
    throw new Error('PIX_E2E_ACK_RISK=I_UNDERSTAND_REAL_EXTERNAL_REQUESTS is required');
  }

  sessionInput = readSessionInput();
  if (!sessionInput.trim()) {
    throw new Error('PIX_E2E_SESSION or PIX_E2E_SESSION_FILE is required and must contain a real ChatGPT accessToken/session payload');
  }
  if (mode === 'outsourced' && !outsourcedActivationCode.trim() && !allowExistingOutsourcedCode) {
    throw new Error('PIX_E2E_OUTSOURCED_CODE is required in outsourced mode, unless PIX_E2E_USE_EXISTING_OUTSOURCED_CODE=1 is explicitly set');
  }
}

async function runPreflightChecks(token) {
  summary.maintenanceMode = await requestJson('/api/admin/settings/maintenance-mode', { token });
  if (summary.maintenanceMode.enabled) {
    throw new Error('Maintenance mode is enabled; refusing to create E2E test orders');
  }

  const proxySetting = await requestJson('/api/admin/settings/proxy', { token });
  assertProxySettingsAreMasked(proxySetting);
  summary.proxyPrecheck = summarizeProxySetting(proxySetting);

  const dashboard = await requestJson('/api/admin/dashboard', { token });
  summary.dashboardBaseline = summarizeDashboard(dashboard);
}

async function ensurePaymentProcessingMode(token) {
  const setting = await requestJson('/api/admin/settings/payment-processing', { token });
  const expectedHandler = mode === 'outsourced' ? 'OUTSOURCED_BUYER_API' : 'LOCAL_WORKER';
  if (setting.handler === expectedHandler) return setting;

  if (!allowSettingUpdate) {
    throw new Error(
      `payment handler is ${setting.handler}; expected ${expectedHandler}. ` +
      'Set PIX_E2E_ALLOW_SETTING_UPDATE=1 only in a controlled staging run if the script should switch it.',
    );
  }

  return requestJson('/api/admin/settings/payment-processing', {
    method: 'PUT',
    token,
    body: {
      handler: expectedHandler,
      outsourcedBuyerApiBaseUrl: setting.outsourcedBuyerApiBaseUrl,
    },
  });
}

async function importOutsourcedCode(token) {
  const imported = await requestJson('/api/admin/outsourced-activation-codes/import', {
    method: 'POST',
    token,
    expectedStatus: 201,
    body: {
      codesText: outsourcedActivationCode.trim(),
      batchLabel,
    },
  });
  return {
    importedCount: imported.importedCount ?? null,
    duplicateCount: imported.duplicateCount ?? null,
    batchLabel,
  };
}

async function createLocalRedemptionCode(token) {
  const created = await requestJson('/api/admin/redemption-codes', {
    method: 'POST',
    token,
    expectedStatus: 201,
    body: { count: 1, batchLabel },
  });
  const codes = Array.isArray(created.codes) ? created.codes : [];
  return assertString(codes[0]?.code, 'created redemption code');
}

async function waitForLocalPixReady(trackingToken) {
  return pollOrder(trackingToken, (order) => {
    if (order.status === 'FAILED') {
      throw new Error(`local Pix generation failed: ${order.errorMessage ?? 'unknown failure'}`);
    }
    return order.status === 'PENDING_PAYMENT'
      && order.paymentHandler === 'LOCAL_WORKER'
      && Boolean(order.pixCode || order.pixQrPngBase64 || order.pixImageUrl)
      && Boolean(order.queueEstimate);
  }, 'local Pix to become visible to workers');
}

async function waitForOutsourcedSubmission(token, trackingToken) {
  return pollAdminOrder(token, trackingToken, (order) => {
    if (order.status === 'FAILED') {
      throw new Error(`outsourced Pix generation failed before buyer submission: ${order.errorMessage ?? order.generationErrorCode ?? 'unknown failure'}`);
    }
    return order.status === 'PENDING_PAYMENT'
      && order.paymentHandler === 'OUTSOURCED_BUYER_API'
      && typeof order.outsourcedTicketId === 'string'
      && order.outsourcedTicketId.length > 0
      && typeof order.outsourcedPaymentStatus === 'string'
      && order.outsourcedPaymentStatus.length > 0;
  }, 'outsourced Pix to be submitted to buyer API');
}

async function waitForOutsourcedTerminalStatus(trackingToken) {
  return pollOrder(trackingToken, (order) => {
    if (order.status === 'FAILED') return true;
    return order.status === 'PAYMENT_COMPLETED'
      && order.paymentHandler === 'OUTSOURCED_BUYER_API';
  }, 'outsourced order to reach PAYMENT_COMPLETED or FAILED');
}

async function pollOrder(trackingToken, done, label) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await requestJson(`/api/orders/track/${encodeURIComponent(trackingToken)}`);
    if (done(latest)) return latest;
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for ${label}; latest order=${JSON.stringify(summarizeOrder(latest))}`);
}

async function pollAdminOrder(token, trackingToken, done, label) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await getAdminOrderByTrackingToken(token, trackingToken);
    if (done(latest)) return latest;
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for ${label}; latest admin order=${JSON.stringify(summarizeAdminOrder(latest))}`);
}

async function verifyLocalWorkerQueue(token, trackingToken) {
  const available = await requestJson('/api/worker/orders/available?limit=100', { token });
  const availableOrders = Array.isArray(available.orders) ? available.orders : [];
  const availableOrder = availableOrders.find((order) => order.trackingToken === trackingToken);
  if (!availableOrder) {
    throw new Error(`local worker available queue did not include test order ${trackingToken} in the first ${available.limit ?? 100} rows`);
  }

  const result = {
    foundInAvailableQueue: true,
    availableTotal: available.total ?? null,
    orderId: availableOrder.id,
    hasPixPayload: Boolean(availableOrder.pixCode || availableOrder.pixQrPngBase64 || availableOrder.pixImageUrl),
  };
  if (!localClaim && !localManualComplete) return result;

  const claimed = await requestJson('/api/worker/orders/claim-batch', { method: 'POST', token });
  const orders = Array.isArray(claimed.orders) ? claimed.orders : [];
  const matchingOrder = orders.find((order) => order.trackingToken === trackingToken);
  const nonTargetOrders = orders.filter((order) => order.id && order.trackingToken !== trackingToken);
  await Promise.all(nonTargetOrders.map((order) => releaseClaimedOrder(token, order.id)));
  if (!matchingOrder) {
    throw new Error(`local worker claim-batch did not return test order ${trackingToken}`);
  }

  return {
    ...result,
    claimedCount: claimed.claimedCount ?? orders.length,
    orderId: matchingOrder.id,
    hasPixPayload: Boolean(matchingOrder.pixCode || matchingOrder.pixQrPngBase64 || matchingOrder.pixImageUrl),
  };
}

async function completeClaimedOrder(token, orderId) {
  if (!orderId) throw new Error('Cannot complete local order because claimed order id is missing');
  return requestJson(`/api/worker/orders/${encodeURIComponent(orderId)}/complete`, {
    method: 'POST',
    token,
  });
}

async function releaseClaimedOrder(token, orderId) {
  if (!orderId) return null;
  return requestJson(`/api/worker/orders/${encodeURIComponent(orderId)}/release`, {
    method: 'POST',
    token,
  });
}

async function getAdminOrderByTrackingToken(token, trackingToken) {
  const response = await requestJson(`/api/admin/orders?limit=20&trackingToken=${encodeURIComponent(trackingToken)}`, { token });
  const orders = Array.isArray(response.orders) ? response.orders : [];
  const order = orders.find((item) => item.trackingToken === trackingToken);
  if (!order) throw new Error(`admin order ${trackingToken} was not found`);
  return order;
}

function validateOutsourcedFinalState(publicOrder, adminOrder) {
  if (publicOrder.status === 'PAYMENT_COMPLETED') {
    if (adminOrder.completedBy !== null) {
      throw new Error('outsourced completed order should not have a local completedBy worker');
    }
    return;
  }
  if (publicOrder.status === 'FAILED') {
    if (adminOrder.generationErrorStage !== 'outsourced_status') {
      throw new Error(`outsourced failed order should have generationErrorStage=outsourced_status, got ${adminOrder.generationErrorStage}`);
    }
    return;
  }
  throw new Error(`outsourced E2E ended in unexpected status ${publicOrder.status}`);
}

async function cleanup(token) {
  if (summary.localWorkerCheck?.orderId && !summary.localWorkerCheck.completed) {
    try {
      await releaseClaimedOrder(token, summary.localWorkerCheck.orderId);
    } catch {
      // Best-effort: the order may not have been claimed.
    }
  }

  const localDeleted = await requestJson('/api/admin/redemption-codes/delete-unused', {
    method: 'POST',
    token,
    body: { status: 'all', archiveScope: 'active', batchLabel },
  });
  let outsourcedDeleted = null;
  if (summary.importedOutsourcedCode) {
    outsourcedDeleted = await requestJson('/api/admin/outsourced-activation-codes/delete-unused', {
      method: 'POST',
      token,
      body: { status: 'all', archiveScope: 'active', batchLabel },
    });
  }
  return {
    deletedUnusedLocalCodes: localDeleted.deletedCount ?? null,
    deletedUnusedOutsourcedCodes: outsourcedDeleted?.deletedCount ?? null,
  };
}

async function requestJson(path, options = {}) {
  const method = options.method ?? 'GET';
  const headers = { ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
  const text = await response.text();
  const parsed = parseJson(text);
  const expectedStatus = options.expectedStatus ?? 200;
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return parsed;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API returned non-JSON response: ${text.slice(0, 200)}`);
  }
}

function summarizeOrder(order) {
  if (!order) return null;
  return {
    trackingToken: order.trackingToken,
    status: order.status,
    paymentHandler: order.paymentHandler,
    outsourcedPaymentStatus: order.outsourcedPaymentStatus,
    hasPixPayload: Boolean(order.pixCode || order.pixQrPngBase64 || order.pixImageUrl),
    hasQueueEstimate: Boolean(order.queueEstimate),
    errorMessage: order.errorMessage,
  };
}

function summarizeAdminOrder(order) {
  if (!order) return null;
  return {
    trackingToken: order.trackingToken,
    status: order.status,
    paymentHandler: order.paymentHandler,
    outsourcedTicketId: maskCode(order.outsourcedTicketId),
    outsourcedPaymentStatus: order.outsourcedPaymentStatus,
    generationErrorCode: order.generationErrorCode,
    generationErrorStage: order.generationErrorStage,
  };
}

function summarizeProxySetting(setting) {
  return {
    chatGpt: summarizeProxyPool(setting.chatGpt),
    stripe: summarizeProxyPool(setting.stripe),
  };
}

function summarizeProxyPool(pool) {
  const proxies = Array.isArray(pool?.proxies) ? pool.proxies : [];
  return {
    enabled: Boolean(pool?.enabled),
    total: proxies.length,
    healthy: proxies.filter((proxy) => proxy.healthy !== false).length,
    coolingDown: proxies.filter((proxy) => proxy.healthy === false).length,
  };
}

function summarizeDashboard(dashboard) {
  return {
    queue: dashboard?.queue ?? null,
    proxyHealth: dashboard?.proxyHealth ?? null,
    workerPerformance: dashboard?.workerPerformance
      ? {
        totalWorkers: dashboard.workerPerformance.totalWorkers,
        enabledWorkers: dashboard.workerPerformance.enabledWorkers,
        claimedOrders: dashboard.workerPerformance.claimedOrders,
        unclaimedPendingOrders: dashboard.workerPerformance.unclaimedPendingOrders,
      }
      : null,
  };
}

function assertProxySettingsAreMasked(setting) {
  const serialized = JSON.stringify(setting);
  if (serialized.includes('proxyUrl')) {
    throw new Error('proxy settings response unexpectedly exposed proxyUrl');
  }
  if (/:[^:*"@/]{2,}@/.test(serialized.replace(/:\*\*\*\*@/g, ':****@'))) {
    throw new Error('proxy settings response may expose proxy credentials');
  }
}

function readSessionInput() {
  const inlineValue = process.env.PIX_E2E_SESSION ?? '';
  if (inlineValue.trim()) return inlineValue;

  const filePath = process.env.PIX_E2E_SESSION_FILE ?? '';
  if (!filePath.trim()) return '';
  return readFileSync(filePath, 'utf8');
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function normalizeMode(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'local' || normalized === 'outsourced') return normalized;
  throw new Error('PIX_E2E_MODE must be local or outsourced');
}

function parseFlag(value) {
  return value === '1' || value === 'true';
}

function parsePositiveInt(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function maskCode(code) {
  if (typeof code !== 'string') return null;
  if (code.length <= 6) return '****';
  return `${code.slice(0, 4)}...${code.slice(-3)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
