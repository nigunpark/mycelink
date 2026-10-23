/** Bounded request protocol core. Transport and live-claim lookup are controller-owned. */
import { commitClaimPaths } from './codex-controller-git.js';
import { samePath } from '../security/paths.js';
import { isTestPath, redBinding, type TddPolicy } from '../engine/tdd-history.js';
import { runGit } from '../git/git.js';

export interface LiveClaim {
  claimId: string;
  generation?: number;
  dispatchId?: string;
  featureId: string;
  nodeId: string;
  repoPath: string;
  worktree: string;
  expectedHead: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  /** Controller-bound test classification for this claim, never worker input. */
  tddPolicy?: TddPolicy;
  /** Derived from the current graph and runtime state, never the request. */
  nextGate: 'red' | 'green' | 'regression' | null;
  gateCommands: { gate: 'red' | 'green' | 'regression'; argv: string[] }[];
  /** Only the current acceptance-review rework may request these criteria. */
  challengeCriteria?: string[];
}

export interface ProbeResult { exitCode: number; output: string; diagnostic?: { role: 'diagnostic-only'; tests: Pick<import('../evidence/test-ids.js').CanonicalTest, 'id' | 'path' | 'full_name' | 'status'>[] } }

// Leave room for the response envelope and output; identities are never truncated.
export function validProbeDiagnostic(value: unknown): value is NonNullable<ProbeResult['diagnostic']> {
  if (!value || typeof value !== 'object') return false;
  const d = value as NonNullable<ProbeResult['diagnostic']>;
  return d.role === 'diagnostic-only' && Array.isArray(d.tests) && d.tests.length <= 256 &&
    d.tests.every(t => t && typeof t.id === 'string' && /^[0-9a-f]{16}$/.test(t.id) &&
      typeof t.path === 'string' && Buffer.byteLength(t.path) <= 1024 &&
      typeof t.full_name === 'string' && Buffer.byteLength(t.full_name) <= 4096 &&
      ['passed', 'failed', 'skipped', 'not-run'].includes(t.status)) &&
    Buffer.byteLength(JSON.stringify(d)) <= 16 * 1024;
}

/** Bound the complete JSON wire representation, including the mailbox newline. */
export function boundChannelResponse(response: ChannelResponse): ChannelResponse {
  const invalid = (): ChannelResponse => ({ ok: true, sequence: response.sequence ?? 0,
    exitCode: 2, output: 'CHANNEL_PROBE_REPORT_INVALID' });
  if ('diagnostic' in response && response.diagnostic !== undefined && !validProbeDiagnostic(response.diagnostic)) return invalid();
  const size = () => Buffer.byteLength(JSON.stringify(response)) + 1;
  if (size() <= 32 * 1024) return response;
  if (typeof response.output !== 'string') return invalid();
  const output = response.output;
  response = { ...response, output: '' };
  if (size() > 32 * 1024) return invalid();
  let low = 0, high = Math.min(output.length, 32 * 1024);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    response.output = output.slice(0, mid);
    if (size() <= 32 * 1024) low = mid; else high = mid - 1;
  }
  response.output = output.slice(0, low);
  return response;
}

export type ChannelResponse =
  | { ok: true; sequence: number; exitCode: number; output: string; output_sha256?: string; test_ids?: string[]; diagnostic?: ProbeResult['diagnostic']; commitSha?: never }
  | { ok: true; sequence: number; commitSha: string; exitCode?: never; output?: never }
  | { ok: false; sequence: number | null; code: string; exitCode?: number; output?: string };

type Request = { claimId: string; featureId: string; nodeId: string; sequence: number } & (
  | { operation: 'gate'; gate: 'red' | 'green' | 'regression' }
  | { operation: 'commit'; paths: string[]; message: string }
  | { operation: 'challenge'; criterion: string }
  | { operation: 'check' }
  | { operation: 'probe' }
);

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);

/** Full test-side tree: declarations alone cannot bind support files or exact bytes. */
function testTree(worktree: string, policy: TddPolicy, head: string): Map<string, string> {
  const tests = new Map<string, string>();
  const entries = runGit(worktree, ['ls-tree', '-r', '-z', head]).stdout.split('\0');
  for (const entry of entries) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new Error('invalid tree entry');
    const [, type, blob] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (!isTestPath(policy, path)) continue;
    if (type !== 'blob' || !blob) throw new Error('test path is not a blob');
    tests.set(path, blob);
  }
  return tests;
}

