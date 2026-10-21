/** Opt-in Codex exec worker transport for disposable registered repositories. */
import type { SpawnRequest } from './adapter.js';
import { ProcessSessionAdapter } from './process-session.js';
import type { ProviderStreamParser, StreamProgress } from './provider-stream.js';
import { buildWorkerPrompt, renderGateCommand, type WorkerGate } from './worker-protocol.js';
import type { ContextPack } from './context-pack.js';
import { CodexTranscriptReader } from './codex-transcript.js';
import { ClaimFileTransport } from './codex-claim-files.js';

export interface CodexCliAdapterOptions {
  executable: string;
  /** Only for controlled tests; not accepted from user configuration. */
  prefixArgs?: string[];
  extraArgs?: string[];
  sandbox?: 'read-only' | 'workspace-write';
  /** Supplied only after the controller validates disposable repository opt-in. */
  disposableRepositories?: boolean;
  /** Opt-in WSL transport; only the registered disposable Windows worktrees are mapped. */
  wsl?: { distribution: string; user: string };
  /** Controller-supplied control root and explicitly disposable repository roots. */
  gitTrustRoots?: string[];
}

const WSL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function wslCodexPrefix(wsl: { distribution: string; user: string }): string[] {
  if (!WSL_NAME.test(wsl.distribution) || !WSL_NAME.test(wsl.user)) throw new Error('WSL_CONFIG: invalid distribution or user');
  return ['-d', wsl.distribution, '-u', wsl.user, '--', '/usr/local/bin/npx', '--yes', '@openai/codex@0.163.0'];
}

export function windowsToWslPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (!/^[A-Za-z]:\//.test(normalized) || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('WSL_PATH: expected absolute drive path without traversal or control characters');
  }
  if (normalized.slice(3).split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('WSL_PATH: invalid path segment');
  }
  return `/mnt/${normalized[0]!.toLowerCase()}${normalized.slice(2)}`;
}

/** Usage in Codex turn.completed is the thread total, not an incremental turn delta. */
export class CodexStreamParser implements ProviderStreamParser {
  private readonly reader = new CodexTranscriptReader();
  evidence() { return this.reader.finish(); }
  consume(line: string, progress: StreamProgress): void {
    this.reader.consume(line);
    if (this.reader.finish().terminal === 'invalid') return;
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return;
    const e = event as Record<string, unknown>;
    if (e['type'] === 'turn.completed') {
      progress.turns += 1;
      const usage = e['usage'];
      if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
        const u = usage as Record<string, unknown>;
        if (typeof u['input_tokens'] === 'number' && Number.isFinite(u['input_tokens']) && u['input_tokens'] >= 0) progress.usage.input_tokens = u['input_tokens'];
        if (typeof u['output_tokens'] === 'number' && Number.isFinite(u['output_tokens']) && u['output_tokens'] >= 0) progress.usage.output_tokens = u['output_tokens'];
      }
    } else if (e['type'] === 'turn.failed') {
      progress.providerFailure = 'PROVIDER_FAILED: turn.failed (unclassified)';
    } else if (e['type'] === 'error') {
      // Retryable errors may precede a successful turn; terminal turn.failed is authoritative.
    }
  }
}

