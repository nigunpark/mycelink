import { afterAll, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { BUILD_DIR, REPO_ROOT } from '../helpers/global-setup.js';
import { controllerKey } from '../helpers/authority.js';
import { authorityFile } from '../../src/engine/authority.js';
import { preflightAdapter } from '../../src/sessions/preflight.js';
import { loadConfig } from '../../src/workspace/workspace.js';
import { createVer, verCli, verState, VER_FEATURE, ARP, ARP_RED, ARP_SRC, ARP_TESTS, ARP_ROLLBACK_TEST, ARP_JOURNAL_TEST, ARP_GAPPY_IMPL, CLI, CLI_FULL_WORK, CLI_RECOVERY_TEST, CLI_FAILURE_TEST, CLI_AC5 } from '../helpers/version-fixture.js';
import { fulfil } from '../helpers/shop-worker.js';
import { reviewPacket, verdictFor } from '../helpers/review-agent.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { finalizeCodexDelivery } from '../../src/engine/codex-finalize.js';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';
import { listCandidates, loadCandidate } from '../../src/git/candidate.js';
import { featureVerifyProblems } from '../../src/engine/feature-verify.js';
import { reviewGateProblems } from '../../src/engine/acceptance-review.js';

const fakeRoots: string[] = [];
afterAll(() => { cleanupTmpRoots(); fakeRoots.forEach((p) => rmSync(p, { recursive: true, force: true })); });

function fakeReviewer(final: unknown): string {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.env.TEMP ?? '.', 'codex-finalize-'));
  fakeRoots.push(root);
  const script = join(root, 'reviewer.mjs');
  writeFileSync(script, `process.stdin.resume();console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:${JSON.stringify(JSON.stringify(final))}}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:12}}));`);
  return script;
}

async function prepared() {
  const s = await createVer({ review: {} });
  const dispatch = async () => JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--json'])).out);
  const a = (await dispatch()).ticket;
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: [{ criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST }, { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST }] }, s.control);
  expect(JSON.parse((await verCli(s, ['settle', VER_FEATURE, ARP, '--capability', a.capability, '--json'])).out).outcome).toBe('DONE');
  const c = (await dispatch()).ticket;
  fulfil(c, { ...CLI_FULL_WORK, criteria: [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST }, { criterion: 'AC-4', gate: 'red', full_name: CLI_FAILURE_TEST }, CLI_AC5] }, s.control);
  expect(JSON.parse((await verCli(s, ['settle', VER_FEATURE, CLI, '--capability', c.capability, '--json'])).out).outcome).toBe('DONE');
  const t = (await dispatch()).ticket;
  expect(t.kind).toBe('acceptance-review');
  const engine = new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter });
  return { s, t, engine };
}

it('refuses to cut or move a base without a fresh PASS', async () => {
  const { s, engine } = await prepared();
  const before = git(s.repo, ['rev-parse', 'main']);
  await expect(finalizeCodexDelivery(s.control, VER_FEATURE, engine)).rejects.toThrow(/REVIEW|PASS/);
  expect(git(s.repo, ['rev-parse', 'main'])).toBe(before);
  expect(verState(s).current_candidate).toBeNull();
});

it('cuts an exact candidate after PASS, delivers the declared base, independently tests it, and refuses replay', async () => {
  const { s, t, engine } = await prepared();
  const base = git(s.repo, ['rev-parse', 'main']);
  const verdict = verdictFor(reviewPacket(t));
  // This fixture settles a controller-bound PASS without pretending a model ran.
  const receipt = await engine.settleCodexReview(t, {
    executable: process.execPath,
    prefixArgs: [fakeReviewer(verdict)],
    timeoutMs: 5000,
  });
  expect(receipt.outcome).toBe('PASS');
  const delivered = await finalizeCodexDelivery(s.control, VER_FEATURE, engine);
  expect(delivered.ok).toBe(true);
  expect(delivered.idempotent).toBe(false);
  const target = delivered.repositories['changesets']!.target;
  expect(base).not.toBe(target);
  expect(delivered.repositories['changesets']!.before).toBe(base);
  expect(delivered.repositories['changesets']!.after).toBe(target);
  expect(git(s.repo, ['rev-parse', 'main'])).toBe(target);
  expect(delivered.acceptance).toEqual([expect.objectContaining({ repository: 'changesets', sha: target, exit_code: 0, failure_fingerprint: null })]);
  const candidate = verState(s).current_candidate!;
  expect(readFileSync(join(s.featureDir, 'candidates', `${candidate}.yaml`), 'utf8')).toContain(target);
  await expect(finalizeCodexDelivery(s.control, VER_FEATURE, engine)).rejects.toThrow(/REPLAY|ALREADY/);
});