function parse(input: unknown): Request | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const base = ['claimId', 'featureId', 'nodeId', 'sequence', 'operation'];
  if (!id(r['claimId']) || !id(r['featureId']) || !id(r['nodeId']) || !Number.isSafeInteger(r['sequence']) || (r['sequence'] as number) < 1) return null;
  if (r['operation'] === 'gate') {
    if (!['red', 'green', 'regression'].includes(String(r['gate'])) || Object.keys(r).some((k) => ![...base, 'gate'].includes(k))) return null;
  } else if (r['operation'] === 'commit') {
    if (!Array.isArray(r['paths']) || !r['paths'].every((p) => typeof p === 'string') || typeof r['message'] !== 'string' || Object.keys(r).some((k) => ![...base, 'paths', 'message'].includes(k))) return null;
  } else if (r['operation'] === 'challenge') {
    if (typeof r['criterion'] !== 'string' || !/^AC-[A-Za-z0-9_.-]{1,60}$/.test(r['criterion']) || Object.keys(r).some((k) => ![...base, 'criterion'].includes(k))) return null;
  } else if (r['operation'] === 'check' || r['operation'] === 'probe') {
    if (Object.keys(r).some((k) => !base.includes(k))) return null;
  } else return null;
  return r as Request;
}

/** One instance per dispatched claim; each well-formed numbered request is consumed once. */
export class ClaimChannel {
  private sequence = 0;
  private acceptedRed = false;
  private redStarted = false;
  private redHead: string | null = null;
  private redTests: Map<string, string> | null = null;
  constructor(
    private readonly liveClaim: () => LiveClaim | null,
    private readonly runGate: (argv: readonly string[], cwd: string) => { exitCode: number; output: string; outputSha256?: string; testIds?: string[] },
    private readonly runReadOnly?: (operation: 'challenge' | 'check', criterion: string | null) => { exitCode: number; output: string },
    private readonly runProbe?: () => ProbeResult,
  ) {}

