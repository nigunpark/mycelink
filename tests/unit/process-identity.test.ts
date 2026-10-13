/**
 * Which process holds the controller, and is it still the same process?
 *
 * The with-faults arm of the second PCM-101 pilot killed the host session
 * mid-settle. Its settle marker named pid 5853; the resumed session ran in a
 * new PID namespace where a pid is only a number. A pid alone cannot say
 * "the process that wrote this is gone", so a process is identified by its
 * pid and its start (and, on Linux, the boot), and a pid whose current
 * process started later is a different process.
 *
 * The session a CLI call runs in is the Claude Code process named by
 * CLAUDE_PID, believed only when it really is an ancestor of the call.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { ancestry, isProcessAlive, processIdentity, processStartedAt, sessionHolder } from '../../src/util/process-identity.js';

afterAll(() => cleanupTmpRoots());

const sleeper = (): ReturnType<typeof spawn> => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });

async function exited(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((r) => child.once('exit', r));
}

describe('process identity', () => {
  it('identifies a live process by pid and start, and the same pid with another start is not it', () => {
    const me = processIdentity(process.pid)!;
    expect(me).toMatchObject({ pid: process.pid, host: hostname(), platform: process.platform });
    expect(me.start).toMatch(/\S/);
    expect(isProcessAlive(me)).toBe(true);
    expect(isProcessAlive({ ...me, start: me.start === '1' ? '2' : '1' })).toBe(false);
    if (me.boot !== null) expect(isProcessAlive({ ...me, boot: '00000000-0000-0000-0000-000000000000' })).toBe(false);
    // Another host cannot be judged from here.
    expect(isProcessAlive({ ...me, host: `${me.host}-elsewhere` })).toBeNull();
  });

  it('a process that exited is not alive, and an unused pid has no identity', async () => {
    const child = sleeper();
    const id = processIdentity(child.pid!)!;
    expect(isProcessAlive(id)).toBe(true);
    child.kill('SIGKILL');
    await exited(child);
    expect(isProcessAlive(id)).toBe(false);
    expect(processIdentity(2 ** 22 + 7)).toBeNull();
  });

  it('knows when a process started, so a marker older than the pid’s process names someone else', () => {
    const started = processStartedAt(process.pid)!;
    expect(started).toBeGreaterThan(Date.now() - 24 * 3600_000);
    expect(started).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('walks the ancestry of a process: parent first', () => {
    const chain = ancestry(process.pid);
    expect(chain[0]).toBe(process.ppid);
    expect(new Set(chain).size).toBe(chain.length);
  });
});

describe('the session a CLI call runs in', () => {
  const probe = (env: Record<string, string | undefined>, parentScript?: string): unknown => {
    const dir = makeTmpDir('holder-');
    const child = join(dir, 'child.mjs');
    const moduleUrl = new URL('../../build/util/process-identity.js', import.meta.url).href;
    writeFileSync(child, `import { sessionHolder } from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write(JSON.stringify(sessionHolder()));\n`);
    const clean = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>;
    if (parentScript === undefined) {
      return JSON.parse(spawnSync(process.execPath, [child], { env: clean, encoding: 'utf8' }).stdout);
    }
    // A parent process that runs the child, the way Claude Code runs a Bash call.
    const parent = join(dir, 'parent.mjs');
    writeFileSync(parent, parentScript.replace('__CHILD__', JSON.stringify(child)));
    return JSON.parse(spawnSync(process.execPath, [parent], { env: clean, encoding: 'utf8' }).stdout);
  };

  it('is the CLAUDE_PID process when it is a real ancestor', () => {
    const holder = probe(
      {},
      "import { spawnSync } from 'node:child_process';\nconst r = spawnSync(process.execPath, [__CHILD__], { env: { ...process.env, CLAUDE_PID: String(process.pid) }, encoding: 'utf8' });\nprocess.stdout.write(JSON.stringify({ parent: process.pid, holder: JSON.parse(r.stdout) }));\n",
    ) as { parent: number; holder: { pid: number } | null };
    expect(holder.holder).toMatchObject({ pid: holder.parent });
  });

  it('is nobody without CLAUDE_PID, or when CLAUDE_PID names a process that is not an ancestor', () => {
    expect(probe({ CLAUDE_PID: undefined })).toBeNull();
    const other = sleeper();
    try {
      expect(probe({ CLAUDE_PID: String(other.pid) })).toBeNull();
      expect(probe({ CLAUDE_PID: 'not-a-pid' })).toBeNull();
    } finally {
      other.kill('SIGKILL');
    }
  });
});
