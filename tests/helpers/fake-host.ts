/**
 * Host sessions as real processes, for tests that kill one and start a
 * fresh one: every `mycelink` call runs as a child of the host process with
 * CLAUDE_PID naming it (see fake-host.mjs).
 */
import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

export interface HostRun {
  code: number | null;
  signal: string | null;
  out: string;
  err: string;
}

const SCRIPT = resolve(process.cwd(), 'tests', 'helpers', 'fake-host.mjs');
const BIN = resolve(process.cwd(), 'bin', 'mycelink.mjs');

export class FakeHost {
  private seq = 0;
  private readonly waiting = new Map<number, (r: HostRun) => void>();

  private constructor(readonly child: ChildProcess) {
    child.on('message', (msg: { id?: number } & HostRun) => {
      if (typeof msg.id !== 'number') return;
      this.waiting.get(msg.id)?.(msg);
      this.waiting.delete(msg.id);
    });
  }

  /** A new host session. `env` is its whole environment (the test's own CLAUDE_PID is never inherited). */
  static async start(env: NodeJS.ProcessEnv = process.env): Promise<FakeHost> {
    const own = { ...env };
    delete own['CLAUDE_PID'];
    delete own['CLAUDECODE'];
    const child = fork(SCRIPT, [BIN], { env: own, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
    await new Promise<void>((ready, fail) => {
      child.once('error', fail);
      child.once('message', () => ready());
    });
    return new FakeHost(child);
  }

  get pid(): number {
    return this.child.pid as number;
  }

  /** Run `mycelink <argv>` as a child of this host. */
  run(argv: string[], options: { env?: Record<string, string>; unset?: string[]; cwd?: string } = {}): Promise<HostRun> {
    const id = ++this.seq;
    return new Promise((done) => {
      this.waiting.set(id, done);
      this.child.send({ id, argv, ...options });
    });
  }

  /** The host session dies: killed hard, nothing cleaned up. */
  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const gone = new Promise((r) => this.child.once('exit', r));
    this.child.kill('SIGKILL');
    await gone;
  }
}