it('refuses a reviewed integration head changed after PASS without moving the base', async () => {
  const { s, t, engine } = await prepared();
  const verdict = verdictFor(reviewPacket(t));
  expect((await engine.settleCodexReview(t, { executable: process.execPath, prefixArgs: [fakeReviewer(verdict)], timeoutMs: 5000 })).outcome).toBe('PASS');
  const before = git(s.repo, ['rev-parse', 'main']);
  git(s.repo, ['update-ref', `refs/heads/feature/${VER_FEATURE}`, before]);
  await expect(finalizeCodexDelivery(s.control, VER_FEATURE, engine)).rejects.toThrow(/REVIEW|HEAD|MOVED/);
  expect(git(s.repo, ['rev-parse', 'main'])).toBe(before);
  expect(verState(s).current_candidate).toBeNull();
});

// Simulate process loss after the ordinary scheduler completed candidate-build,
// before delivery. No fabricated candidate or hand-written STATE.json.
async function resumableCandidate({ codexCli = false } = {}) {
  const { s, t, engine } = await prepared();
  expect((await engine.settleCodexReview(t, {
    executable: process.execPath, prefixArgs: [fakeReviewer(verdictFor(reviewPacket(t)))], timeoutMs: 5000,
  })).outcome).toBe('PASS');
  if (codexCli) {
    const configFile = join(s.control, 'mycelink.config.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    // Configure continuation before candidate-build seals the control inputs.
    // Node answers the official --version probe without authentication or model
    // use. Continuation must never invoke a worker or a second reviewer.
    config.provider = { provider: 'codex', executable: process.execPath, extra_args: [] };
    config.experimental_codex = { enabled: true, disposable_repositories: ['changesets'] };
    writeFileSync(configFile, JSON.stringify(config));
    // Candidate-build requires a clean control repo; commit fixture setup first.
    git(s.control, ['add', 'mycelink.config.json']);
    git(s.control, ['commit', '-q', '-m', 'Configure Codex continuation fixture']);
  }
  const base = git(s.repo, ['rev-parse', 'main']);
  const built = await engine.dispatchNext();
  expect(built.status, JSON.stringify({ detail: built.detail, problems: built.problems }).slice(0, 2000)).toBe('ALL_SETTLED');
  expect(built.controller_reports).toEqual([expect.objectContaining({ outcome: 'DONE' })]);
  const state = verState(s);
  expect(Object.values(state.nodes).every((node: any) => ['DONE', 'EXCLUDED'].includes(node.state))).toBe(true);
  expect(state.feature_state).toBe('VERIFIED');
  expect(Object.keys(state.accepted_deliveries ?? {})).toEqual([]);
  expect(reviewGateProblems(s.control, VER_FEATURE)).toEqual([]);
  expect(featureVerifyProblems(s.control, VER_FEATURE)).toEqual([]);
  const candidateId = state.current_candidate as string;
  expect(listCandidates(s.featureDir)).toEqual([candidateId]);
  const candidate = loadCandidate(s.featureDir, candidateId);
  const manifest = readFileSync(join(s.featureDir, 'candidates', `${candidateId}.yaml`), 'utf8');
  expect(git(s.repo, ['rev-parse', 'main'])).toBe(base);
  const resumed = new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter });
  return { s, base, candidateId, candidate, manifest, resumed };
}

it('resumes delivery of the pinned candidate after process loss without another dispatch or review, then refuses replay', async () => {
  const { s, base, candidateId, candidate, manifest, resumed } = await resumableCandidate();
  const reviews = verState(s).acceptance_review;
  const dispatch = vi.spyOn(resumed, 'dispatchNext');
  const review = vi.spyOn(resumed, 'settleCodexReview');
  const delivered = await finalizeCodexDelivery(s.control, VER_FEATURE, resumed);
  const target = candidate.repositories.changesets!.sha;
  expect(delivered).toMatchObject({ ok: true, idempotent: false,
    repositories: { changesets: { before: base, after: target, target } },
    acceptance: [expect.objectContaining({ repository: 'changesets', sha: target, exit_code: 0, failure_fingerprint: null })],
  });
  expect(git(s.repo, ['rev-parse', 'main'])).toBe(target);
  expect(verState(s).current_candidate).toBe(candidateId);
  expect(verState(s).acceptance_review).toEqual(reviews);
  expect(listCandidates(s.featureDir)).toEqual([candidateId]);
  expect(readFileSync(join(s.featureDir, 'candidates', `${candidateId}.yaml`), 'utf8')).toBe(manifest);
  await expect(finalizeCodexDelivery(s.control, VER_FEATURE, resumed)).rejects.toThrow(/REPLAY|ALREADY/);
  expect(dispatch).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
});

