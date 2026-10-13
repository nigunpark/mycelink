/**
 * Which process is it, and is it still that process?
 *
 * A pid alone is a number: after a crash, a reboot or in another PID
 * namespace (the benchmark runs each session in a fresh one) it names
 * someone else. A process is identified here by its pid and its start, on
 * Linux also by the boot it belongs to, so "the process that wrote this
 * marker is gone" is decided by identity, never by a pid that happens to
 * exist.
 *
 * The session a CLI call runs in is the Claude Code process that runs its
 * Bash calls and their subagents. Claude Code exports its own pid as
 * CLAUDE_PID; a value is believed only when that process really is an
 * ancestor of the call, so an environment variable alone never names a
 * holder.
 *
 * Linux reads /proc; macOS asks `ps`; Windows takes one CIM snapshot through
 * PowerShell. Anything that cannot be determined answers null: callers
 * treat an unknown as "cannot prove it is gone".
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

export interface ProcessIdentity {
  pid: number;
  /** The OS's own start of the process: clock ticks since boot on Linux, an absolute time elsewhere. */
  start: string;
  /** The boot the process belongs to (Linux boot_id), or null where starts are absolute. */
  boot: string | null;
  host: string;
  platform: string;
}

interface ProcessInfo {
  pid: number;
  ppid: number | null;
  start: string;
  /** When it started, ms since the epoch, when known. */
  startedAt: number | null;
  zombie: boolean;
}

type Snapshot = Map<number, ProcessInfo>;

let clockTicks: number | null = null;
function linuxClockTicks(): number {
  if (clockTicks === null) {
    const r = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5_000 });
    const n = Number((r.stdout ?? '').trim());
    clockTicks = Number.isInteger(n) && n > 0 ? n : 100;
  }
  return clockTicks;
}

function linuxBootTimeMs(): number | null {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n').find((l) => l.startsWith('btime '));
    const seconds = Number(line?.slice(6).trim());
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

function linuxBootId(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function linuxInfo(pid: number): ProcessInfo | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // The command name is parenthesised and may hold spaces or parentheses itself.
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  const state = fields[0] ?? '';
  const ppid = Number(fields[1]);
  const ticks = fields[19];
  if (ticks === undefined || !/^\d+$/.test(ticks)) return null;
  const boot = linuxBootTimeMs();
  return {
    pid,
    ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
    start: ticks,
    startedAt: boot === null ? null : boot + (Number(ticks) / linuxClockTicks()) * 1000,
    zombie: state === 'Z' || state === 'X',
  };
}

function darwinInfo(pid: number): ProcessInfo | null {
  const r = spawnSync('ps', ['-o', 'ppid=,stat=,lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 });
  const line = (r.stdout ?? '').trim();
  if (r.status !== 0 || line === '') return null;
  const parts = line.split(/\s+/);
  const ppid = Number(parts[0]);
  const lstart = parts.slice(2).join(' ');
  const startedAt = Date.parse(lstart);
  return {
    pid,
    ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
    start: lstart,
    startedAt: Number.isNaN(startedAt) ? null : startedAt,
    zombie: (parts[1] ?? '').startsWith('Z'),
  };
}

/**
 * Every process on a Windows machine, from one WMI query. It asks WMI itself (a WQL searcher, the three properties
 * only) and names no cmdlet: `Get-CimInstance` had PowerShell discover its module first, which in a session's bare
 * environment meant analysing every module on its path — seconds a call on a hosted runner (CI 38443874383). The start
 * it reads is the one Get-CimInstance gave, to the digit: identities recorded before compare equal.
 */
function windowsSnapshot(): Snapshot | null {
  const script =
    "foreach ($p in ([wmisearcher]'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process').Get()) { $c = ''; if ($p.CreationDate) { $c = [Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).ToUniversalTime().ToString('o') }; '{0}|{1}|{2}' -f $p.ProcessId, $p.ParentProcessId, $c }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  const table: Snapshot = new Map();
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const [pidText, ppidText, created] = line.trim().split('|');
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || created === undefined || created === '') continue;
    const ppid = Number(ppidText);
    const startedAt = Date.parse(created);
    table.set(pid, { pid, ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null, start: created, startedAt: Number.isNaN(startedAt) ? null : startedAt, zombie: false });
  }
  return table;
}

function snapshot(): Snapshot | null {
  return process.platform === 'win32' ? windowsSnapshot() : null;
}

function info(pid: number, table: Snapshot | null = null): ProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') return (table ?? windowsSnapshot())?.get(pid) ?? null;
  if (process.platform === 'linux') return linuxInfo(pid);
  if (process.platform === 'darwin') return darwinInfo(pid);
  return null;
}

function identityOf(found: ProcessInfo): ProcessIdentity {
  return {
    pid: found.pid,
    start: found.start,
    boot: process.platform === 'linux' ? linuxBootId() : null,
    host: hostname(),
    platform: process.platform,
  };
}

/** The identity of a running process, or null when there is none (or it is a zombie). */
export function processIdentity(pid: number): ProcessIdentity | null {
  const found = info(pid);
  return found === null || found.zombie ? null : identityOf(found);
}

/** When a running process started (ms since the epoch), when the OS says. */
export function processStartedAt(pid: number): number | null {
  const found = info(pid);
  return found === null || found.zombie ? null : found.startedAt;
}

/**
 * Whether the process `identity` names is still running: true or false on
 * this host, null for another host (nothing here can tell).
 */
export function isProcessAlive(identity: ProcessIdentity): boolean | null {
  if (identity.host !== hostname()) return null;
  if (identity.boot !== null && process.platform === 'linux' && identity.boot !== linuxBootId()) return false;
  const found = info(identity.pid);
  return found !== null && !found.zombie && found.start === identity.start;
}

function startedBefore(parent: ProcessInfo, child: ProcessInfo): boolean {
  if (process.platform === 'linux') return Number(parent.start) <= Number(child.start);
  if (parent.startedAt === null || child.startedAt === null) return true;
  return parent.startedAt <= child.startedAt;
}

/**
 * The ancestors of `pid`, parent first. A recorded parent that started
 * after its child is a reused pid, not the parent: the walk stops there.
 */
export function ancestry(pid: number, max = 32, table: Snapshot | null = snapshot()): number[] {
  const chain: number[] = [];
  let current = info(pid, table);
  while (current !== null && current.ppid !== null && chain.length < max) {
    const parent = info(current.ppid, table);
    if (parent === null || !startedBefore(parent, current) || chain.includes(parent.pid)) break;
    chain.push(parent.pid);
    current = parent;
  }
  return chain;
}

/**
 * The Claude Code session this process runs in: the CLAUDE_PID process,
 * when it is a live ancestor of this process. Null when there is none or
 * it cannot be verified.
 */
export function sessionHolder(env: NodeJS.ProcessEnv = process.env): ProcessIdentity | null {
  const raw = env['CLAUDE_PID'];
  if (raw === undefined || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  const pid = Number(raw);
  const table = snapshot();
  if (!ancestry(process.pid, 32, table).includes(pid)) return null;
  const found = info(pid, table);
  return found === null || found.zombie ? null : identityOf(found);
}
