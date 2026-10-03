/**
 * Deterministic verification runner.
 *
 * A node only advances on an exit code from a command that actually ran. This
 * module runs that command, captures its output to a file (the record carries
 * a path and a hash, never the body), derives a stable failure fingerprint,
 * and classifies whether a RED failed for the right reason.
 */
import { createHash } from 'node:crypto';
import { runCommandSync } from '../security/exec.js';
import { redactText } from '../security/redact.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EvidenceKind, EvidenceRecord } from '../model/types.js';
import { resolveRef } from '../git/git.js';

export interface RunVerificationArgs {
  kind: EvidenceKind;
  nodeId: string;
  repository: string | null;
  command: string[];
  cwd: string;
  evidenceDir: string;
  /** Exit code that counts as success. Default 0. */
  expectExit?: number;
  timeoutMs?: number;
  /** Test identifiers known to fail before this feature started. */
  baselineFailures?: string[];
  env?: Record<string, string>;
  /** Overrides the derived output file name (used for repeated attempts). */
  label?: string;
  candidateId?: string | null;
  scenarioId?: string | null;
  /** Run `command[0]` as a shell script. Refused unless `allowShell`. */
  shell?: boolean;
  /** From the control repository's `allow_shell_commands`; never from a graph. */
  allowShell?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** Lines that look like the actual failure rather than progress noise. */
const SIGNAL = [
  /assertion/i,
  /assert/i,
  /\bexpected\b/i,
  /\berror\b/i,
  /\bfail(ed|ure|ing)?\b/i,
  /\bexception\b/i,
  /\bpanic\b/i,
  /\bnot ok\b/i,
  /^\s*at .+/,
];

/**
 * Collapse volatile detail so the same defect always hashes the same.
 *
 * Without this, a retry on a different line number or with a different
 * duration would look like a new failure and defeat the repeat limit.
 */
export function normaliseFailureLine(line: string): string {
  return line
    .replace(/[A-Za-z]:[\\/][^\s:)'"]+/g, '<path>')
    .replace(/(?:\/[\w.@-]+)+\.[A-Za-z0-9]+/g, '<path>')
    .replace(/0x[0-9a-fA-F]+/g, '<hex>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds|minutes)\b/gi, '<dur>')
    .replace(/:\d+(:\d+)?/g, ':<n>')
    .replace(/\b\d{3,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * A short, stable identity for a failure, or null when the run succeeded.
 */
export function failureFingerprint(output: string, exitCode: number): string | null {
  if (exitCode === 0) return null;
  const lines = output.split(/\r?\n/).filter((l) => l.trim() !== '');
  const signal = lines.filter((l) => SIGNAL.some((rx) => rx.test(l)));
  const chosen = (signal.length > 0 ? signal : lines).slice(0, 5).map(normaliseFailureLine);
  const basis = chosen.length > 0 ? chosen.join('\n') : `exit:${exitCode}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

export type RedReason = NonNullable<EvidenceRecord['red_reason']>;

/**
 * Decide whether a RED failed because the behaviour is missing, or because
 * the suite could not even run. Only the former is a valid RED.
 */
export function classifyRedReason(output: string, exitCode: number): RedReason {
  if (exitCode === 0) return 'behaviour-missing';
  const text = output.toLowerCase();

  const syntax = [
    'syntaxerror',
    'parse error',
    'unexpected token',
    'unexpected end of input',
    'ts1005',
    'ts1109',
    'ts1128',
    'compilation failed',
  ];
  if (syntax.some((s) => text.includes(s))) return 'syntax-error';

  const environment = [
    'econnrefused',
    'enotfound',
    'etimedout',
    'ehostunreach',
    'eacces',
    'eperm',
    'no space left',
    'address already in use',
    'connection refused',
  ];
  if (environment.some((s) => text.includes(s))) return 'environment-error';

  const setup = [
    'cannot find module',
    'err_module_not_found',
    'modulenotfounderror',
    'no such file or directory',
    'missing script',
    'command not found',
    'is not recognized as an internal or external command',
    'cannot find package',
    'referenceerror: require is not defined',
    'importerror',
    'fixture',
  ];
  if (setup.some((s) => text.includes(s))) return 'setup-error';

  const behaviour = [
    'assertionerror',
    'assert',
    'expected',
    'to equal',
    'to be',
    'not ok',
    'failing',
    'test failed',
    'fail ',
  ];
  if (behaviour.some((s) => text.includes(s))) return 'behaviour-missing';

  // An unclassified failure is not evidence that a behaviour is missing.
  return 'setup-error';
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Remove lines attributable to known baseline failures, so a pre-existing
 * broken test is never charged to this feature.
 */
export function stripBaselineFailures(
  output: string,
  baseline: readonly string[],
): { text: string; matched: string[] } {
  if (baseline.length === 0) return { text: output, matched: [] };
  const matched: string[] = [];
  const kept: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const hit = baseline.find((b) => line.includes(b));
    if (hit) {
      if (!matched.includes(hit)) matched.push(hit);
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n'), matched };
}

/** Run one verification command and return its evidence record. */
export function runVerification(args: RunVerificationArgs): EvidenceRecord {
  const cwd = resolve(args.cwd);
  const evidenceDir = resolve(args.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });

  const startedAt = new Date();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const first = args.command[0];
  if (first === undefined) throw new Error('A verification command must have at least one element.');

  // Throws CommandPolicyError before anything runs if the command is unsafe
  // or asks for a shell the control repository has not allowed.
  const proc = runCommandSync(args.command, {
    cwd,
    timeoutMs,
    env: args.env ?? {},
    shell: args.shell ?? false,
    allowShell: args.allowShell ?? false,
  });
  const finishedAt = new Date();

  let output = `$ ${args.command.join(' ')}\n(cwd: ${cwd})\n\n`;
  output += proc.stdout;
  output += proc.stderr;
  if (proc.timedOut) output += `\n[mycelink] command timed out after ${timeoutMs} ms\n`;
  if (proc.spawnError !== null) output += `\n[mycelink] failed to start: ${proc.spawnError}\n`;
  // Evidence is durable and may be committed: never let a secret reach it.
  output = redactText(output);

  const exitCode = proc.exitCode;
  const expectExit = args.expectExit ?? 0;

  const label = args.label ?? args.kind;
  const outputPath = join(evidenceDir, `${safe(args.nodeId)}.${safe(label)}.log`);
  writeFileSync(outputPath, output, 'utf8');
  const outputSha = createHash('sha256').update(Buffer.from(output, 'utf8')).digest('hex');

  const baseline = args.baselineFailures ?? [];
  const { text: filtered, matched } = stripBaselineFailures(output, baseline);

  // A run that only tripped over known-broken tests is not a new regression.
  const onlyBaseline =
    exitCode !== expectExit &&
    matched.length > 0 &&
    failureFingerprint(filtered, exitCode) === null
      ? true
      : exitCode !== expectExit && matched.length > 0 && !hasSignal(filtered);

  const succeeded = exitCode === expectExit || onlyBaseline;

  const record: EvidenceRecord = {
    kind: args.kind,
    node_id: args.nodeId,
    command: args.command.map((part) => redactText(part)),
    exit_code: exitCode,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    cwd,
    repository: args.repository,
    commit_sha: safeHead(cwd),
    output_path: outputPath,
    output_sha256: outputSha,
    failure_fingerprint: succeeded ? null : failureFingerprint(filtered, exitCode),
  };

  if (args.kind === 'red') {
    record.red_reason = classifyRedReason(output, exitCode);
  }
  if (matched.length > 0) record.baseline_excluded = matched;
  if (args.candidateId !== undefined) record.candidate_id = args.candidateId;
  if (args.scenarioId !== undefined) record.scenario_id = args.scenarioId;

  return record;
}

function hasSignal(text: string): boolean {
  return text.split(/\r?\n/).some((l) => SIGNAL.some((rx) => rx.test(l)));
}

function safeHead(cwd: string): string | null {
  try {
    return resolveRef(cwd, 'HEAD');
  } catch {
    return null;
  }
}
