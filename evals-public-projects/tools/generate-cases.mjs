#!/usr/bin/env node
/**
 * Generate the `claude plugin eval` cases from the committed manifests.
 *
 *   node evals-public-projects/tools/generate-cases.mjs          write cases/<case>/{case.yaml,scaffold.sh}
 *   node evals-public-projects/tools/generate-cases.mjs --check  fail (exit 1) on any drift
 *
 * The output is deterministic; CI and the self-test run --check.
 */
import { join } from 'node:path';
import { caseDrift, generateCases, writeCases } from '../lib/cases.mjs';
import { parseArgs, runTool } from '../lib/cli.mjs';
import { loadSuite, suiteRoot } from '../lib/manifests.mjs';

export async function main(argv) {
  const { flags } = parseArgs(argv, { booleans: ['check'] });
  const suite = loadSuite();
  if (suite.problems.length) return { ok: false, problems: suite.problems };
  const dir = join(suiteRoot(), 'cases');
  const cases = [...new Set([...generateCases(suite).keys()].map((k) => k.split('/')[0]))].sort();
  if (flags.check) {
    const drift = caseDrift(suite, dir);
    return { ok: drift.length === 0, mode: 'check', cases, drift };
  }
  writeCases(suite, dir);
  return { ok: true, mode: 'write', cases, drift: [] };
}

runTool(import.meta.url, main);
