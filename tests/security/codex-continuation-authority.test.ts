import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
import { initialState, loadState, saveState } from '../../src/state/feature-state.js';
import { loadGraph, validateFeatureGraph } from '../../src/workspace/workspace.js';
import { appendEvent, readEvents } from '../../src/state/event-log.js';
import { markDecisionApplied } from '../../src/state/decisions.js';

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

const pendingId = 'DEC-12345678';
const pendingNode = `${FEATURE_ID}.core.publish.impl`;
const exactAnswer = 'Allow offline frozen-lockfile pnpm installs only in test-harness-owned temporary full-source clones; never in the worker coding checkout.';

// Reproduce the durable shape written by recordDecisionRequest, without
// opening authority or running/installing anything in the coding checkout.
function pendingFixture(evidence = true): Portfolio {
  const p = fixture();
  const state = initialState(loadGraph(p.control, FEATURE_ID), validateFeatureGraph(p.control, FEATURE_ID).graphHash);
  state.feature_state = 'NEEDS_DECISION';
  state.pending_decisions = [pendingId];
  state.nodes[pendingNode]!.state = 'NEEDS_DECISION';
  state.nodes[pendingNode]!.blocked_reason = 'Graph exception needs manager choice';
  saveState(p.featureDir, state);
  if (evidence) {
    writeFileSync(join(p.featureDir, 'DECISIONS.md'), `# Decisions for ${FEATURE_ID}\n\n## ${pendingId} (graph exception)\n\n- Node: \`${pendingNode}\`\n- Status: PENDING\n- Question: Permit the narrow offline test harness exception?\n  - [ ] ${exactAnswer}\n  - [ ] Keep installs prohibited and stop\n\n`);
    appendEvent(join(p.featureDir, 'events.jsonl'), {
      idempotency_key: `decision.requested:${pendingId}`,
      type: 'decision.requested', actor: 'mycelink', feature_id: FEATURE_ID,
      node_id: pendingNode, data: { decision_id: pendingId, category: 'graph exception' },
    });
  }
  return p;
}

function decisionSnapshot(p: Portfolio) {
  return ['STATE.json', 'DECISIONS.md', 'events.jsonl'].map((name) => {
    const path = join(p.featureDir, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  });
}

function assertAnswerRejected(p: Portfolio, flags: string[], env: Record<string, string> = {}) {
  const before = decisionSnapshot(p);
  const authorityBefore = existsSync(authorityFile(p.control)) ? readFileSync(authorityFile(p.control), 'utf8') : null;
  const result = invoke(p, flags, env);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/DECISION|ROLE_DENIED/);
  expect(decisionSnapshot(p)).toEqual(before);
  expect(existsSync(authorityFile(p.control)) ? readFileSync(authorityFile(p.control), 'utf8') : null).toBe(authorityBefore);
}

describe('Codex manager answers a pending choice inside continuation authority', () => {
  it.each([false, true])('records/applies then dispatches READY under the held authority (recover=%s)', (recover) => {
    const p = pendingFixture();
    if (recover) openControllerAuthority(p.control, { holder: endedHolder() });
    const result = invoke(p, ['--answer-decision', pendingId, '--answer', exactAnswer, '--max-nodes', '1']);
    // The Node executable intentionally cannot run a Codex worker. A report
    // proves dispatch was reached after unblocking, without paid model use.
    expect(result.stderr).not.toMatch(/CODEX_RUNTIME_DENIED|DECISION_NOT_RECORDED|CONTROLLER_AUTHORITY_EXISTS/);
    expect(JSON.parse(result.stdout)).toMatchObject({ reports: [{ node_id: pendingNode }] });
    expect(loadState(p.featureDir)!.data.pending_decisions).toEqual([]);
    const decisions = readEvents(join(p.featureDir, 'events.jsonl')).filter((e) => e.type === 'decision.recorded' || e.type === 'decision.applied');
    expect(decisions.map((e) => e.type)).toEqual(['decision.recorded', 'decision.applied']);
    expect(decisions.map((e) => e.data)).toEqual(expect.arrayContaining([expect.objectContaining({ decision_id: pendingId })]));
    expect(readFileSync(join(p.featureDir, 'DECISIONS.md'), 'utf8')).toContain(`### ${pendingId} ANSWERED`);
    expect(record(p)).toMatchObject({ holder: { pid: result.pid }, takeover: false, ...(recover ? { recovered: true } : {}) });
    const output = result.stdout + result.stderr + readFileSync(join(p.featureDir, 'events.jsonl'), 'utf8');
    expect(output).not.toMatch(/"authority"\s*:/);
    for (const candidate of output.match(/[0-9a-f]{64}/g) ?? []) expect(capabilityMatches(candidate, record(p).sha256)).toBe(false);
    assertAnswerRejected(p, ['--answer-decision', pendingId, '--answer', exactAnswer]);
  });

  it.each([
    ['--answer-decision', pendingId],
    ['--answer', exactAnswer],
    ['--answer-decision', '--answer', exactAnswer],
    ['--answer-decision', pendingId, '--answer'],
    ['--answer-decision', 'DEC-unknown', '--answer', exactAnswer],
    ['--answer-decision', pendingId, '--answer', 'Allow installs anywhere'],
    ['--answer-decision', pendingId, '--answer', `${exactAnswer} `],
  ])('rejects invalid answer flags before opening authority: %j', (...flags) => {
    assertAnswerRejected(pendingFixture(), flags);
  });

  it('requires durable worker choice evidence before opening authority', () => {
    assertAnswerRejected(pendingFixture(false), ['--answer-decision', pendingId, '--answer', exactAnswer]);
  });

  it('refuses an already applied decision even if still listed pending', () => {
    const p = pendingFixture();
    markDecisionApplied(join(p.featureDir, 'events.jsonl'), FEATURE_ID, pendingId, 'prior decision apply');
    assertAnswerRejected(p, ['--answer-decision', pendingId, '--answer', exactAnswer]);
  });

  it.each(['flag', 'environment'])('refuses worker capability via %s without mutation', (kind) => {
    assertAnswerRejected(pendingFixture(), ['--answer-decision', pendingId, '--answer', exactAnswer,
      ...(kind === 'flag' ? ['--capability', 'a'.repeat(64)] : [])],
    kind === 'environment' ? { MYCELINK_CLAIM_TOKEN: 'a'.repeat(64) } : {});
  });

  it('leaves an unanswered pending choice parked on normal continuation', () => {
    const p = pendingFixture();
    const result = invoke(p, ['--max-nodes', '1']);
    expect(JSON.parse(result.stdout)).toMatchObject({ reports: [] });
    expect(loadState(p.featureDir)!.data.pending_decisions).toEqual([pendingId]);
    expect(readEvents(join(p.featureDir, 'events.jsonl')).some((e) => e.type === 'decision.recorded' || e.type === 'decision.applied')).toBe(false);
  });

  it.each(['record', 'apply'])('keeps generic decision %s denied by the Codex runtime gate', (command) => {
    const p = pendingFixture();
    const before = decisionSnapshot(p);
    const result = invoke(p, ['--answer', exactAnswer], {}, ['decision', command, FEATURE_ID, pendingId]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CODEX_RUNTIME_DENIED');
    expect(decisionSnapshot(p)).toEqual(before);
    expect(existsSync(authorityFile(p.control))).toBe(false);
  });
});
