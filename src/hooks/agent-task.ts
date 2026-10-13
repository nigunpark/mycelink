/**
 * The Agent task a host's launch started, bound to that launch (CSET-203 r13).
 *
 * When the host session's Agent call for the acceptance reviewer or a
 * module-worker returns (PostToolUse) — at once for a background agent,
 * whose completion Claude Code records later, as a notification — Claude
 * Code names the agent it started (`agentId`) and its status
 * (`async_launched`, or `completed` for a foreground call). The plugin
 * records that beside the launch its fence recorded
 * (`agent-<tool_use_id>.json`, created exclusively): the durable binding of a
 * dispatch to its Agent task, which outlives the controller's session. The
 * reviewer's lifecycle (engine/review-transport.ts) reads it as the agent's
 * id while the session's own record of the call is not there yet, and
 * refuses it when the two disagree. Never the prompt, the output file or an
 * answer. Nothing here decides anything; recording never blocks or throws.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ACCEPTANCE_REVIEWER, MODULE_WORKER, controlRoots, type FenceInput } from './fence.js';
import { createExclusive } from '../engine/review-transport.js';

export const AGENT_TASK_SCHEMA = 'mycelink-agent-task/1';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATUS = /^[a-z_-]{1,32}$/;
const MAX_DIRS = 2048;

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir).slice(0, MAX_DIRS);
  } catch {
    return [];
  }
};

/** The directory holding the fence's record of launch `U`: a review generation's, or a worker dispatch's. */
function launchDir(root: string, U: string, reviewer: boolean): string | null {
  const name = `launch-${U}.json`;
  if (reviewer) {
    const reviews = join(root, '.mycelink', 'reviews');
    for (const feature of list(reviews)) {
      for (const review of list(join(reviews, feature))) {
        for (const dispatch of list(join(reviews, feature, review))) {
          const dir = join(reviews, feature, review, dispatch);
          if (existsSync(join(dir, name))) return dir;
        }
      }
    }
    return null;
  }
  const launches = join(root, '.mycelink', 'launches');
  for (const feature of list(launches)) {
    for (const dispatch of list(join(launches, feature))) {
      const dir = join(launches, feature, dispatch);
      if (existsSync(join(dir, name))) return dir;
    }
  }
  return null;
}

/** Record the Agent task a host's reviewer or worker launch started; the record's path, or null. */
export function recordAgentTask(call: FenceInput & { tool_response?: unknown }, env: NodeJS.ProcessEnv): string | null {
  try {
    if (call.tool_name !== 'Agent' && call.tool_name !== 'Task') return null;
    // A subagent's call is no host's launch.
    if (typeof call.agent_id === 'string' && call.agent_id !== '') return null;
    const U = call.tool_use_id;
    const S = call.session_id;
    if (typeof U !== 'string' || !ID.test(U) || typeof S !== 'string' || !ID.test(S)) return null;
    const type = String((call.tool_input ?? {})['subagent_type'] ?? '');
    const reviewer = type === ACCEPTANCE_REVIEWER || type === 'acceptance-reviewer';
    if (!reviewer && type !== MODULE_WORKER && type !== 'module-worker') return null;
    const response = call.tool_response;
    const r = response !== null && typeof response === 'object' && !Array.isArray(response) ? (response as Record<string, unknown>) : {};
    const text = typeof response === 'string' ? response : JSON.stringify(r['content'] ?? '');
    const agentId = typeof r['agentId'] === 'string' ? (r['agentId'] as string) : (/\bagentId: ([A-Za-z0-9_-]{1,64})\b/.exec(text)?.[1] ?? null);
    if (agentId === null || !AGENT_ID.test(agentId)) return null;
    const status = typeof r['status'] === 'string' && STATUS.test(r['status'] as string) ? (r['status'] as string) : null;
    for (const root of controlRoots([typeof call.cwd === 'string' ? call.cwd : undefined, env['CLAUDE_PROJECT_DIR'], env['MYCELINK_CONTROL_ROOT']], [])) {
      const dir = launchDir(root, U, reviewer);
      if (dir === null) continue;
      const file = join(dir, `agent-${U}.json`);
      createExclusive(file, JSON.stringify({ schema: AGENT_TASK_SCHEMA, tool_use_id: U, session_id: S, agent_id: agentId, subagent_type: type, status, async: r['isAsync'] === true || status === 'async_launched', at: new Date().toISOString() }, null, 2) + '\n');
      return file;
    }
    return null;
  } catch {
    return null;
  }
}