export class CodexCliAdapter extends ProcessSessionAdapter {
  readonly name = 'codex-cli' as const;
  protected readonly executable: string;
  protected readonly parser = new CodexStreamParser();
  protected override newParser(): ProviderStreamParser { return new CodexStreamParser(); }
  protected override readonly requireCompletedTurn = true;
  private readonly options: CodexCliAdapterOptions;
  constructor(options: CodexCliAdapterOptions) {
    super();
    // Do not let provider config override sandbox, approvals, cwd, JSON transport or stdin.
    if (options.extraArgs?.length) throw new Error('CODEX_ARGS_DENIED: arbitrary Codex exec flags are not allowed');
    if (options.wsl) {
      if (process.platform !== 'win32' || !options.disposableRepositories || options.sandbox === 'read-only') throw new Error('WSL_CONFIG: requires Windows disposable workspace-write workers');
      wslCodexPrefix(options.wsl);
      options.gitTrustRoots?.forEach(windowsToWslPath);
    }
    this.options = options;
    this.executable = options.executable;
  }
  gateLines(request: SpawnRequest): { gate: WorkerGate; line: string }[] {
    return (request.gateCommands ?? []).map((g) => {
      const argv = this.options.wsl && g.argv[0] === 'node' && g.argv[2] === 'tdd' && g.argv[6] === '--control-root'
        ? g.argv.map((arg, index) => index === 1 || index === 7 ? windowsToWslPath(arg) : arg)
        : g.argv;
      return { gate: g.gate, line: renderGateCommand(argv) };
    });
  }
  protected override workerPrompt(pack: ContextPack, request: SpawnRequest): string {
    const prompt = buildWorkerPrompt({ pack, gates: request.claimChannel ? [] : this.gateLines(request), provider: 'codex', mediated: !!request.claimChannel });
    if (!request.claimChannel) return prompt;
    const path = `.mycelink-worker/channel-${request.claimId}/client.mjs`;
    return `Controller-mediated gates and commits (only these commands, from this worktree):\n` +
      `node ${path} gate red\nnode ${path} gate green\nnode ${path} gate regression\n` +
      `node ${path} commit <message> <owned-path> [more-owned-paths]\n` +
      (pack.rework?.origin?.kind === 'acceptance-review'
        ? `For a passing exact review reproduction, use these read-only controller-mediated commands (no capability or direct control access):\n` +
          `node ${path} challenge <AC-id>\nnode ${path} check\n` +
          `The challenge response's output is JSON containing the challenge skeleton, criteria and passing test IDs. Fill the skeleton, write the result file, then check it.\n`
        : '') +
      `Use the returned output_sha256 and test_ids for criterion_evidence; a completed model turn alone proves nothing.\n` + prompt;
  }
  protected override startWorkerServices(request: SpawnRequest): (() => void) | undefined {
    if (!request.claimChannel) return undefined;
    const transport = new ClaimFileTransport(request.cwd, request.claimId, (input) => request.claimChannel!.handle(input),
      { ...process.env, ...request.claimChannel.redactEnv },
      { featureId: request.featureId, nodeId: request.nodeId });
    transport.start();
    return () => transport.stop();
  }
  buildArgs(request: SpawnRequest, _sessionId: string): string[] {
    if (request.addDirs?.length || request.allowedTools?.length || request.disallowedTools?.length) {
      throw new Error('CODEX_ARGS_DENIED: Claude tool and extra writable-directory grants cannot be translated safely');
    }
    const roots = this.options.wsl && this.options.gitTrustRoots?.length
      ? [...new Set([...this.options.gitTrustRoots, request.cwd].map(windowsToWslPath))] : [];
    const trust = roots.length ? ['/usr/bin/env', `GIT_CONFIG_COUNT=${roots.length}`,
      ...roots.flatMap((root, i) => [`GIT_CONFIG_KEY_${i}=safe.directory`, `GIT_CONFIG_VALUE_${i}=${root}`])] : [];
    const prefix = this.options.wsl ? wslCodexPrefix(this.options.wsl) : null;
    return [...(prefix ? [...prefix.slice(0, -3), ...trust, ...prefix.slice(-3)] : this.options.prefixArgs ?? []), 'exec', '--json', '--cd', this.options.wsl ? windowsToWslPath(request.cwd) : request.cwd,
      '--sandbox', this.options.sandbox ?? 'workspace-write',
      ...(process.platform === 'win32' && this.options.disposableRepositories === true && !this.options.wsl ? ['-c', 'windows.sandbox=mxc'] : []),
      ...(request.model === 'codex-default' ? [] : ['--model', request.model]), '-'];
  }
}
