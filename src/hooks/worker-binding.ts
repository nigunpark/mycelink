/**
 * Which claim a module-worker's call works for (CSET-203 r12), from records
 * the worker cannot write: Claude Code's own record of the subagent (its
 * meta, beside the session's transcript, names the Agent call that launched
 * it), the launch record the plugin's fence wrote at that Agent call
 * (hooks/provider-binding.ts: the feature, node, claim and dispatch its
 * prompt names), and the feature's live claim, which must still be that
 * one. Its worktree, branch, repository and common Git directory follow.
 * Used by the fence (whose stash entries a worker may take) and by the call
 * ledger (hooks/worker-calls.ts). A transcript or a command line alone binds
 * nothing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { loadGraph, loadRepositories } from '../workspace/workspace.js';
import { loadState } from '../state/feature-state.js';
import { isSafeFeatureId } from '../security/names.js';
import { workerBranchName } from '../git/worktree.js';
import { commonDirOf } from '../git/stash.js';
import { WORKER_LAUNCH_SCHEMA } from './provider-binding.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DISPATCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The subagent types Mycelink dispatches a node to. */
const WORKER_TYPES: ReadonlySet<string> = new Set(['mycelink:module-worker', 'module-worker']);

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The claim a module-worker's call works for, as Mycelink's own records name it when the call runs. */
export interface WorkerBinding {
  feature_id: string;
  node_id: string;
  claim_id: string;
  dispatch_id: string | null;
  capability_sha256: string | null;
  /** The host's Agent call that launched the worker. */
  launch_tool_use_id: string;
  worktree: string;
  branch: string;
  repository: string;
  repo_path: string;
  common_dir: string | null;
}

/**
 * The claim a module-worker's call works for: the subagent's meta (Claude
 * Code's record) names the Agent call that launched it; the launch record of
 * that call (the fence's) names the feature, node, claim and dispatch; the
 * feature's live claim must still be that one. Its worktree, branch,
 * repository and common Git directory follow.
 */
export function workerBinding(call: { session_id?: string; transcript_path?: string; agent_id?: string }, roots: readonly string[]): { binding: WorkerBinding | null; problem: string | null } {
  const agent = call.agent_id ?? '';
  const session = call.session_id ?? '';
  const transcript = call.transcript_path ?? '';
  if (!ID.test(agent) || !ID.test(session) || !isAbsolute(transcript) || basename(transcript) !== `${session}.jsonl`) return { binding: null, problem: 'the call names no subagent of a session with a transcript' };
  const meta = readJson(join(dirname(transcript), session, 'subagents', `agent-${agent}.meta.json`));
  if (meta === null) return { binding: null, problem: `no subagent meta for ${agent} beside the session's transcript` };
  const type = String(meta['agentType'] ?? '');
  if (!WORKER_TYPES.has(type)) return { binding: null, problem: `the subagent's meta names ${type || 'no type'}, not a module-worker` };
  const launch = String(meta['toolUseId'] ?? '');
  if (!ID.test(launch)) return { binding: null, problem: "the subagent's meta names no launching Agent call" };
  for (const root of roots) {
    const launches = join(root, '.mycelink', 'launches');
    for (const featureId of list(launches).filter(isSafeFeatureId)) {
      for (const dispatchId of list(join(launches, featureId)).filter((d) => DISPATCH.test(d))) {
        const record = readJson(join(launches, featureId, dispatchId, `launch-${launch}.json`));
        if (record === null) continue;
        if (record['schema'] !== WORKER_LAUNCH_SCHEMA || record['tool_use_id'] !== launch || record['session_id'] !== session || record['dispatch_id'] !== dispatchId) return { binding: null, problem: `the launch record of ${launch} is not this session's` };
        const nodeId = String(record['node_id'] ?? '');
        const claimId = String(record['claim_id'] ?? '');
        type HeldClaim = { claim_id: string; dispatch_id?: string | null; worktree: string | null; capability_sha256?: string };
        const held = (): HeldClaim | null => {
          try {
            return (loadState(join(root, 'features', featureId))?.data.nodes[nodeId]?.claim as HeldClaim | null | undefined) ?? null;
          } catch {
            return null;
          }
        };
        const claim = held();
        if (claim === null || claim.claim_id !== claimId || (claim.dispatch_id ?? null) !== dispatchId || claim.worktree === null) return { binding: null, problem: `the claim ${launch} was launched for is no longer held` };
        let repository: string | null = null;
        let repoPath: string | null = null;
        try {
          repository = loadGraph(root, featureId).nodes.find((n) => n.id === nodeId)?.repository ?? null;
          const decl = repository === null ? undefined : loadRepositories(root).repositories.find((r) => r.name === repository);
          repoPath = decl === undefined ? null : resolve(root, decl.path);
        } catch {
          repoPath = null;
        }
        if (repository === null || repoPath === null) return { binding: null, problem: `${nodeId} names no registered repository` };
        return {
          binding: {
            feature_id: featureId,
            node_id: nodeId,
            claim_id: claimId,
            dispatch_id: dispatchId,
            capability_sha256: claim.capability_sha256 ?? null,
            launch_tool_use_id: launch,
            worktree: resolve(claim.worktree),
            branch: workerBranchName(featureId, nodeId),
            repository,
            repo_path: repoPath,
            common_dir: commonDirOf(repoPath),
          },
          problem: null,
        };
      }
    }
  }
  return { binding: null, problem: `no launch record of the Agent call ${launch}` };
}
