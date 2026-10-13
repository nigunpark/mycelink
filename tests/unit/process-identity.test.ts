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
import { mkdirSync, writeFileSync } from 'node:fs';
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

  // CI 38443874383: every with-arm run on the Windows legs took ten times as long as on Linux. A CLI call or hook in a
  // session runs with the session's bare environment (evals lib/arms.mjs sessionEnv: no LOCALAPPDATA, its own home);
  // there `Get-CimInstance` had PowerShell analyse every module on its path to find the cmdlet, seconds a call on a
  // hosted runner's module path. The snapshot asks WMI itself and names no command PowerShell must discover.
  it.runIf(process.platform === 'win32')("costs a session's call the same whatever modules PowerShell's path holds", () => {
    const dir = makeTmpDir('holder-modules-');
    const modules = join(dir, 'Modules');
    for (let i = 0; i < 600; i++) {
      mkdirSync(join(modules, `M${i}`), { recursive: true });
      writeFileSync(join(modules, `M${i}`, `M${i}.psm1`), Array.from({ length: 20 }, (_, j) => `function Get-M${i}F${j} { $true }`).join('\n'));
      writeFileSync(join(modules, `M${i}`, `M${i}.psd1`), `@{ RootModule = 'M${i}.psm1'; ModuleVersion = '1.0'; GUID = '0d6c1a3e-1111-4222-8333-${String(i).padStart(12, '0')}'; FunctionsToExport = '*' }\n`);
    }
    const home = join(dir, 'home');
    mkdirSync(home);
    const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]));
    const system = process.env['SystemRoot'] ?? 'C:\\Windows';
    const env = { ...pick(['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR']), HOME: home, USERPROFILE: home, PSModulePath: `${modules};${system}\\System32\\WindowsPowerShell\\v1.0\\Modules` };
    const child = join(dir, 'child.mjs');
    const moduleUrl = new URL('../../build/util/process-identity.js', import.meta.url).href;
    writeFileSync(child, `import { sessionHolder } from ${JSON.stringify(moduleUrl)};\nconst t = Date.now();\nconst holder = sessionHolder();\nprocess.stdout.write(JSON.stringify({ holder, ms: Date.now() - t }));\n`);
    const parent = join(dir, 'parent.mjs');
    writeFileSync(parent, `import { spawnSync } from 'node:child_process';\nconst calls = [0, 1].map(() => JSON.parse(spawnSync(process.execPath, [${JSON.stringify(child)}], { env: { ...process.env, CLAUDE_PID: String(process.pid) }, encoding: 'utf8' }).stdout));\nprocess.stdout.write(JSON.stringify({ parent: process.pid, calls }));\n`);
    const r = spawnSync(process.execPath, [parent], { env, encoding: 'utf8' });
    const out = JSON.parse(r.stdout) as { parent: number; calls: { holder: { pid: number } | null; ms: number }[] };
    for (const call of out.calls) {
      expect(call.holder).toMatchObject({ pid: out.parent });
      // One process snapshot: a quarter of a second here; discovering the cmdlet on this path took seconds.
      expect(call.ms).toBeLessThan(3000);
    }
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
