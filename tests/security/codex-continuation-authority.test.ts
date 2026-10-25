import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createPortfolio, FEATURE_ID, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { BUILD_DIR, REPO_ROOT } from '../helpers/global-setup.js';
import { authorityFile, openControllerAuthority } from '../../src/engine/authority.js';
import { capabilityMatches } from '../../src/engine/capability.js';
import { isProcessAlive, processIdentity, type ProcessIdentity } from '../../src/util/process-identity.js';
import { settlerMarker } from '../../src/engine/settler.js';
import { recordSpawn } from '../../src/sessions/registry.js';

afterAll(() => cleanupTmpRoots());

// No controllerKey/asController helper: each invocation must acquire its own
// authority through the shipped CLI, with no inherited Claude session or key.
function fixture(): Portfolio {
  const p = createPortfolio();
  writePrd(p);
  writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(portfolioGraph()));
  const file = join(p.control, 'mycelink.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.provider = { provider: 'codex', executable: process.execPath, extra_args: [] };
  config.experimental_codex = { enabled: true, disposable_repositories: ['core', 'api', 'web'] };
  writeFileSync(file, JSON.stringify(config));
  return p;
}

function invoke(p: Portfolio, extra: string[] = [], environment: Record<string, string> = {}, group = ['codex', 'continue', FEATURE_ID]) {
  const env = { ...process.env };
  for (const name of ['CLAUDE_PID', 'MYCELINK_CLAIM_TOKEN', 'MYCELINK_FAKE_CLAUDE', 'MYCELINK_CRASH_AT']) delete env[name];
  Object.assign(env, environment);
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'bin', 'mycelink.mjs'), ...group,
    '--control-root', p.control, '--json', ...extra], {
    cwd: p.control, env, encoding: 'utf8', timeout: 90_000, windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function record(p: Portfolio) {
  return JSON.parse(readFileSync(authorityFile(p.control), 'utf8')) as {
    sha256: string; holder: ProcessIdentity | null; recovered?: boolean; takeover: boolean;
  };
}

function self(): ProcessIdentity {
  const identity = processIdentity(process.pid);
  expect(identity).not.toBeNull(); // Fail closed; never skip identity checks on Windows.
  return identity!;
}

// Capture a real child identity while alive, then wait for that exact process
// to exit. No guessed dead PID and no hand-edited authority record.
function endedHolder(): ProcessIdentity {
  // pathToFileURL also handles drive letters and spaces in native Windows paths.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { pathToFileURL } from 'node:url'; const { processIdentity } = await import(pathToFileURL(process.argv[1]).href); console.log(JSON.stringify(processIdentity(process.pid)));`,
    join(BUILD_DIR, 'util', 'process-identity.js')], {
    encoding: 'utf8', timeout: 90_000, windowsHide: true,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  const identity = JSON.parse(child.stdout) as ProcessIdentity;
  expect(identity).not.toBeNull();
  expect(isProcessAlive(identity)).toBe(false);
  return identity;
}

function refusesWithoutMutation(p: Portfolio, extra: string[] = [], env: Record<string, string> = {}) {
  const before = readFileSync(authorityFile(p.control), 'utf8');
  const result = invoke(p, extra, env);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/CONTROLLER_(?:BUSY|AUTHORITY_EXISTS)|ROLE_DENIED/);
  expect(readFileSync(authorityFile(p.control), 'utf8')).toBe(before);
  expect(result.stdout).not.toMatch(/"authority"\s*:/);
}

