/** Bounded request protocol core. Transport and live-claim lookup are controller-owned. */
import { commitClaimPaths } from './codex-controller-git.js';
import { samePath } from '../security/paths.js';

export interface LiveClaim {
  claimId: string;
  featureId: string;
  nodeId: string;
  repoPath: string;
  worktree: string;
  expectedHead: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  /** Derived from the current graph and runtime state, never the request. */
  nextGate: 'red' | 'green' | 'regression' | null;
  gateCommands: { gate: 'red' | 'green' | 'regression'; argv: string[] }[];
}

export type ChannelResponse =
  | { ok: true; sequence: number; exitCode: number; output: string; commitSha?: never }
  | { ok: true; sequence: number; commitSha: string; exitCode?: never; output?: never }
  | { ok: false; sequence: number | null; code: string; exitCode?: number; output?: string };

type Request = { claimId: string; featureId: string; nodeId: string; sequence: number } & (
  | { operation: 'gate'; gate: 'red' | 'green' | 'regression' }
  | { operation: 'commit'; paths: string[]; message: string }
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
  } else return null;
  return r as Request;
}

/** One instance per dispatched claim; each well-formed numbered request is consumed once. */
export class ClaimChannel {
  private sequence = 0;
  constructor(
    private readonly liveClaim: () => LiveClaim | null,
    private readonly runGate: (argv: readonly string[], cwd: string) => { exitCode: number; output: string },
  ) {}

  handle(input: unknown): ChannelResponse {
    const request = parse(input);
    if (!request) return { ok: false, sequence: null, code: 'CHANNEL_REQUEST_INVALID' };
    const sequence = request.sequence;
    const fail = (code: string): ChannelResponse => ({ ok: false, sequence, code });
    if (sequence !== this.sequence + 1) return fail('CHANNEL_SEQUENCE_INVALID');
    const scope = this.liveClaim();
    if (!scope || scope.claimId !== request.claimId || scope.featureId !== request.featureId || scope.nodeId !== request.nodeId) return fail('CHANNEL_CLAIM_STALE');
    if (request.operation === 'gate' && (scope.nextGate !== request.gate || !scope.gateCommands.some((g) => g.gate === request.gate))) {
      return fail('CHANNEL_GATE_OUT_OF_ORDER');
    }
    this.sequence = sequence;
    if (request.operation === 'gate') {
      const argv = scope.gateCommands.find((g) => g.gate === request.gate)!.argv;
      try {
        const result = this.runGate(argv, scope.worktree);
        if (!Number.isInteger(result.exitCode) || typeof result.output !== 'string') throw new Error('invalid gate response');
        // A gate may rotate the claim; its CLI records evidence only for the live holder.
        const now = this.liveClaim();
        if (!now || now.claimId !== scope.claimId || now.featureId !== scope.featureId || now.nodeId !== scope.nodeId || !samePath(now.worktree, scope.worktree)) return fail('CHANNEL_CLAIM_STALE');
        const output = result.output.slice(0, 64 * 1024);
        return result.exitCode === 0
          ? { ok: true, sequence, exitCode: 0, output }
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
