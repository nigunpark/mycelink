/**
 * Claude Code's own records of a host session, as 2.1.290 keeps them on disk
 * (CSET-203 r8's artifact, tests/benchmark/fixtures/cset203-r8):
 *
 *   <config>/projects/<project>/<session>.jsonl                  the session's transcript
 *   <config>/projects/<project>/<session>/subagents/agent-<id>.jsonl      a subagent's transcript
 *   <config>/projects/<project>/<session>/subagents/agent-<id>.meta.json  its meta (agentType, toolUseId)
 *
 * A host's Agent call goes through the plugin's PreToolUse hook exactly as
 * Claude Code runs it (`mycelink hook controller-fence`, the call's
 * tool_use id, the session and its transcript), then the session records
 * the call and its result (a background agent: "Async agent launched",
 * naming the agent), the subagent's transcript opens with the prompt, and
 * its completion arrives in the session as a task notification carrying its
 * final answer. Nothing here is Mycelink's: the controller reads it.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { main, type CliIo } from '../../src/cli/cli.js';
import { makeTmpDir } from './tmp.js';
import { runWithInput } from '../../src/util/child-stdin.js';

export const VERSION = '2.1.290';
export const MODEL = 'claude-stand-in-5';

export interface ClaudeSession {
  config: string;
  projects: string;
  sessionId: string;
  /** The session's transcript. */
  transcript: string;
  cwd: string;
}

export interface LaunchedAgent {
  agentId: string;
  toolUseId: string;
  subagentType: string;
  description: string;
  prompt: string;
  transcript: string;
  meta: string;
  background: boolean;
}

const now = (): string => new Date().toISOString();
const uuid = (): string => randomUUID();
const toolId = (): string => `toolu_${randomBytes(12).toString('hex')}`;

/** A fresh host session working in `cwd`, its config directory of its own. */
export function claudeSession(cwd: string, options: { config?: string } = {}): ClaudeSession {
  const config = options.config ?? join(makeTmpDir('claude-config-'), '.claude');
  const projects = join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projects, { recursive: true });
  const sessionId = uuid();
  return { config, projects, sessionId, transcript: join(projects, `${sessionId}.jsonl`), cwd };
}

const append = (file: string, entry: Record<string, unknown>): void => appendFileSync(file, `${JSON.stringify(entry)}\n`);

/** One line of the session's own transcript. */
export function sessionEntry(s: ClaudeSession, entry: Record<string, unknown>): void {
  append(s.transcript, { parentUuid: null, isSidechain: false, uuid: uuid(), timestamp: now(), userType: 'external', entrypoint: 'sdk-cli', cwd: s.cwd, sessionId: s.sessionId, version: VERSION, ...entry });
}

/** One line of a subagent's transcript. */
export function agentEntry(s: ClaudeSession, a: LaunchedAgent, entry: Record<string, unknown>): void {
  append(a.transcript, { parentUuid: null, isSidechain: true, agentId: a.agentId, uuid: uuid(), timestamp: now(), userType: 'external', entrypoint: 'sdk-cli', cwd: s.cwd, sessionId: s.sessionId, version: VERSION, ...entry });
}

/**
 * The plugin's PreToolUse hook for a host-session tool call, as Claude Code
 * runs it: its exit code and block reason. In-process, or through the shipped
 * launcher (`launcher`: bin/mycelink.mjs) as a hook command runs.
 */
export async function hostToolHook(s: ClaudeSession, tool: string, input: Record<string, unknown>, toolUseId: string, launcher?: string): Promise<{ code: number; err: string }> {
  const stdin = JSON.stringify({ session_id: s.sessionId, transcript_path: s.transcript, cwd: s.cwd, permission_mode: 'dontAsk', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: toolUseId });
  if (launcher !== undefined) {
    const r = runWithInput(process.execPath, [launcher, 'hook', 'controller-fence'], { input: stdin, cwd: s.cwd, encoding: 'utf8', windowsHide: true });
    return { code: r.status ?? 1, err: r.stderr };
  }
  let err = '';
  const io: CliIo = { out: () => undefined, err: (t) => (err += t + '\n'), stdin };
  const code = await main(['hook', 'controller-fence'], io);
  return { code, err };
}

/**
 * The host's Agent call: through the plugin's hook (unless `hook: false`),
 * then the session's record of it and, for a background agent (the
 * default), its launch result naming the agent; the subagent's meta and the
 * prompt that opens its transcript.
 */
export async function launchAgent(s: ClaudeSession, input: { subagent_type: string; description: string; prompt: string }, options: { hook?: boolean; background?: boolean; agentId?: string; launcher?: string; toolUseId?: string } = {}): Promise<{ agent: LaunchedAgent; hook: { code: number; err: string } | null }> {
  const toolUseId = options.toolUseId ?? toolId();
  const hook = options.hook === false ? null : await hostToolHook(s, 'Agent', input, toolUseId, options.launcher);
  if (hook !== null && hook.code !== 0) throw new Error(`the plugin's hook refused the Agent call: ${hook.err}`);
  const agentId = options.agentId ?? `a${randomBytes(8).toString('hex')}`;
  const dir = join(s.projects, s.sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const background = options.background !== false;
  const agent: LaunchedAgent = { agentId, toolUseId, subagentType: input.subagent_type, description: input.description, prompt: input.prompt, transcript: join(dir, `agent-${agentId}.jsonl`), meta: join(dir, `agent-${agentId}.meta.json`), background };
  sessionEntry(s, { type: 'assistant', message: { model: MODEL, id: `msg_${randomBytes(10).toString('hex')}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input }], stop_reason: 'tool_use' } });
  writeFileSync(agent.meta, JSON.stringify({ agentType: input.subagent_type, description: input.description, toolUseId, spawnDepth: 1, requestShape: background ? 'background' : 'foreground', requestNonInteractive: true }));
  agentEntry(s, agent, { type: 'user', message: { role: 'user', content: input.prompt } });
  if (background) {
    sessionEntry(s, {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes.` }] }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId, description: input.description, prompt: input.prompt, outputFile: join(s.config, 'tasks', `${agentId}.output`), canReadOutputFile: true },
    });
  }
  return { agent, hook };
}

