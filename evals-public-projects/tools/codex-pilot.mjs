#!/usr/bin/env node
// Read-only, model-free Codex public-project pilot readiness probe.
// Exit 1 while dispatch is denied; never starts an agent or touches CODEX_HOME.
import { resolve } from 'node:path';
import { pilotPlan } from '../lib/codex-pilot.mjs';
import { suiteRoot } from '../lib/manifests.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
if (!arg('--run-root') || !arg('--plugin-root')) {
  console.error('usage: node evals-public-projects/tools/codex-pilot.mjs --run-root <outside-checkout-dir> --plugin-root <extracted-codex-plugin-dir> [--cache-root <operator-only-dir>]');
  process.exitCode = 2;
} else {
  try {
    const plan = pilotPlan({ suiteRoot: suiteRoot(), pluginRoot: resolve(arg('--plugin-root')),
      runRoot: resolve(arg('--run-root')), ...(arg('--cache-root') ? { cacheRoot: resolve(arg('--cache-root')) } : {}) });
    console.log(JSON.stringify(plan, null, 2));
    process.exitCode = plan.ready ? 0 : 1;
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode = 2;
  }
}
