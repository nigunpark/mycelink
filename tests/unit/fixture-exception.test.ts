import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateGraph } from '../../src/graph/validate.js';
import { buildContextPack } from '../../src/sessions/context-pack.js';
import { buildHostWorkerPrompt, buildWorkerPrompt } from '../../src/sessions/worker-protocol.js';
import { executeHostClaimGate } from '../../src/sessions/codex-host-gate.js';
import { CodexCliAdapter, windowsToWslPath } from '../../src/sessions/codex-cli-adapter.js';
import { clone, VALID_GRAPH } from '../helpers/graph-fixtures.js';
import { initialState } from '../../src/state/feature-state.js';
import { minimalPack } from '../helpers/context-pack.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function fixture(manifestName = 'frozen-build.json', baselineName = 'frozen-build') {
  const root = mkdtempSync(join(tmpdir(), 'mycelink-fixture-')); roots.push(root);
  const control = join(root, 'control'), baseline = join(root, baselineName);
  mkdirSync(control); mkdirSync(baseline);
  const git = (...a: string[]) => execFileSync('git', ['-C', baseline, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
  writeFileSync(join(baseline, 'pnpm-lock.yaml'), 'fixture lock\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  const manifest = join(root, manifestName);
  writeFileSync(manifest, JSON.stringify({ schema: 'mycelink-frozen-git-build/1', frozen_sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), lock_git_blob: git('rev-parse', 'HEAD:pnpm-lock.yaml'), baseline_windows_root: baseline, baseline_wsl_root: process.platform === 'win32' ? windowsToWslPath(baseline) : baseline, files_sha256: { 'pnpm-lock.yaml': hash('fixture lock\n') }, dependency_audit: { paths: 1, root_confined: true }, build_receipts_sha256: { install: 'a'.repeat(64), build: 'b'.repeat(64) } }));
  const declaration = { manifest: `../${manifestName}`, baseline: `../${baselineName}`, sha256: hash(readFileSync(manifest)) };
  const graph: any = clone(VALID_GRAPH), nodeId = graph.nodes[1].id;
  graph.nodes[1].readonly_fixture = declaration;
  const args: any = { graph, state: initialState(graph, 'a'.repeat(64)), nodeId, claimId: 'claim-1', controlRoot: control, maxBytes: 32000 };
  return { root, control, baseline, manifest, declaration, args };
}
it('verifies a graph-declared sibling fixture and emits exact read-only paths and hash', () => {
  const f = fixture(); const pack: any = buildContextPack(f.args);
  expect(pack.readonly_fixture).toEqual({ manifest: f.manifest, baseline: f.baseline, sha256: f.declaration.sha256 });
  const prompt = buildWorkerPrompt({ pack, gates: [], provider: 'codex' });
  expect(prompt.includes('READ-ONLY fixture exception')).toBe(true);
  expect(prompt.includes(JSON.stringify(f.manifest))).toBe(true); expect(prompt.includes(f.declaration.sha256)).toBe(true);
});
it('keeps the blanket prohibition without a declaration, ignoring environment authority', () => {
  const prompt = buildWorkerPrompt({ pack: minimalPack(), gates: [], provider: 'codex' });
  expect(prompt.includes('those reads are not approved')).toBe(true);
  expect(prompt.includes('READ-ONLY fixture exception')).toBe(false);
});
it.each(['hash', 'path', 'manifest-symlink', 'baseline-symlink', 'bytes', 'content'] as const)('rejects invalid fixture %s before producing a pack', kind => {
  const f = fixture();
  if (kind === 'hash') f.declaration.sha256 = '0'.repeat(64);
  if (kind === 'path') f.declaration.manifest = '../../AC5-FIXTURE.json';
  if (kind === 'manifest-symlink' || kind === 'baseline-symlink') {
    const outside = mkdtempSync(join(tmpdir(), 'mycelink-fixture-outside-')); roots.push(outside);
    const source = kind === 'manifest-symlink' ? f.manifest : f.baseline;
    const target = join(outside, kind === 'manifest-symlink' ? 'AC5-FIXTURE.json' : 'baseline');
    renameSync(source, target);
    symlinkSync(target, source, kind === 'manifest-symlink' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir');
  }
  if (kind === 'bytes') writeFileSync(join(f.baseline, 'pnpm-lock.yaml'), 'changed');
  if (kind === 'content') { writeFileSync(f.manifest, '{}'); f.declaration.sha256 = hash('{}'); }
  expect(() => buildContextPack(f.args)).toThrow(/FIXTURE/);
});
it('maps verified Windows fixture paths through the WSL mapper', () => {
  const adapter = new CodexCliAdapter({ executable: 'codex', disposableRepositories: true });
  (adapter as any).options.wsl = { distribution: 'Ubuntu', user: 'tester' };
  const prompt = (adapter as any).workerPrompt(minimalPack({ readonly_fixture: { manifest: 'C:/pilot/AC5-FIXTURE.json', baseline: 'C:/pilot/baseline', sha256: 'a'.repeat(64) } } as any), {});
  expect(prompt.includes('/mnt/c/pilot/AC5-FIXTURE.json')).toBe(true);
  expect(prompt.includes('/mnt/c/pilot/baseline')).toBe(true);
  expect(prompt).toContain('Controller-verified READ-ONLY fixture exception');
  expect(prompt.split('<mycelink-context-pack>')[0]).not.toContain('C:/pilot/');
});

it.each([false, undefined])('denies fixture prompt dispatch without affirmative disposable opt-in (%s)', disposableRepositories => {
  const f = fixture();
  const pack = buildContextPack(f.args);
  const adapter = new CodexCliAdapter({ executable: 'codex', disposableRepositories });
  // workerPrompt runs before buildArgs, worker services, or child dispatch.
  expect(() => (adapter as any).workerPrompt(pack, {})).toThrow(/FIXTURE_SCOPE_DENIED/);
});

it.each(['claude', 'default', 'host'] as const)('does not grant the fixture exception to %s workers', provider => {
  const f = fixture();
  const pack = buildContextPack(f.args);
  let prompt: string;
  try {
    prompt = provider === 'host'
      ? buildHostWorkerPrompt({ pack, worktree: f.control, resultSlot: join(f.control, '.mycelink-worker', 'result.json'), gates: [] })
      : buildWorkerPrompt({ pack, gates: [], ...(provider === 'claude' ? { provider: 'claude' as const } : {}) });
  } catch (error) {
    expect(String(error)).toMatch(/FIXTURE_SCOPE_DENIED/);
    return;
  }
  expect(prompt).not.toContain('READ-ONLY fixture exception');
});

it('allows only the verified exact fixture while prohibiting undeclared environment and outside reads', () => {
  const f = fixture();
  const pack = buildContextPack(f.args);
  const adapter = new CodexCliAdapter({ executable: 'codex', disposableRepositories: true });
  const prompt: string = (adapter as any).workerPrompt(pack, {});
  const instructions = prompt.split('<mycelink-context-pack>')[0]!;
  expect(instructions).toContain('Controller-verified READ-ONLY fixture exception');
  expect(instructions).toContain(JSON.stringify(f.manifest));
  expect(instructions).toContain(JSON.stringify(f.baseline));
  expect(instructions).toMatch(/undeclared[^\n]*(?:environment|outside)[^\n]*(?:prohibited|not approved|forbidden)/i);
  expect(instructions).toMatch(/(?:except|exception)[^\n]*(?:verified|fixture)|verified[^\n]*exception/i);
  expect(instructions).not.toContain('there is nothing there for you, and those reads are not approved.');
  expect(instructions).toContain('No writes or other outside access are granted.');
});

it.each(['codex', 'claude'] as const)('preserves the no-fixture %s read prohibition verbatim', provider => {
  const prompt = buildWorkerPrompt({ pack: minimalPack(), gates: [], provider });
  expect(prompt).toContain('Everything you need is in this prompt. Do not look for your brief in environment variables or in files outside\nyour working directory: there is nothing there for you, and those reads are not approved.');
  expect(prompt).not.toContain('READ-ONLY fixture exception');
});
it('fails closed on fixture tampering before launching a mediated host gate', () => {
  const f = fixture(); buildContextPack(f.args);
  writeFileSync(join(f.baseline, 'pnpm-lock.yaml'), 'tampered');
  const marker = join(f.root, 'launched');
  const result = executeHostClaimGate({ controlRoot: f.control, featureId: 'FEAT-101', gate: 'green', cwd: f.control, argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`], deadlineMs: 1000, readRecord: () => undefined, readonlyFixture: f.declaration } as any);
  expect(result.output).toContain('FIXTURE');
  expect(() => readFileSync(marker)).toThrow();
});

it.each([['snapshot-one.json', 'snapshot-one'], ['other_build.json', 'other_build']])('accepts generic sibling declaration %s / %s', (manifest, baseline) => {
  const f = fixture(manifest, baseline);
  expect(validateGraph(f.args.graph).problems.filter(p => p.code.startsWith('FIXTURE'))).toEqual([]);
  expect(buildContextPack(f.args).readonly_fixture?.baseline).toBe(f.baseline);
});
it.each(['../../escape.json', '/absolute.json', '../nested/file.json', '../..', '../CON.json', '../bad:name.json', '../bad\\name.json', '//server/share', '\\\\?\\C:\\escape'])('rejects unsafe declaration %s', path => {
  for (const field of ['manifest', 'baseline'] as const) {
    const f = fixture(); f.declaration[field] = path;
    expect(validateGraph(f.args.graph).problems.some(p => p.code === 'FIXTURE_PATH_INVALID')).toBe(true);
    expect(() => buildContextPack(f.args)).toThrow(/FIXTURE/);
  }
});
it.each(['node_modules', 'packages/example/node_modules'])('rechecks external dependency links at %s before pack and host launch', dependencyPath => {
  const f = fixture(); buildContextPack(f.args);
  const outside = mkdtempSync(join(tmpdir(), 'outside-dependency-')); roots.push(outside);
  writeFileSync(join(outside, 'command.js'), 'dummy');
  const modules = join(f.baseline, dependencyPath); mkdirSync(modules, { recursive: true });
  symlinkSync(outside, join(modules, 'external-command'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => buildContextPack(f.args)).toThrow(/FIXTURE/);
  const marker = join(f.root, 'launched');
  const result = executeHostClaimGate({ controlRoot: f.control, featureId: 'FEAT-101', gate: 'green', cwd: f.control, argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`], deadlineMs: 1000, readRecord: () => undefined, readonlyFixture: f.declaration } as any);
  expect(result.output).toContain('FIXTURE'); expect(() => readFileSync(marker)).toThrow();
});
it('requires an affirmative dependency audit', () => {
  const f = fixture(); const m = JSON.parse(readFileSync(f.manifest, 'utf8'));
  m.dependency_audit.root_confined = false;
  writeFileSync(f.manifest, JSON.stringify(m)); f.declaration.sha256 = hash(readFileSync(f.manifest));
  expect(() => buildContextPack(f.args)).toThrow(/FIXTURE/);
});

it.each(['schema', 'baseline_windows_root', 'baseline_wsl_root', 'frozen_sha', 'tree', 'lock_git_blob', 'files_sha256'])('rejects resealed invalid manifest identity %s', field => {
  const f = fixture(); const m = JSON.parse(readFileSync(f.manifest, 'utf8'));
  m[field] = field === 'files_sha256' ? { 'pnpm-lock.yaml': '0'.repeat(64) } : field.endsWith('_root') ? join(f.root, 'wrong-root') : '0'.repeat(40);
  writeFileSync(f.manifest, JSON.stringify(m)); f.declaration.sha256 = hash(readFileSync(f.manifest));
  expect(() => buildContextPack(f.args)).toThrow(/FIXTURE/);
});
it('accepts confined dependency links and terminates cycles', () => {
  const f = fixture(); const modules = join(f.baseline, 'node_modules');
  const local = join(modules, 'local'); mkdirSync(local, { recursive: true });
  writeFileSync(join(local, 'command.js'), 'dummy');
  symlinkSync(local, join(modules, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(modules, join(local, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(buildContextPack(f.args).readonly_fixture?.baseline).toBe(f.baseline);
});
it.each(['node_modules', 'packages/example/node_modules'])('rejects an external dependency root %s', dependencyPath => {
  const f = fixture(); const outside = mkdtempSync(join(tmpdir(), 'outside-dependency-')); roots.push(outside);
  const modules = join(f.baseline, dependencyPath); mkdirSync(join(modules, '..'), { recursive: true });
  symlinkSync(outside, modules, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => buildContextPack(f.args)).toThrow(/FIXTURE/);
});
