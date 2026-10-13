/**
 * Which model session holds a dispatch, recorded where only Mycelink
 * writes, so a provider failure of that session can be read from Claude
 * Code's own records (engine/provider-interrupt.ts; CSET-203 r10).
 *
 *  - The host binding: when the host session runs Mycelink's `dispatch`
 *    through its Bash tool, the plugin's PreToolUse fence records the
 *    session and its transcript as Claude Code named them to the hook
 *    (`.mycelink/hosts/<session>.json`), just before the command runs. The
 *    claim or review generation that dispatch issues binds it.
 *  - A worker launch: the host's Agent call for `mycelink:module-worker`
 *    whose prompt names a live claim's `Dispatch:` is recorded for that
 *    dispatch (`.mycelink/launches/<feature>/<dispatch>/launch-<tool use id>.json`),
 *    as a reviewer's launch is for its generation (hooks/review-launch.ts).
 *
 * A subagent's call (it carries an agent id) is no host's. Recording never
 * blocks the call; nothing here decides anything.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadState } from '../state/feature-state.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import { isSafeFeatureId } from '../security/names.js';
import { createExclusive } from '../engine/review-transport.js';
import { controlRoots } from './fence.js';
import type { HostSessionBinding } from '../model/types.js';
import { sessionHolder, type ProcessIdentity } from '../util/process-identity.js';

export const HOST_BINDING_SCHEMA = 'mycelink-host-binding/1';
export const WORKER_LAUNCH_SCHEMA = 'mycelink-worker-launch/1';
/** A binding older than this binds no new dispatch: the hook runs just before the command. */
export const HOST_BINDING_FRESH_MS = 10 * 60_000;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DISPATCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DISPATCH_LINE = /^Dispatch: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/m;

/** The host's Bash or Agent call, as the hook's input names it. */
export interface HostCall {
  session_id: string;
  transcript_path: string;
  cwd: string;
  tool_use_id?: string;
}

const slash = (p: string): string => p.replace(/\\/g, '/');
const wellFormed = (c: HostCall): boolean => ID.test(c.session_id) && isAbsolute(c.transcript_path) && basename(c.transcript_path) === `${c.session_id}.jsonl`;

/** A Bash command that runs Mycelink's `dispatch` (the host's own, a resume's). */
export function runsDispatch(command: string): boolean {
  return /mycelink/i.test(command) && /(?:^|[\s'"])dispatch(?:[\s'"]|$)/.test(command);
}

/** Record the host session about to run `dispatch`, in every control repository near it. Returns the files written. */
export function recordHostBinding(call: HostCall, env: NodeJS.ProcessEnv): string[] {
  if (!wellFormed(call)) return [];
  const written: string[] = [];
  for (const root of controlRoots([call.cwd, env['CLAUDE_PROJECT_DIR'], env['MYCELINK_CONTROL_ROOT']], [])) {
    const dir = join(root, '.mycelink', 'hosts');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${call.session_id}.json`);
    writeTextAtomic(file, JSON.stringify({ schema: HOST_BINDING_SCHEMA, session_id: call.session_id, transcript_path: slash(call.transcript_path), cwd: slash(call.cwd), at: new Date().toISOString() }, null, 2) + '\n');
    written.push(file);
  }
  return written;
}

/** The host session that most recently ran `dispatch` here, if within HOST_BINDING_FRESH_MS. */
export function currentHostBinding(controlRoot: string, now = Date.now()): HostSessionBinding | null {
  const dir = join(controlRoot, '.mycelink', 'hosts');
  if (!existsSync(dir)) return null;
  let best: HostSessionBinding | null = null;
  for (const name of readdirSync(dir)) {
    if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(name)) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
      if (r['schema'] !== HOST_BINDING_SCHEMA || typeof r['session_id'] !== 'string' || typeof r['transcript_path'] !== 'string' || typeof r['at'] !== 'string') continue;
      if (`${r['session_id']}.json` !== name || !wellFormed({ session_id: r['session_id'], transcript_path: r['transcript_path'], cwd: '' })) continue;
      const at = Date.parse(r['at']);
      if (!Number.isFinite(at) || now - at > HOST_BINDING_FRESH_MS || at - now > 60_000) continue;
      if (best === null || r['at'] > best.bound_at) best = { session_id: r['session_id'], transcript_path: r['transcript_path'], bound_at: r['at'] };
    } catch {
      continue;
    }
  }
  return best;
}

/** The host session's Claude Code process, when the hook can verify it (util/process-identity.ts); null otherwise. */
function holderOf(env: NodeJS.ProcessEnv): ProcessIdentity | null {
  try {
    return sessionHolder(env);
  } catch {
    return null;
  }
}

/** Where the launches of a worker dispatch are recorded. */
export function workerLaunchDir(controlRoot: string, featureId: string, dispatchId: string): string {
  return join(controlRoot, '.mycelink', 'launches', featureId, dispatchId);
}

/** Record the host's Agent call for a module-worker whose prompt names a live claim's dispatch. The record's path, or null. */
export function recordWorkerLaunch(call: HostCall & { prompt: string; subagent_type: string }, env: NodeJS.ProcessEnv): string | null {
  if (!wellFormed(call) || typeof call.tool_use_id !== 'string' || !ID.test(call.tool_use_id)) return null;
  const dispatchId = DISPATCH_LINE.exec(call.prompt)?.[1] ?? null;
  if (dispatchId === null || !DISPATCH.test(dispatchId)) return null;
  for (const root of controlRoots([call.cwd, env['CLAUDE_PROJECT_DIR'], env['MYCELINK_CONTROL_ROOT']], [])) {
    let features: string[] = [];
    try {
      features = readdirSync(join(root, 'features')).filter(isSafeFeatureId);
    } catch {
      continue;
    }
    for (const featureId of features) {
      let held: [string, { claim_id: string }] | undefined;
      try {
        const state = loadState(join(root, 'features', featureId))?.data;
        held = Object.entries(state?.nodes ?? {})
          .filter(([, rt]) => rt.claim?.dispatch_id === dispatchId)
          .map(([id, rt]) => [id, { claim_id: (rt.claim as { claim_id: string }).claim_id }] as [string, { claim_id: string }])[0];
      } catch {
        continue;
      }
      if (held === undefined) continue;
      const dir = workerLaunchDir(root, featureId, dispatchId);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `launch-${call.tool_use_id}.json`);
      createExclusive(
        file,
        JSON.stringify(
          {
            schema: WORKER_LAUNCH_SCHEMA,
            feature_id: featureId,
            node_id: held[0],
            claim_id: held[1].claim_id,
            dispatch_id: dispatchId,
            tool_use_id: call.tool_use_id,
            session_id: call.session_id,
            transcript_path: slash(call.transcript_path),
            subagent_type: call.subagent_type,
            prompt_sha256: createHash('sha256').update(call.prompt).digest('hex'),
            at: new Date().toISOString(),
            // The host session's Claude Code process: a background worker runs inside it (engine/worker-lifecycle.ts).
            holder: holderOf(env),
          },
          null,
          2,
        ) + '\n',
      );
      return file;
    }
  }
  return null;
}
