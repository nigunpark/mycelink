/**
 * Apply the maintainers' reference implementation of the refunds feature to a
 * scaffolded workspace. Used only by tools/selftest.mjs to prove that the
 * acceptance suite is passable and that the verifier accepts a correct
 * delivery; it is never copied into an evaluation workspace.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSUMERS, MODULES, git } from './scaffold.mjs';

const LIB = dirname(fileURLToPath(import.meta.url));

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

function overlay(from, to) {
  for (const rel of listFiles(from)) {
    const target = join(to, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(from, ...rel.split('/')), 'utf8'));
  }
}

const COMMIT_TIME = Date.parse('2026-10-01T12:00:00Z');

/** Returns the delivered HEAD SHA per module. */
export function applyReference(root, scenario) {
  const repos = join(root, 'repos');
  if (scenario === 'greenfield') {
    // Build the pre-existing codebase first; greenfield repos only hold a README.
    for (const name of MODULES) {
      overlay(join(LIB, 'ledgerline', name), join(repos, name));
      if (CONSUMERS.includes(name)) {
        const shared = join(LIB, 'ledgerline', '_consumer');
        mkdirSync(join(repos, name, 'scripts'), { recursive: true });
        cpSync(join(shared, 'sync-core.mjs'), join(repos, name, 'scripts', 'sync-core.mjs'));
        cpSync(join(shared, 'vendor-lock.test.mjs'), join(repos, name, 'test', 'vendor-lock.test.mjs'));
      }
    }
  }
  for (const name of MODULES) overlay(join(LIB, 'reference-solution', name), join(repos, name));

  const shas = {};
  git(join(repos, 'core'), ['add', '--all']);
  git(join(repos, 'core'), ['commit', '--quiet', '--no-verify', '-m', 'ledger-core 1.5.0: refunds'], { time: COMMIT_TIME });
  shas.core = git(join(repos, 'core'), ['rev-parse', 'HEAD']).stdout;
  for (const name of CONSUMERS) {
    const dir = join(repos, name);
    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'sync-core.mjs'), join(repos, 'core')], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0) throw new Error(`sync-core failed in ${name}: ${r.stderr}`);
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '--no-verify', '-m', `${name}: refunds`], { time: COMMIT_TIME + 60_000 });
    shas[name] = git(dir, ['rev-parse', 'HEAD']).stdout;
  }
  return shas;
}