/** A tool call of the subagent and its result, in its transcript. */
export function agentToolCall(s: ClaudeSession, a: LaunchedAgent, tool: string, input: Record<string, unknown>, result: string): void {
  const id = toolId();
  agentEntry(s, a, { type: 'assistant', message: { model: MODEL, id: `msg_${randomBytes(10).toString('hex')}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }], stop_reason: 'tool_use' }, attributionAgent: a.subagentType, attributionPlugin: 'mycelink' });
  agentEntry(s, a, { type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: result }] } });
}

/**
 * The subagent's final message (a thinking block, then its text) and its
 * completion as the session records it: a background agent's task
 * notification carrying the answer, or a foreground call's result.
 */
export function finishAgent(s: ClaudeSession, a: LaunchedAgent, text: string, options: { stopReason?: string; status?: 'completed' | 'failed' | 'killed'; notify?: boolean | 'queued' } = {}): void {
  const id = `msg_${randomBytes(10).toString('hex')}`;
  const base = { model: MODEL, id, type: 'message', role: 'assistant' };
  agentEntry(s, a, { type: 'assistant', message: { ...base, content: [{ type: 'thinking', thinking: '', signature: 'sig' }], stop_reason: null }, attributionAgent: a.subagentType, attributionPlugin: 'mycelink' });
  agentEntry(s, a, { type: 'assistant', message: { ...base, content: [{ type: 'text', text }], stop_reason: options.stopReason ?? 'end_turn' }, attributionAgent: a.subagentType, attributionPlugin: 'mycelink' });
  if (options.notify === false) return;
  if (options.notify === 'queued') notifyQueued(s, a, text, options.status ?? 'completed');
  else notifyCompleted(s, a, text, options.status ?? 'completed');
}

/** A background agent's task notification, as 2.1.290 words it. */
export function notificationText(s: ClaudeSession, a: LaunchedAgent, text: string, status: string = 'completed', toolUseId: string = a.toolUseId): string {
  return `<task-notification>\n<task-id>${a.agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>${join(s.config, 'tasks', `${a.agentId}.output`)}</output-file>\n<status>${status}</status>\n<summary>Agent "${a.description}" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>${text}</result>\n<usage><subagent_tokens>2000</subagent_tokens><tool_uses>2</tool_uses><duration_ms>1000</duration_ms></usage>\n</task-notification>`;
}

/**
 * A completion that arrives while the host is mid-turn, as 2.1.290 records it
 * (CSET-203 r13: the controller sat in `sleep 240`): the notification is
 * enqueued at once — a queue operation, never a user message — and, once the
 * host's turn absorbs it (`absorbed`, the default), an attachment of the
 * queued command and the queue operation's removal follow.
 */
export function notifyQueued(s: ClaudeSession, a: LaunchedAgent, text: string, status: string = 'completed', options: { absorbed?: boolean; toolUseId?: string } = {}): void {
  const content = notificationText(s, a, text, status, options.toolUseId);
  append(s.transcript, { type: 'queue-operation', operation: 'enqueue', timestamp: now(), sessionId: s.sessionId, content });
  if (options.absorbed === false) return;
  sessionEntry(s, { type: 'attachment', attachment: { type: 'queued_command', prompt: content, commandMode: 'task-notification' } });
  append(s.transcript, { type: 'queue-operation', operation: 'remove', timestamp: now(), sessionId: s.sessionId, content, reason: 'absorbed_mid_turn', commandUuid: uuid(), deliveryId: uuid() });
}

/** The subagent's completion as the session records it, whatever its transcript holds: a task notification, or a foreground call's result. */
export function notifyCompleted(s: ClaudeSession, a: LaunchedAgent, text: string, status: 'completed' | 'failed' | 'killed' = 'completed'): void {
  if (a.background) {
    sessionEntry(s, {
      type: 'user',
      message: { role: 'user', content: notificationText(s, a, text, status) },
      origin: { kind: 'task-notification', producer: 'session-task' },
      promptSource: 'system',
      turnOrigin: 'task_notification',
    });
  } else {
    sessionEntry(s, {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: a.toolUseId, type: 'tool_result', content: [{ type: 'text', text }, { type: 'text', text: `agentId: ${a.agentId}` }] }] },
      toolUseResult: { status, prompt: a.prompt, agentId: a.agentId, content: [{ type: 'text', text }], totalDurationMs: 1000, totalTokens: 2000, totalToolUseCount: 2 },
    });
  }
}

/** Remove a session's records (a session whose transcripts are gone). */
export function forgetSession(s: ClaudeSession): void {
  rmSync(s.projects, { recursive: true, force: true });
}
