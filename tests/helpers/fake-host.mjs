#!/usr/bin/env node
/**
 * A stand-in for a Claude Code host session: a long-lived process that runs
 * each `mycelink` call as its own child, with CLAUDE_PID set to its pid the
 * way Claude Code sets it for its Bash calls (and its in-process
 * subagents' calls). Killing it is a host session dying.
 *
 * Driven over IPC: `{ id, argv, env?, unset?, cwd? }` -> `{ id, code, signal, out, err }`.
 */
import { spawnSync } from 'node:child_process';

const bin = process.argv[2];
process.on('message', (msg) => {
  const env = { ...process.env, CLAUDE_PID: String(process.pid), CLAUDECODE: '1', ...(msg.env ?? {}) };
  for (const key of msg.unset ?? []) delete env[key];
  const r = spawnSync(process.execPath, [bin, ...msg.argv], { env, encoding: 'utf8', cwd: msg.cwd, timeout: 900_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  process.send({ id: msg.id, code: r.status, signal: r.signal, out: r.stdout ?? '', err: r.stderr ?? '' });
});
process.send({ ready: true });
setInterval(() => {}, 60_000);
