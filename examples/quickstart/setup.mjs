#!/usr/bin/env node
/**
 * Mycelink quickstart: create the demo workspace.
 *
 *   node setup.mjs <new-directory>
 *
 * Creates three Git repositories, each with one commit on `main`:
 *
 *   <dir>/pricing      a tiny zero-dependency Node library (node --test)
 *   <dir>/storefront   a second one that renders what pricing computes
 *   <dir>/control      the coordination (control) repository, holding only
 *                      the approved requirement requirements/FEAT-101.md
 *
 * It runs `git` (argv only, no shell) and nothing else: no Mycelink command,
 * no model, no network. The directory must not exist yet.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
if (!target) {
  process.stderr.write('usage: node setup.mjs <new-directory>\n');
  process.exit(2);
}
const root = resolve(target);
if (existsSync(root)) {
  process.stderr.write(`${root} already exists; choose a new directory.\n`);
  process.exit(2);
}

// The seed commits carry a fixed identity, so setup works before you configure Git.
const SEED = ['-c', 'user.name=Mycelink Quickstart', '-c', 'user.email=quickstart@example.invalid', '-c', 'commit.gpgsign=false'];
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr || r.error?.message || ''}\n`);
    process.exit(1);
  }
}
function seed(dir, message) {
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'add', '-A');
  git(dir, ...SEED, 'commit', '--quiet', '-m', message);
}

for (const name of ['pricing', 'storefront']) {
  cpSync(join(here, 'repos', name), join(root, name), { recursive: true });
  seed(join(root, name), `${name}: initial version`);
}
mkdirSync(join(root, 'control', 'requirements'), { recursive: true });
cpSync(join(here, 'requirements', 'FEAT-101.md'), join(root, 'control', 'requirements', 'FEAT-101.md'));
seed(join(root, 'control'), 'requirement FEAT-101 approved');

process.stdout.write(
  [
    `Created ${root}`,
    '  pricing/     storefront/     control/requirements/FEAT-101.md',
    '',
    'Next: start Claude Code in that directory and paste the prompt from',
    'examples/quickstart/README.md (step 3).',
    '',
  ].join('\n'),
);
