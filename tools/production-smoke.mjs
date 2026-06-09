#!/usr/bin/env node

const baseUrl = normalizeBaseUrl(process.env.PIX_BASE_URL ?? 'http://127.0.0.1:3000');
const adminUsername = process.env.PIX_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME;
const adminPassword = process.env.PIX_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
const enableWriteChecks = parseFlag(process.env.PIX_SMOKE_WRITE);
const requestOutsourcedChecks = parseFlag(process.env.PIX_SMOKE_OUTSOURCED);
const batchLabel = `smoke-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

const summary = {
  baseUrl,
  health: null,
  ready: null,
  admin: null,
  localWriteChecks: null,
  outsourcedWriteChecks: null,
};

try {
  if (requestOutsourcedChecks && !enableWriteChecks) {
    throw new Error('PIX_SMOKE_OUTSOURCED=1 requires PIX_SMOKE_WRITE=1 because outsourced smoke checks write test activation codes');
  }

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
  const token = assertString(login.token, 'admin login token');
  summary.admin = {
    username: login.user?.username ?? adminUsername,
    role: login.user?.role ?? null,
  };

  if (enableWriteChecks) {
    summary.localWriteChecks = await runLocalWriteChecks(token);
  }

  if (requestOutsourcedChecks) {
    summary.outsourcedWriteChecks = await runOutsourcedWriteChecks(token);
  }

  console.log(JSON.stringify({ ok: true, summary }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    summary,
  }, null, 2));
  process.exitCode = 1;
}

async function runLocalWriteChecks(token) {
  const created = await requestJson('/api/admin/redemption-codes', {
    method: 'POST',
    token,
    body: { count: 2, batchLabel },
  });
  const codes = Array.isArray(created.codes) ? created.codes : [];
  if (codes.length < 2) throw new Error('local code creation returned fewer than 2 codes');

  const firstCode = assertString(codes[0].code, 'created redemption code');
  const order = await requestJson('/api/orders', {
    method: 'POST',
    body: {
      redemptionCode: firstCode,
      session: 'smoke-session-token-with-enough-length',
    },
    expectedStatus: 202,
  });
  const trackingToken = assertString(order.trackingToken, 'created order tracking token');
  const tracked = await requestJson(`/api/orders/track/${encodeURIComponent(trackingToken)}`);

  const deleted = await requestJson('/api/admin/redemption-codes/delete-unused', {
    method: 'POST',
    token,
    body: { status: 'all', archiveScope: 'active', batchLabel },
  });
  const remaining = await requestJson(`/api/admin/redemption-codes?archiveScope=all&batchLabel=${encodeURIComponent(batchLabel)}`, {
    token,
  });

  return {
    batchLabel,
    createdCodes: codes.length,
    orderStatus: order.status ?? null,
    trackedStatus: tracked.status ?? null,
    deletedUnused: deleted.deletedCount ?? null,
    remainingCodes: remaining.total ?? null,
  };
}

async function runOutsourcedWriteChecks(token) {
  const codesText = [
    `DP-SMOKE-ONE-${batchLabel}`.toUpperCase(),
    `DP-SMOKE-TWO-${batchLabel}`.toUpperCase(),
  ].join('\n');
  const imported = await requestJson('/api/admin/outsourced-activation-codes/import', {
    method: 'POST',
    token,
    body: { codesText, batchLabel },
  });
  const listed = await requestJson(`/api/admin/outsourced-activation-codes?archiveScope=active&batchLabel=${encodeURIComponent(batchLabel)}`, {
    token,
  });
  const deleted = await requestJson('/api/admin/outsourced-activation-codes/delete-unused', {
    method: 'POST',
    token,
    body: { status: 'all', archiveScope: 'active', batchLabel },
  });

  return {
    batchLabel,
    imported: imported.importedCount ?? null,
    listed: listed.total ?? null,
    deletedUnused: deleted.deletedCount ?? null,
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
  const parsed = text ? JSON.parse(text) : null;
  const expectedStatus = options.expectedStatus ?? 200;
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function parseFlag(value) {
  return value === '1' || value === 'true';
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}
