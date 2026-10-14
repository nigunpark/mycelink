#!/usr/bin/env node
/**
 * ORD-101's acceptance criteria, checked from outside both repositories.
 *
 *   node examples/quickstart/acceptance/probe.mjs <orders-api checkout> <orders-web checkout> [--json]
 *
 * Imports each repository's public module from the given checkout and
 * checks AC-1..AC-4 exactly as the PRD words them. It is not one of the
 * repositories' own tests and no worker ever sees it: on the baselines every
 * criterion fails (the feature is not pre-solved); on the delivered commits
 * of a finished run every criterion passes. Exit 0 only when all four pass.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deepStrictEqual } from 'node:assert/strict';

const [apiDir, webDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const json = process.argv.includes('--json');
if (apiDir === undefined || webDir === undefined) {
  process.stderr.write('Usage: node probe.mjs <orders-api checkout> <orders-web checkout> [--json]\n');
  process.exit(2);
}

async function load(dir, rel) {
  const file = join(resolve(dir), ...rel.split('/'));
  if (!existsSync(file)) throw new Error(`${rel} is missing from ${dir}`);
  return import(pathToFileURL(file).href);
}

const api = await load(apiDir, 'orders/src/order-status.js');
const web = await load(webDir, 'ui/src/status-line.js');

/** Each check returns nothing or throws with what it saw. */
const CHECKS = {
  'AC-1': () => {
    deepStrictEqual(api.toStatusPayload({ id: 'A-7', state: 'delayed', eta: '2026-11-03' }), { version: 2, id: 'A-7', status: 'delayed', eta: '2026-11-03' });
    for (const state of ['placed', 'shipped', 'delivered']) {
      const p = api.toStatusPayload({ id: 'A-1', state });
      if (p.version !== 2 || Object.hasOwn(p, 'eta')) throw new Error(`${state}: ${JSON.stringify(p)}`);
    }
  },
  'AC-2': () => {
    for (const eta of [undefined, '03/11/2026', '2026-02-30']) {
      let thrown = null;
      try {
        api.toStatusPayload({ id: 'B-2', state: 'delayed', eta });
      } catch (err) {
        thrown = err;
      }
      if (!(thrown instanceof RangeError) || !thrown.message.includes('B-2')) throw new Error(`eta ${JSON.stringify(eta)}: ${thrown === null ? 'published a payload' : `${thrown.name}: ${thrown.message}`}`);
    }
  },
  'AC-3': () => {
    const line = web.statusLine({ version: 2, id: 'A-7', status: 'delayed', eta: '2026-11-03' });
    if (line !== 'Order A-7: Delayed, now expected 2026-11-03') throw new Error(JSON.stringify(line));
  },
  'AC-4': () => {
    for (const payload of [{ version: 2, id: 'C-4', status: 'teleported' }, { version: 2, id: 'C-4' }]) {
      const line = web.statusLine(payload);
      if (line !== 'Order C-4: Status unavailable') throw new Error(`${JSON.stringify(payload)} -> ${JSON.stringify(line)}`);
    }
  },
};

const results = [];
for (const [id, check] of Object.entries(CHECKS)) {
  try {
    check();
    results.push({ criterion: id, pass: true });
  } catch (err) {
    results.push({ criterion: id, pass: false, detail: String(err?.message ?? err).split('\n')[0].slice(0, 160) });
  }
}
const passed = results.filter((r) => r.pass).length;
if (json) process.stdout.write(JSON.stringify({ passed, total: results.length, results }, null, 2) + '\n');
else {
  for (const r of results) process.stdout.write(`${r.pass ? 'pass' : 'FAIL'} ${r.criterion}${r.pass ? '' : `  ${r.detail}`}\n`);
  process.stdout.write(`${passed}/${results.length} acceptance criteria pass\n`);
}
process.exitCode = passed === results.length ? 0 : 1;