describe('direct Codex continuation authority across native process invocations', () => {
  it('binds the first invocation and automatically recovers on the second after a failed/bounded run', () => {
    const p = fixture();
    // Node answers --version but cannot execute a Codex worker. No model use;
    // the deliberately failing downstream run still leaves resumable authority.
    const first = invoke(p, ['--max-nodes', '1']);
    const previous = record(p);
    const second = invoke(p, ['--max-nodes', '1']);
    const next = record(p);
    expect(first.status).toBe(1);
    expect(first.stderr).not.toMatch(/CODEX_GRAPH_INVALID|CODEX_RUNTIME_DENIED/);
    expect(JSON.parse(first.stdout)).toMatchObject({ stop_reason: 'NODE_NOT_DONE' });
    expect(previous.holder).toMatchObject({ pid: first.pid, host: self().host, platform: process.platform });
    expect(isProcessAlive(previous.holder!)).toBe(false);
    expect(second.stderr).not.toMatch(/CONTROLLER_AUTHORITY_EXISTS|CONTROLLER_BUSY/);
    expect(next).toMatchObject({ recovered: true, takeover: false, holder: { pid: second.pid } });
    expect(next.sha256).not.toBe(previous.sha256);
    const output = first.stdout + first.stderr + second.stdout + second.stderr;
    for (const candidate of output.match(/[0-9a-f]{64}/g) ?? []) {
      expect(capabilityMatches(candidate, previous.sha256) || capabilityMatches(candidate, next.sha256)).toBe(false);
    }
    expect(output).not.toMatch(/"authority"\s*:/);
  });

  it('refuses a still-live host, including when the caller has no CLAUDE_PID', () => {
    const p = fixture();
    openControllerAuthority(p.control, { holder: self() });
    refusesWithoutMutation(p);
  });

  it('prefers a verified live host session over the short-lived CLI process', () => {
    const p = fixture();
    invoke(p, ['--max-nodes', '1'], { CLAUDE_PID: String(process.pid) });
    expect(record(p).holder).toEqual(self());
    refusesWithoutMutation(p, [], { CLAUDE_PID: String(process.pid) });
  });

  it.each(['null', 'foreign host', 'reused pid', 'unverifiable start'] as const)('refuses a %s prior holder', (kind) => {
    const p = fixture();
    const live = self();
    const holder = kind === 'null' ? null : kind === 'foreign host' ? { ...live, host: `${live.host}.other` }
      : { ...live, start: kind === 'reused pid' ? `${live.start}-different` : '' };
    openControllerAuthority(p.control, { holder });
    refusesWithoutMutation(p);
  });

  it.each(['adapter', 'settle', 'unreadable state'] as const)('refuses recovery while %s cannot be proved safe', (kind) => {
    const p = fixture();
    openControllerAuthority(p.control, { holder: endedHolder() });
    if (kind === 'adapter') {
      recordSpawn(join(p.featureDir, 'sessions', 'registry.json'), {
        session_id: 'live-adapter', node_id: 'node', claim_id: 'claim',
        adapter: 'codex-cli', pid: process.pid, started_at: new Date().toISOString(),
        log_path: join(p.featureDir, 'adapter.log'), result_path: join(p.featureDir, 'adapter-result.json'),
      }, { featureId: FEATURE_ID, repository: 'core', worktree: null, branch: null, attempt: 1 });
    } else {
      writeFileSync(join(p.featureDir, 'STATE.json'), kind === 'unreadable state' ? '{' : JSON.stringify({
        data: { nodes: { node: { claim: { settling: settlerMarker() } } } },
      }));
    }
    refusesWithoutMutation(p);
  });

  it.each(['flag', 'environment'] as const)('denies a worker capability via %s before minting or recovery', (kind) => {
    for (const existing of [false, true]) {
      const p = fixture();
      if (existing) openControllerAuthority(p.control, { holder: endedHolder() });
      const token = 'a'.repeat(64);
      if (existing) refusesWithoutMutation(p, kind === 'flag' ? ['--capability', token] : [], kind === 'environment' ? { MYCELINK_CLAIM_TOKEN: token } : {});
      else {
        const result = invoke(p, kind === 'flag' ? ['--capability', token] : [], kind === 'environment' ? { MYCELINK_CLAIM_TOKEN: token } : {});
        expect(result.stderr).toContain('ROLE_DENIED');
        expect(() => record(p)).toThrow();
      }
    }
  });

  it('keeps generic controller open --recover strict for an unbound key and caller', () => {
    const p = fixture();
    openControllerAuthority(p.control); // Legacy/c86-style null holder remains unrecoverable.
    const before = readFileSync(authorityFile(p.control), 'utf8');
    const result = invoke(p, ['--recover'], {}, ['controller', 'open']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CONTROLLER_BUSY');
    expect(readFileSync(authorityFile(p.control), 'utf8')).toBe(before);
    expect(() => openControllerAuthority(p.control, { recover: true, holder: self() })).toThrow(/CONTROLLER_BUSY/);
  });
});
