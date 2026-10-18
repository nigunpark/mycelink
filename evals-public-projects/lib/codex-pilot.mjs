// Model-free Codex PRD pilot plan. This is a denial gate, NOT a model runner.
// A safe host transaction and an independent verifier must precede activation.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { casePrompt } from './cases.mjs';
import { findPrd, loadSuite, sourceIdentity } from './manifests.mjs';

const IDS = ['CSET-202', 'PCM-101'];
const REQUIRED = ['mycelink-prd', 'mycelink-dispatch', 'mycelink-worker', 'mycelink-settle', 'mycelink-deliver'];
const inside = (path, root) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)); };
const q = (value) => JSON.stringify(value);

export function pilotPlan({ suiteRoot, pluginRoot, runRoot, cacheRoot }) {
  const suitePath = resolve(suiteRoot);
  const pluginPath = resolve(pluginRoot);
  const runPath = resolve(runRoot);
  const cachePath = resolve(cacheRoot ?? join(dirname(runPath), 'codex-pilot-cache'));
  if (inside(runPath, suitePath) || inside(suitePath, runPath)) throw new Error('run root must be outside the suite (no ancestor overlap)');
  if (inside(runPath, pluginPath) || inside(pluginPath, runPath)) throw new Error('run root must be outside the plugin');
  if (inside(runPath, cachePath) || inside(cachePath, runPath)) throw new Error('run root must be separate from evaluator cache');
  const suite = loadSuite(suitePath);
  if (suite.problems.length) throw new Error(`invalid benchmark suite: ${suite.problems.join('; ')}`);
  const repo = resolve(suitePath, '..');
  if (inside(runPath, repo) || inside(repo, runPath)) throw new Error('run root must be outside the development checkout');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  if (head.status !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) throw new Error('suite needs a Git HEAD');
  const commit = head.stdout.trim();
  const status = spawnSync('git', ['status', '--porcelain', '--', 'evals-public-projects'], { cwd: repo, encoding: 'utf8' });
  const skillsRoot = join(pluginPath, 'skills');
  const skills = existsSync(skillsRoot) ? readdirSync(skillsRoot) : [];
  const blockers = [];
  if (status.status !== 0 || status.stdout.trim()) blockers.push('suite checkout is not clean; commit and re-pin before verification');
  if (!existsSync(join(pluginPath, 'plugin.json')) || !skills.includes('mycelink-status')) blockers.push('isolated Codex plugin discovery is unavailable');
  if (REQUIRED.some((name) => !skills.includes(name))) blockers.push('codex-plugin: no approved PRD/dispatch/worker/settle/delivery runtime');
  // Deliberately not derived from a caller flag or presence of credentials. The
  // unconditional production preflight denial cannot be overridden here.
  blockers.push('production Codex dispatch remains fail-closed');
  blockers.push('Windows Session 0 CurrentUser DPAPI and Windows-to-WSL transaction require independent gate approval');
  const cases = IDS.map((id) => {
    const found = findPrd(suite, id);
    if (!found) throw new Error(`missing approved PRD ${id}`);
    const { project, prd } = found;
    if (sourceIdentity(project.lock) !== project.lock.identity_sha256) throw new Error(`${id}: source lock changed`);
    const evaluatorLock = JSON.parse(readFileSync(join(prd.dir, 'evaluator.lock.json'), 'utf8'));
    if (evaluatorLock.source_identity_sha256 !== project.lock.identity_sha256 || evaluatorLock.prd !== id) throw new Error(`${id}: evaluator lock is not bound to source`);
    const folder = join(runPath, id);
    const workspace = join(folder, 'agent', 'workspace');
    const codexHome = join(folder, 'agent', 'codex-home');
    const verifier = join(folder, 'evaluator');
    const args = ['node', join(suitePath, 'tools', 'verify-run.mjs'), '--workspace', workspace, '--case', id,
      '--require-mycelink', '--require-tdd', '--suite-root', suitePath, '--expect-suite-commit', commit,
      '--cache-root', cachePath, '--work-dir', verifier];
    return {
      prd: id, case: prd.manifest.case, ready: false,
      source: { commit: project.lock.commit, tree: project.lock.tree, identity: project.lock.identity_sha256,
        bundle: join(cachePath, 'sources', project.lock.bundle.file) },
      agent: { workspace, codexHome, prompt: casePrompt(found), requirement: `platform/requirements/${id}.md`,
        repository: project.adapter.workspace.repo_dir },
      evaluator: { workspace: verifier, command: args.map(q).join(' '),
        policy: 'operator only; never mount the suite, cache, verifier, locks or reference into the worker namespace' },
    };
  });
  return { schema: 'mycelink-codex-pilot-plan@1', ready: false, suiteCommit: commit, pluginRoot: pluginPath,
    blockers, cases, note: 'No Codex execution is authorized by this plan. Do not invoke the verifier on Windows.' };
}
