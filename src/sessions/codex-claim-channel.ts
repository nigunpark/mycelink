/** Bounded request protocol core. Transport and live-claim lookup are controller-owned. */
import { commitClaimPaths } from './codex-controller-git.js';
import { samePath } from '../security/paths.js';
import { isTestPath, redBinding, type TddPolicy } from '../engine/tdd-history.js';
import { resolveRef, runGit } from '../git/git.js';

export interface LiveClaim {
  claimId: string;
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

export type ChannelResponse =
  | { ok: true; sequence: number; exitCode: number; output: string; output_sha256?: string; test_ids?: string[]; commitSha?: never }
  | { ok: true; sequence: number; commitSha: string; exitCode?: never; output?: never }
  | { ok: false; sequence: number | null; code: string; exitCode?: number; output?: string };

type Request = { claimId: string; featureId: string; nodeId: string; sequence: number } & (
  | { operation: 'gate'; gate: 'red' | 'green' | 'regression' }
  | { operation: 'commit'; paths: string[]; message: string }
  | { operation: 'challenge'; criterion: string }
  | { operation: 'check' }
);

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);

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
  } else if (r['operation'] === 'check') {
    if (Object.keys(r).some((k) => !base.includes(k))) return null;
  } else return null;
  return r as Request;
}

/** One instance per dispatched claim; each well-formed numbered request is consumed once. */
export class ClaimChannel {
  private sequence = 0;
  private acceptedRed = false;
  private redHead: string | null = null;
  constructor(
    private readonly liveClaim: () => LiveClaim | null,
    private readonly runGate: (argv: readonly string[], cwd: string) => { exitCode: number; output: string; outputSha256?: string; testIds?: string[] },
    private readonly runReadOnly?: (operation: 'challenge' | 'check', criterion: string | null) => { exitCode: number; output: string },
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
    if (request.operation === 'gate') {
      // A test-only commit changes HEAD but not production. Do not spend a
      // verifier run on that identical RED production snapshot. The real gate
      // still decides whether an edited implementation actually passes.
      if (request.gate === 'green' && this.acceptedRed && scope.tddPolicy) {
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
          this.redHead = scope.tddPolicy ? resolveRef(scope.worktree, 'HEAD') : null;
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
