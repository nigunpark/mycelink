/**
 * Black-box harness for the Ledgerline acceptance suite.
 *
 * Tests never import service internals. They start the real processes from
 * a snapshot of each module repository's HEAD commit (prepared by run.mjs and
 * passed in ACCEPTANCE_SYSTEM_DIR):
 *
 *   <system>/api/bin/ledger-api.mjs        HTTP API
 *   <system>/worker/bin/ledger-worker.mjs  background worker (--once)
 *   <system>/cli/bin/ledger.mjs            operator CLI
 *   <system>/core/src/index.mjs            shared contracts (imported only
 *                                          for contract validation)
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

export function systemDir() {
  const dir = process.env.ACCEPTANCE_SYSTEM_DIR;
  if (!dir) throw new Error('ACCEPTANCE_SYSTEM_DIR is not set; run the suite through acceptance/run.mjs');
  return dir;
}

export async function importCore() {
  return import(pathToFileURL(join(systemDir(), 'core', 'src', 'index.mjs')).href);
}

export async function newDataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-accept-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function collect(child) {
  const out = { stdout: '', stderr: '' };
  child.stdout?.setEncoding('utf8').on('data', (d) => (out.stdout += d));
  child.stderr?.setEncoding('utf8').on('data', (d) => (out.stderr += d));
  return out;
}

function waitExit(child, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Start one API process on a free port. Stopped automatically after the test. */
export async function startApi(t, dataDir) {
  const child = spawn(process.execPath, [join(systemDir(), 'api', 'bin', 'ledger-api.mjs')], {
    cwd: join(systemDir(), 'api'),
    env: { ...process.env, LEDGER_DATA_DIR: dataDir, LEDGER_PORT: '0', LEDGER_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const out = collect(child);
  const exited = waitExit(child, 600_000, 'ledger-api').catch(() => null);
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const line of out.stdout.split('\n')) {
      try {
        const parsed = JSON.parse(line);
        if (parsed?.event === 'listening' && typeof parsed.url === 'string') return { url: parsed.url, out };
      } catch {
        // not a JSON line
      }
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `ledger-api did not print {"event":"listening","url":...} within 15 s\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`,
  );
}

/** Run `ledger-worker --once` to completion. */
export async function runWorker(dataDir, { delayMs = 0, timeoutMs = 90_000 } = {}) {
  const child = spawn(process.execPath, [join(systemDir(), 'worker', 'bin', 'ledger-worker.mjs'), '--once'], {
    cwd: join(systemDir(), 'worker'),
    env: { ...process.env, LEDGER_DATA_DIR: dataDir, LEDGER_GATEWAY_DELAY_MS: String(delayMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const out = collect(child);
  const code = await waitExit(child, timeoutMs, 'ledger-worker --once');
  return { code, ...out };
}

export async function runWorkerOk(dataDir, options) {
  const result = await runWorker(dataDir, options);
  assert.equal(result.code, 0, `ledger-worker --once exited ${result.code}\n${result.stderr}`);
  return result;
}

/** Run the operator CLI. `json` is the parsed stdout when it is JSON. */
export async function runCli(args, { apiUrl, timeoutMs = 30_000 } = {}) {
  const child = spawn(process.execPath, [join(systemDir(), 'cli', 'bin', 'ledger.mjs'), ...args], {
    cwd: join(systemDir(), 'cli'),
    env: { ...process.env, LEDGER_API_URL: apiUrl ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const out = collect(child);
  const code = await waitExit(child, timeoutMs, `ledger ${args.join(' ')}`);
  const parse = (text) => {
    try {
      return JSON.parse(text.trim().split('\n').filter(Boolean).at(-1) ?? '');
    } catch {
      return undefined;
    }
  };
  return { code, stdout: out.stdout, stderr: out.stderr, json: parse(out.stdout), errorJson: parse(out.stderr) };
}

export async function http(baseUrl, method, path, body, headers = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, body: json, text };
}

export async function gatewayCalls(dataDir) {
  const text = await readFile(join(dataDir, 'gateway', 'calls.jsonl'), 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** Create an order through the API and capture it through the worker. */
export async function paidOrder(apiUrl, dataDir, amount_cents, currency = 'USD') {
  const created = await http(apiUrl, 'POST', '/orders', { amount_cents, currency });
  assert.equal(created.status, 201, `POST /orders -> ${created.status} ${created.text}`);
  const id = created.body.order.order_id;
  const capture = await http(apiUrl, 'POST', `/orders/${id}/capture`);
  assert.equal(capture.status, 202, `capture -> ${capture.status} ${capture.text}`);
  await runWorkerOk(dataDir);
  const order = await http(apiUrl, 'GET', `/orders/${id}`);
  assert.equal(order.body.order.status, 'paid', `order should be paid, got ${order.text}`);
  return order.body.order;
}

export function refundPost(apiUrl, orderId, body, key) {
  const headers = key === undefined ? {} : { 'idempotency-key': key };
  return http(apiUrl, 'POST', `/orders/${encodeURIComponent(orderId)}/refunds`, body, headers);
}

export async function listRefunds(apiUrl, orderId) {
  const res = await http(apiUrl, 'GET', `/orders/${encodeURIComponent(orderId)}/refunds`);
  assert.equal(res.status, 200, `GET refunds -> ${res.status} ${res.text}`);
  assert.ok(Array.isArray(res.body?.refunds), `GET refunds must return {"refunds":[...]}, got ${res.text}`);
  return res.body.refunds;
}

export async function orderEvents(apiUrl, orderId) {
  const res = await http(apiUrl, 'GET', `/orders/${encodeURIComponent(orderId)}/events`);
  assert.equal(res.status, 200, `GET events -> ${res.status} ${res.text}`);
  return res.body.events;
}

export async function assertEventsValid(apiUrl, orderId) {
  const core = await importCore();
  const events = await orderEvents(apiUrl, orderId);
  for (const event of events) {
    assert.deepEqual(core.validateEvent(event).errors, [], `event ${event.type} violates the core contract`);
  }
  return events;
}
