/** Opt-in Codex exec worker transport for disposable registered repositories. */
import type { SpawnRequest } from './adapter.js';
import { ProcessSessionAdapter } from './process-session.js';
import type { ProviderStreamParser, StreamProgress } from './provider-stream.js';
import { buildWorkerPrompt, renderGateCommand, type WorkerGate } from './worker-protocol.js';
import type { ContextPack } from './context-pack.js';
import { CodexTranscriptReader } from './codex-transcript.js';

export interface CodexCliAdapterOptions {
  executable: string;
  /** Only for controlled tests; not accepted from user configuration. */
  prefixArgs?: string[];
  extraArgs?: string[];
  sandbox?: 'read-only' | 'workspace-write';
  /** Supplied only after the controller validates disposable repository opt-in. */
  disposableRepositories?: boolean;
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
    this.options = options;
    this.executable = options.executable;
  }
  gateLines(request: SpawnRequest): { gate: WorkerGate; line: string }[] {
    return (request.gateCommands ?? []).map((g) => ({ gate: g.gate, line: renderGateCommand(g.argv) }));
  }
  protected override workerPrompt(pack: ContextPack, request: SpawnRequest): string {
    return buildWorkerPrompt({ pack, gates: this.gateLines(request), provider: 'codex' });
  }
  buildArgs(request: SpawnRequest, _sessionId: string): string[] {
    if (request.addDirs?.length || request.allowedTools?.length || request.disallowedTools?.length) {
      throw new Error('CODEX_ARGS_DENIED: Claude tool and extra writable-directory grants cannot be translated safely');
    }
    return [...(this.options.prefixArgs ?? []), 'exec', '--json', '--cd', request.cwd,
      '--sandbox', this.options.sandbox ?? 'workspace-write',
      ...(process.platform === 'win32' && this.options.disposableRepositories === true ? ['-c', 'windows.sandbox=mxc'] : []),
      ...(request.model === 'codex-default' ? [] : ['--model', request.model]), '-'];
  }
}