  handle(input: unknown): ChannelResponse {
    const request = parse(input);
    if (!request) return { ok: false, sequence: null, code: 'CHANNEL_REQUEST_INVALID' };
    const sequence = request.sequence;
    const fail = (code: string): ChannelResponse => ({ ok: false, sequence, code });
    if (sequence !== this.sequence + 1) return fail('CHANNEL_SEQUENCE_INVALID');
    let scope: LiveClaim | null;
    try { scope = this.liveClaim(); } catch { return fail('CHANNEL_CLAIM_STALE'); }
    if (!scope || scope.claimId !== request.claimId || scope.featureId !== request.featureId || scope.nodeId !== request.nodeId) return fail('CHANNEL_CLAIM_STALE');
    if (request.operation === 'gate' && request.gate === 'red' && this.runProbe && this.redStarted) return fail('CHANNEL_GATE_OUT_OF_ORDER');
    if (request.operation === 'gate' && (scope.nextGate !== request.gate || !scope.gateCommands.some((g) => g.gate === request.gate))) {
      return fail('CHANNEL_GATE_OUT_OF_ORDER');
    }
    if ((request.operation === 'challenge' || request.operation === 'check') && (!scope.challengeCriteria?.length || !this.runReadOnly)) return fail('CHANNEL_REVIEW_UNAVAILABLE');
    if (request.operation === 'challenge' && !scope.challengeCriteria?.includes(request.criterion)) return fail('CHANNEL_CRITERION_INVALID');
    this.sequence = sequence;
    if (request.operation === 'challenge' || request.operation === 'check') {
      try {
        const result = this.runReadOnly!(request.operation, request.operation === 'challenge' ? request.criterion : null);
        const now = this.liveClaim();
        if (!now || now.claimId !== scope.claimId || now.featureId !== scope.featureId || now.nodeId !== scope.nodeId || !samePath(now.worktree, scope.worktree)) return fail('CHANNEL_CLAIM_STALE');
        const output = result.output.slice(0, 32 * 1024);
        return result.exitCode === 0 ? { ok: true, sequence, exitCode: 0, output }
          : { ok: false, sequence, code: 'CHANNEL_REVIEW_REFUSED', exitCode: result.exitCode, output };
      } catch { return fail('CHANNEL_REVIEW_FAILED'); }
    }
    if (request.operation === 'probe') {
      if (!this.runProbe || this.redStarted || scope.nextGate !== 'red') return fail('CHANNEL_PROBE_UNAVAILABLE');
      try {
        const result = this.runProbe();
        const now = this.liveClaim();
        if (!now || now.claimId !== scope.claimId || now.featureId !== scope.featureId || now.nodeId !== scope.nodeId ||
            now.generation !== scope.generation || now.dispatchId !== scope.dispatchId || now.expectedHead !== scope.expectedHead || !samePath(now.worktree, scope.worktree) || now.nextGate !== 'red') return fail('CHANNEL_CLAIM_STALE');
        if (!Number.isInteger(result.exitCode) || typeof result.output !== 'string') return fail('CHANNEL_PROBE_FAILED');
        if (result.diagnostic !== undefined && !validProbeDiagnostic(result.diagnostic)) {
          return { ok: true, sequence, exitCode: 2, output: 'CHANNEL_PROBE_REPORT_INVALID' };
        }
        const diagnostic: ProbeResult['diagnostic'] = result.diagnostic ? {
          role: 'diagnostic-only',
          tests: result.diagnostic.tests.slice(0, 256).map(t => ({ id: t.id, path: t.path, full_name: t.full_name, status: t.status })),
        } : undefined;
        return boundChannelResponse({ ok: true, sequence, exitCode: result.exitCode, output: result.output,
          ...(diagnostic ? { diagnostic } : {}) });
      } catch { return fail('CHANNEL_PROBE_FAILED'); }
    }
    if (request.operation === 'gate') {
      if (request.gate === 'red') this.redStarted = true;
      // Capture before executing RED, including tests already in HEAD. The
      // delta binding alone misses those (and declaration discovery is not a
      // byte binding). GREEN requires this exact tree to have been committed.
      let redSnapshot: { head: string; tests: Map<string, string> } | null = null;
      if (request.gate === 'red' && scope.tddPolicy) {
        try {
          const { binding } = redBinding(scope.worktree, scope.tddPolicy, null);
          const tests = testTree(scope.worktree, scope.tddPolicy, binding.head_sha);
          for (const test of binding.tests) {
            if (test.blob === null) tests.delete(test.path);
            else tests.set(test.path, test.blob);
          }
          redSnapshot = { head: binding.head_sha, tests };
        } catch { return fail('CHANNEL_CLAIM_STALE'); }
      }
      // A test-only commit changes HEAD but not production. Do not spend a
      // verifier run on that identical RED production snapshot. The real gate
      // still decides whether an edited implementation actually passes.
      if (request.gate === 'green' && this.acceptedRed && scope.tddPolicy) {
        try {
          const { binding } = redBinding(scope.worktree, scope.tddPolicy, null);
          const tests = testTree(scope.worktree, scope.tddPolicy, binding.head_sha);
          if (binding.tests.length !== 0 || this.redTests === null || tests.size !== this.redTests.size
            || [...tests].some(([path, blob]) => this.redTests!.get(path) !== blob)) {
            return fail('CHANNEL_GREEN_TESTS_NOT_BOUND');
          }
        } catch { return fail('CHANNEL_GREEN_TESTS_NOT_BOUND'); }
        try {
          const working = redBinding(scope.worktree, scope.tddPolicy, null).production;
          const committed = this.redHead === null ? [] : runGit(scope.worktree, ['diff', '--name-only', '-z', this.redHead, 'HEAD']).stdout.split('\0').filter((p) => p && !isTestPath(scope.tddPolicy!, p));
          if (working.length === 0 && committed.length === 0) return fail('CHANNEL_GREEN_UNCHANGED_RED');
        } catch { return fail('CHANNEL_CLAIM_STALE'); }
      }
      const argv = scope.gateCommands.find((g) => g.gate === request.gate)!.argv;
      try {
        const result = this.runGate(argv, scope.worktree);
        if (!Number.isInteger(result.exitCode) || typeof result.output !== 'string') throw new Error('invalid gate response');
        // A gate may rotate the claim; its CLI records evidence only for the live holder.
        const now = this.liveClaim();
        if (!now || now.claimId !== scope.claimId || now.featureId !== scope.featureId || now.nodeId !== scope.nodeId || !samePath(now.worktree, scope.worktree)) return fail('CHANNEL_CLAIM_STALE');
        if (request.gate === 'red' && result.exitCode === 0) {
          this.acceptedRed = true;
          this.redHead = redSnapshot?.head ?? null;
          this.redTests = redSnapshot?.tests ?? null;
        }
        if (request.gate === 'green' && result.exitCode === 0) this.acceptedRed = false;
        const output = result.output.slice(0, 64 * 1024);
        return result.exitCode === 0
          ? { ok: true, sequence, exitCode: 0, output,
            ...(result.outputSha256 ? { output_sha256: result.outputSha256, test_ids: result.testIds ?? [] } : {}) }
          : { ok: false, sequence, code: 'CHANNEL_GATE_FAILED', exitCode: result.exitCode, output };
      } catch {
        return fail('CHANNEL_GATE_FAILED');
      }
    }
    if (this.runProbe && scope.nextGate === 'red') return fail('CHANNEL_COMMIT_BEFORE_RED');
    try {
      const commitSha = commitClaimPaths({
        repoPath: scope.repoPath, worktree: scope.worktree, featureId: scope.featureId, nodeId: scope.nodeId,
        expectedHead: scope.expectedHead, allowedPaths: scope.allowedPaths, forbiddenPaths: scope.forbiddenPaths,
      }, { paths: request.paths, message: request.message, claimCurrent: () => {
        const now = this.liveClaim();
        return now !== null && now.claimId === scope.claimId && now.featureId === scope.featureId && now.nodeId === scope.nodeId && samePath(now.worktree, scope.worktree) && now.expectedHead === scope.expectedHead;
      } });
      return { ok: true, sequence, commitSha };
    } catch {
      return fail('CHANNEL_COMMIT_FAILED');
    }
  }
}
