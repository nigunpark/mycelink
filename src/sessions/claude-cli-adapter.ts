/** Claude Code CLI argv and permission policy; process lifecycle lives in process-session.ts. */
import { type SpawnRequest } from './adapter.js';
import { ProcessSessionAdapter } from './process-session.js';
import { ClaudeStreamParser } from './provider-stream.js';
import { WORKER_RESULT_GRANT, renderGateCommand, type WorkerGate } from './worker-protocol.js';

export interface ClaudeCliAdapterOptions {
  executable: string;
  prefixArgs?: string[];
  extraArgs?: string[];
  adapterName?: 'fake-claude' | 'claude-background';
  mode?: 'print' | 'background';
  permissionMode?: string;
  allowPermissionBypass?: boolean;
}

export class PermissionPolicyError extends Error {
  constructor(detail: string) {
    super(
      `${detail} disables Claude Code's permission system for every worker session. ` +
        'Set allow_dangerous_permission_bypass: true in mycelink.config.json only if workers run in a disposable sandbox.',
    );
    this.name = 'PermissionPolicyError';
  }
}

export function permissionBypassFlag(args: readonly string[], permissionMode?: string): string | null {
  if (permissionMode === 'bypassPermissions') return '--permission-mode bypassPermissions';
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--dangerously-skip-permissions' || a === '--allow-dangerously-skip-permissions') return a;
    if (a === '--permission-mode=bypassPermissions') return a;
    if (a === '--permission-mode' && args[i + 1] === 'bypassPermissions') return `${a} ${args[i + 1]}`;
  }
  return null;
}

export class ClaudeCliAdapter extends ProcessSessionAdapter {
  readonly name: 'fake-claude' | 'claude-background';
  protected readonly executable: string;
  protected readonly parser = new ClaudeStreamParser();
  private readonly options: ClaudeCliAdapterOptions;

  constructor(options: ClaudeCliAdapterOptions) {
    super();
    const bypass = permissionBypassFlag(
      [...(options.prefixArgs ?? []), ...(options.extraArgs ?? [])], options.permissionMode,
    );
    if (bypass !== null && options.allowPermissionBypass !== true) throw new PermissionPolicyError(bypass);
    this.options = options;
    this.executable = options.executable;
    this.name = options.adapterName ?? 'claude-background';
  }

  gateLines(request: SpawnRequest): { gate: WorkerGate; line: string }[] {
    return (request.gateCommands ?? []).map((g) => ({ gate: g.gate, line: renderGateCommand(g.argv) }));
  }

  buildArgs(request: SpawnRequest, sessionId: string): string[] {
    const args = [...(this.options.prefixArgs ?? [])];
    args.push('-p');
    args.push('--output-format', 'stream-json', '--verbose');
    args.push('--model', request.model);
    args.push('--session-id', sessionId);
    if (this.options.mode === 'background') args.push('--bg');
    if (this.options.permissionMode) args.push('--permission-mode', this.options.permissionMode);
    for (const dir of request.addDirs ?? []) args.push('--add-dir', dir);
    args.push(
      '--allowed-tools', WORKER_RESULT_GRANT,
      ...this.gateLines(request).map((g) => `Bash(${g.line})`),
      ...(request.allowedTools ?? []),
    );
    if (request.disallowedTools && request.disallowedTools.length > 0) {
      args.push('--disallowed-tools', ...request.disallowedTools);
    }
    args.push(...(this.options.extraArgs ?? []));
    return args;
  }
}