it.each(['feature ref', 'control input', 'candidate manifest', 'evidence', 'missing PASS'] as const)(
  'refuses resumed delivery with %s drift without cutting a replacement or moving main', async (kind) => {
    const { s, base, candidateId, resumed } = await resumableCandidate();
    const state = verState(s);
    if (kind === 'feature ref') git(s.repo, ['update-ref', `refs/heads/feature/${VER_FEATURE}`, base]);
    else if (kind === 'control input') {
      const file = join(s.featureDir, 'PRD.md');
      writeFileSync(file, readFileSync(file, 'utf8') + '\nChanged acceptance intent after candidate build.\n');
    } else if (kind === 'candidate manifest') {
      const file = join(s.featureDir, 'candidates', `${candidateId}.yaml`);
      writeFileSync(file, readFileSync(file, 'utf8').replace('manifest_sha256:', 'manifest_sha256: corrupted'));
    } else if (kind === 'evidence') {
      const file = join(s.control, state.nodes[ARP].evidence.green.output_path);
      writeFileSync(file, readFileSync(file, 'utf8') + '\nmutated evidence\n');
    } else {
      const pass = state.acceptance_review.reviews.find((r: any) => r.overall === 'PASS');
      expect(pass).toBeDefined();
      rmSync(join(s.control, pass.receipt_path));
    }
    const dispatch = vi.spyOn(resumed, 'dispatchNext');
    const review = vi.spyOn(resumed, 'settleCodexReview');
    // A blanket current_candidate replay rejection does not satisfy these guards.
    await expect(finalizeCodexDelivery(s.control, VER_FEATURE, resumed)).rejects.toThrow(/DRIFT|STALE|REVIEW|PASS|EVIDENCE|VERIFIED|manifest|schema/i);
    expect(git(s.repo, ['rev-parse', 'main'])).toBe(base);
    expect(verState(s).current_candidate).toBe(candidateId);
    expect(Object.keys(verState(s).accepted_deliveries ?? {})).toEqual([]);
    expect(listCandidates(s.featureDir)).toEqual([candidateId]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  },
);


it('CLI continue --review --deliver requires control Git before authority, STATE or workers', async () => {
  const fixture = await createVer({ init: false, review: {} });
  const control = join(fixture.root, 'codex-control');
  const featureDir = join(control, 'features', VER_FEATURE);
  const env = { ...process.env };
  for (const name of ['CLAUDE_PID', 'MYCELINK_CLAIM_TOKEN', 'MYCELINK_FAKE_CLAUDE', 'MYCELINK_CRASH_AT']) delete env[name];
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [join(REPO_ROOT, 'bin', 'mycelink.mjs'), ...args],
      { cwd: fixture.root, env, encoding: 'utf8', timeout: 90_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  };
  const init = run(['codex', 'init', control, '--json']);
  expect(init.status, init.stderr).toBe(0);
  mkdirSync(featureDir, { recursive: true });
  const graph = YAML.parse(readFileSync(join(fixture.featureDir, 'PORTFOLIO-GRAPH.yaml'), 'utf8'));
  // Give the fixture criteria the approved requirement's Markdown block form,
  // keeping the reviewed graph's text identical to the prepared manifest.
  graph.acceptance_criteria = graph.acceptance_criteria.map((criterion: { id: string; text: string; kind: string }) => ({
    ...criterion, text: `**${criterion.id}** ${criterion.text}`,
  }));
  writeFileSync(join(featureDir, 'PRD.md'), `# ${VER_FEATURE}\n\nStatus: approved\n\n${graph.acceptance_criteria.map((criterion: { text: string }) => criterion.text).join('\n\n')}\n`);
  const draft = join(featureDir, 'PORTFOLIO-GRAPH.draft.yaml');
  writeFileSync(draft, YAML.stringify(graph));
  // The existing fixture registers a separate, committed Git producer at
  // ../changesets, also relative to this fresh Codex control.
  writeFileSync(join(control, 'repositories.yaml'), readFileSync(join(fixture.control, 'repositories.yaml'), 'utf8'));
  const configFile = join(control, 'mycelink.config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.experimental_codex = { enabled: true, disposable_repositories: ['changesets'] };
  writeFileSync(configFile, JSON.stringify(config));
  const prepared = run(['codex', 'prepare', VER_FEATURE, '--source', `features/${VER_FEATURE}/PRD.md`,
    '--from', draft, '--kind', 'AC-5=compatibility', '--control-root', control, '--json']);
  expect(prepared.status, prepared.stderr).toBe(0);
  expect(JSON.parse(prepared.stdout)).toMatchObject({ prepared: true, authority_opened: false });
  // Use the official Codex executable configured by init; no worker mock or
  // version-only substitute may mask an unrelated runtime denial.
  const status = run(['codex', 'status', VER_FEATURE, '--control-root', control, '--json']);
  expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ graph_valid: true, state_present: false, runtime_enabled: true });
  expect(existsSync(join(control, '.git'))).toBe(false);
  expect(existsSync(authorityFile(control))).toBe(false);
  expect(existsSync(join(featureDir, 'STATE.json'))).toBe(false);
  const head = git(fixture.repo, ['rev-parse', 'HEAD']);
  const worktrees = git(fixture.repo, ['worktree', 'list', '--porcelain']);

  const continued = run(['codex', 'continue', VER_FEATURE, '--review', '--deliver', '--control-root', control, '--json']);
  expect.soft(continued.status, continued.stderr).toBe(1);
  expect.soft(continued.stderr).toContain('CODEX_CONTROL_GIT_REQUIRED');
  expect.soft(continued.stderr).toMatch(/control/i);
  expect.soft(continued.stderr).toMatch(/git init\b/i);
  expect.soft(continued.stderr).toMatch(/git (?:-C\s+(?:"[^"]+"|\S+)\s+)?commit\b/i);
  expect.soft(existsSync(authorityFile(control))).toBe(false);
  expect.soft(existsSync(join(featureDir, 'STATE.json'))).toBe(false);
  expect.soft(existsSync(join(featureDir, 'sessions'))).toBe(false);
  expect.soft(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(head);
  expect.soft(git(fixture.repo, ['worktree', 'list', '--porcelain'])).toBe(worktrees);
});

it('CLI continue --review --deliver resumes the existing candidate with fresh authority and denies replay', async () => {
  const { s, base, candidateId, candidate, manifest } = await resumableCandidate({ codexCli: true });
  expect(preflightAdapter(loadConfig(s.control), process.env, s.control)).toMatchObject({ ok: true, adapter: 'codex-cli', auth: 'not-checked' });
  expect(reviewGateProblems(s.control, VER_FEATURE)).toEqual([]);
  expect(featureVerifyProblems(s.control, VER_FEATURE)).toEqual([]);

  // Rotate with the actual current key to a verifiable child holder. Its exit
  // models process loss; continue must recover and mint its own fresh key.
  const rotated = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { pathToFileURL } from 'node:url';
    const { openControllerAuthority } = await import(pathToFileURL(process.argv[1]).href);
    const { processIdentity } = await import(pathToFileURL(process.argv[2]).href);
    openControllerAuthority(process.argv[3], { current: process.argv[4], holder: processIdentity(process.pid) });
  `, join(BUILD_DIR, 'engine', 'authority.js'), join(BUILD_DIR, 'util', 'process-identity.js'), s.control, controllerKey(s.control)],
  { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  expect(rotated.error).toBeUndefined();
  expect(rotated.status, rotated.stderr).toBe(0);
  const previousAuthority = JSON.parse(readFileSync(authorityFile(s.control), 'utf8'));
  expect(previousAuthority.holder.pid).toBe(rotated.pid);
  const reviews = verState(s).acceptance_review;
  const invoke = () => {
    const env = { ...process.env };
    for (const name of ['CLAUDE_PID', 'MYCELINK_CLAIM_TOKEN', 'MYCELINK_FAKE_CLAUDE', 'MYCELINK_CRASH_AT']) delete env[name];
    const result = spawnSync(process.execPath, [join(REPO_ROOT, 'bin', 'mycelink.mjs'),
      'codex', 'continue', VER_FEATURE, '--review', '--deliver', '--json', '--control-root', s.control],
    { cwd: s.control, env, encoding: 'utf8', timeout: 90_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const delivered = await invoke();
  const freshAuthority = JSON.parse(readFileSync(authorityFile(s.control), 'utf8'));
  expect(freshAuthority).toMatchObject({ recovered: true, takeover: false });
  expect(freshAuthority.sha256).not.toBe(previousAuthority.sha256);
  // Keep the existing review and candidate immutable across continuation.
  expect.soft(verState(s).acceptance_review).toEqual(reviews);
  expect.soft(listCandidates(s.featureDir)).toEqual([candidateId]);
  expect.soft(readFileSync(join(s.featureDir, 'candidates', `${candidateId}.yaml`), 'utf8')).toBe(manifest);
  const target = candidate.repositories.changesets!.sha;
  expect.soft(git(s.repo, ['rev-parse', 'main'])).toBe(target);
  expect(delivered.code, delivered.err).toBe(0);
  expect(JSON.parse(delivered.out)).toMatchObject({ delivery: { ok: true, idempotent: false,
    candidate_id: candidateId, repositories: { changesets: { before: base, after: target, target } },
  } });
  const replay = await invoke();
  expect(replay.code).toBe(1);
  expect(replay.err).toContain('CODEX_FINALIZE_REPLAY');
  expect(git(s.repo, ['rev-parse', 'main'])).toBe(target);
  expect(listCandidates(s.featureDir)).toEqual([candidateId]);
  expect(verState(s).acceptance_review).toEqual(reviews);
});
