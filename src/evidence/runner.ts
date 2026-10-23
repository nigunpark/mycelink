/**
 * Deterministic verification runner.
 *
 * A node only advances on an exit code from a command that actually ran. This
 * module runs that command, captures its output to a file (the record carries
 * a path and a hash, never the body), derives a stable failure fingerprint,
 * and classifies whether a RED failed for the right reason.
 */
import { createHash } from 'node:crypto';
import { runCommandSync, runShellScriptSync, shellScriptOf } from '../security/exec.js';
import { redactText } from '../security/redact.js';
import { isInsideReal, readRegular } from '../security/paths.js';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ClaimVerification, EvidenceKind, EvidenceRecord, ModuleReport } from '../model/types.js';
import { resolveRef } from '../git/git.js';
import { relativeInside } from './paths.js';
import { writeImmutable } from './store.js';
import { classifyRedOutput, judgeRed, parseJUnit, parseVitestJson, redReasonFor, type DeclaredTest, type TestResult } from './red-classify.js';
import { canonicalTests, type CanonicalTest } from './test-ids.js';
import { attributeByDeclaration } from './junit-attribution.js';
import { reportedIdentity } from './test-identity.js';

/**
 * What a verification runs: an argv command, or (opted in per command and
 * enabled only by the control repository) one shell script. They are
 * separate fields so an argv, such as an operator's `-- <argv>`, can never be
 * handed to a shell by a flag.
 */
export type VerificationInvocation =
  | { command: string[]; shellScript?: undefined }
  | { shellScript: string; command?: undefined };

/**
 * What a module-bound gate or verification runs (engine/modules.ts): the
 * module's setup and build steps, then its test command, reading its report,
 * within its timeout — exactly the plan the claim bound.
 */
export function moduleInvocation(bound: ClaimVerification): {
  command: string[];
  steps: string[][];
  report: ModuleReport | null;
  module: { id: string; sha256: string; path: string; plan_sha256: string };
  timeoutMs: number;
} {
  return {
    command: [...bound.plan.test],
    steps: [...bound.plan.setup, ...bound.plan.build].map((argv) => [...argv]),
    report: bound.plan.report,
    module: { id: bound.module, sha256: bound.module_sha256, path: bound.path, plan_sha256: bound.plan_sha256 },
    timeoutMs: bound.plan.timeout_seconds * 1000,
  };
}

/** The invocation for a declared verifier: its script if it asks for a shell. */
export function verifierInvocation(verifier: { command: string[]; shell?: boolean }): VerificationInvocation {
  return verifier.shell === true ? { shellScript: shellScriptOf(verifier.command) } : { command: verifier.command };
}

export type RunVerificationArgs = VerificationInvocation & VerificationOptions;

export interface RawReportSnapshot {
  readonly bytes: Buffer | null;
  readonly sha256: string | null;
  readonly output: string;
  readonly test_command_output: string | null;
  readonly exit_code: number;
  readonly steps: { exit_code: number; timed_out: boolean }[];
  readonly normalized_count: number;
}

interface VerificationOptions {
  kind: EvidenceKind;
  nodeId: string;
  repository: string | null;
  cwd: string;
  evidenceDir: string;
  /** Exit code that counts as success. Default 0. */
  expectExit?: number;
  timeoutMs?: number;
  /** Test identifiers known to fail before this feature started. */
  baselineFailures?: string[];
  env?: Record<string, string>;
  /** Controller diagnostic runs may inherit only the isolated setup environment. */
  cleanEnv?: boolean;
  /** Private diagnostic scratch, removed with its disposable checkout on every exit. */
  reportScratchRoot?: string;
  /** Transient diagnostic observation; never added to evidence. */
  onRawReport?: (snapshot: RawReportSnapshot) => void;
  /** Overrides the derived output file name (used for repeated attempts). */
  label?: string;
  candidateId?: string | null;
  scenarioId?: string | null;
  /** From the control repository's `allow_shell_commands`; never from a graph. */
  allowShell?: boolean;
  /**
   * The control root. When given, `output_path` (and `cwd` when it is inside)
   * are stored relative to it, so the record still resolves after the control
   * repository moves. The evidence directory must be inside it.
   */
  pathBase?: string;
  /** A RED only: the tests its delta declares (null when they cannot be read). */
  redDeclared?: DeclaredTest[] | null;
  /** Argv steps run first, in the same cwd (a module's setup and build); the first that fails ends the run before the command. */
  steps?: string[][];
  /** The structured report the command writes (engine/modules.ts): `${REPORT}` in its argv, or a directory inside cwd. */
  report?: ModuleReport | null;
  /** The module whose command this is, recorded with the evidence. */
  module?: { id: string; sha256: string; path: string; plan_sha256: string } | null;
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
    // Any POSIX path, a directory's too (a fresh worktree per attempt), as any Windows path above.
    .replace(/(?:\/[\w.@-]+)+/g, '<path>')
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
 * Decide whether a RED failed because the behaviour is missing, or for a
 * reason that proves nothing (evidence/red-classify.ts, from the output
 * alone). Only the former is a valid RED; a nonzero exit alone never is.
 */
export function classifyRedReason(output: string, exitCode: number): RedReason {
  return redReasonFor(classifyRedOutput(output, exitCode).category);
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
  const deadline = Date.now() + timeoutMs;
  const command = args.shellScript !== undefined ? [args.shellScript] : args.command;
  if (command[0] === undefined) throw new Error('A verification command must have at least one element.');

  // A module's setup and build steps run first, in order; the first that fails ends the run before the command.
  let output = '';
  const steps: NonNullable<EvidenceRecord['steps']> = [];
  let failedStep: { argv: string[]; exit_code: number } | null = null;
  let timedOut = false;
  for (const step of args.steps ?? []) {
    const t0 = Date.now();
    output += `$ ${step.join(' ')}\n(cwd: ${cwd})\n\n`;
    const r = runCommandSync(step, { cwd, timeoutMs: Math.max(1, deadline - Date.now()), env: args.env ?? {}, cleanEnv: args.cleanEnv });
    output += r.stdout + r.stderr;
    if (r.timedOut) output += `\n[mycelink] step timed out after ${timeoutMs} ms\n`;
    if (r.spawnError !== null) output += `\n[mycelink] failed to start: ${r.spawnError}\n`;
    output += '\n';
    steps.push({ argv: [...step], exit_code: r.exitCode, timed_out: r.timedOut, duration_ms: Date.now() - t0 });
    if (r.exitCode !== 0 || r.timedOut) {
      failedStep = { argv: [...step], exit_code: r.exitCode };
      timedOut = r.timedOut;
      break;
    }
  }

  // Where the command writes its structured report: a controller-owned file, or a directory inside cwd emptied first.
  // A declared bare Node verifier can opt into a structured report without a
  // module descriptor. Only this exact reporter argv grants a controller-owned
  // ${REPORT} destination; never infer identities from unstructured stdout.
  const nodeJUnit = args.shellScript === undefined && args.command?.length === 4 &&
    args.command[0] === 'node' && args.command[1] === '--test-reporter=junit' &&
    args.command[2] === '--test-reporter-destination=${REPORT}' &&
    /^tests\/[A-Za-z0-9_./-]+\.mjs$/.test(args.command[3] ?? '') &&
    !args.command[3]?.split('/').includes('..');
  const report = args.report ?? (nodeJUnit ? { format: 'junit-xml' as const } : null);
  const scratch = report !== null && report.dir === undefined ? mkdtempSync(join(args.reportScratchRoot ?? tmpdir(), 'mycelink-report-')) : null;
  let results: TestResult[] | null;
  let exitCode: number;
  let finishedAt: Date;
  let observerFailed = false;
  let testCommandOutput: string | null = null;
  try {
    const reportFile = scratch === null ? null : join(scratch, (report as ModuleReport).format === 'vitest-json' ? 'report.json' : 'report.xml');
    const reportDir = report?.dir !== undefined ? resolve(cwd, report.dir) : null;
    if (reportDir !== null) clearReportDir(cwd, reportDir);
    const argv = args.shellScript !== undefined || reportFile === null ? command : command.map((part) => part.split('${REPORT}').join(reportFile));

    if (failedStep === null) {
      // Throws CommandPolicyError before anything runs if the command is unsafe
      // or asks for a shell the control repository has not allowed.
      const runOptions = { cwd, timeoutMs: Math.max(1, deadline - Date.now()), env: args.env ?? {}, cleanEnv: args.cleanEnv };
      const proc =
        args.shellScript !== undefined
          ? runShellScriptSync(args.shellScript, { ...runOptions, allowShell: args.allowShell ?? false })
          : runCommandSync(argv, runOptions);
      if (args.onRawReport) {
        const bytes = Buffer.from(redactText(proc.stdout + proc.stderr));
        let start = Math.max(0, bytes.length - 65536);
        // Do not decode a partial leading UTF-8 character into an expanded replacement.
        while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
        testCommandOutput = bytes.subarray(start).toString('utf8');
      }
      output += `$ ${command.join(' ')}\n(cwd: ${cwd})\n\n`;
      output += proc.stdout;
      output += proc.stderr;
      if (proc.timedOut) output += `\n[mycelink] command timed out after ${timeoutMs} ms\n`;
      if (proc.spawnError !== null) output += `\n[mycelink] failed to start: ${proc.spawnError}\n`;
      exitCode = proc.exitCode;
      timedOut = proc.timedOut;
    } else {
      exitCode = failedStep.exit_code === 0 ? 1 : failedStep.exit_code;
    }
    finishedAt = new Date();
    // Evidence is durable and may be committed: never let a secret reach it.
    output = redactText(output);

    results = report === null ? null : failedStep !== null ? [] : readReport(report, reportFile, reportDir, cwd, args.module?.path ?? null);
    if (args.onRawReport) {
      try {
        const bytes = reportFile === null || failedStep !== null ? null : readRegular(reportFile, MAX_REPORT_BYTES)?.bytes ?? null;
        args.onRawReport(Object.freeze({ bytes, sha256: bytes === null ? null : createHash('sha256').update(bytes).digest('hex'),
          output, test_command_output: testCommandOutput, exit_code: exitCode, steps: steps.map(s => Object.freeze({ exit_code: s.exit_code, timed_out: s.timed_out })),
          normalized_count: results?.length ?? 0 }));
      } catch { observerFailed = true; throw new Error('CHANNEL_PROBE_REPORT_INVALID:RAW'); }
    }
  } finally {
    try { if (scratch !== null) rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (e) { if (observerFailed) throw new Error('CHANNEL_PROBE_REPORT_INVALID:RAW'); throw e; }
  }
  const expectExit = args.expectExit ?? 0;

  const label = args.label ?? args.kind;
  // Immutable from here on (evidence/store.ts): named by its own bytes, created exclusively, never written again — a
  // later run of this gate, or any other, can never change what this record names (the CSET-202 rerun). The directory
  // is the node's: the name carries only the label and the hash, so a long node id never pushes a path past a limit.
  const stored = writeImmutable(evidenceDir, safe(label), '.log', output);
  const outputPath = stored.file;
  const outputSha = stored.sha256;

  const baseline = args.baselineFailures ?? [];
  const { text: filtered, matched } = stripBaselineFailures(output, baseline);

  // A run that only tripped over known-broken tests is not a new regression.
  const onlyBaseline =
    exitCode !== expectExit &&
    matched.length > 0 &&
    failureFingerprint(filtered, exitCode) === null
      ? true
      : exitCode !== expectExit && matched.length > 0 && !hasSignal(filtered);

  const succeeded = failedStep === null && (exitCode === expectExit || onlyBaseline);

  let storedOutput = outputPath;
  let storedCwd = cwd;
  if (args.pathBase !== undefined) {
    const rel = relativeInside(args.pathBase, outputPath);
    if (rel === null) throw new Error(`Evidence output ${outputPath} is outside the control root ${args.pathBase}.`);
    storedOutput = rel;
    storedCwd = relativeInside(args.pathBase, cwd) ?? cwd;
  }

  const record: EvidenceRecord = {
    kind: args.kind,
    node_id: args.nodeId,
    command: command.map((part) => redactText(part)),
    exit_code: exitCode,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    cwd: storedCwd,
    repository: args.repository,
    commit_sha: safeHead(cwd),
    output_path: storedOutput,
    output_sha256: outputSha,
    failure_fingerprint: succeeded ? null : failureFingerprint(filtered, exitCode),
  };
  if (args.module) {
    record.module = args.module.id;
    record.module_sha256 = args.module.sha256;
    record.plan_sha256 = args.module.plan_sha256;
  }
  if (steps.length > 0) record.steps = steps;
  if (report !== null && results !== null) {
    // The normalised results beside the log, bound by their hash, each with its canonical test id (evidence/test-ids.ts)
    // and its versioned canonical identity beside its raw name and class (evidence/test-identity.ts).
    const ids = canonicalTests(results, report.format);
    const withIds = results.map((r, i) => {
      const t = ids[i] as CanonicalTest;
      const identity = reportedIdentity({ path: t.path, full_name: t.full_name, name: r.name, classname: r.classname ?? null });
      return { ...r, test_id: t.id, full_name: t.full_name, ...(identity !== null ? { identity } : {}) };
    });
    const body = redactText(JSON.stringify({ schema: 'mycelink-test-results/1', format: report.format, results: withIds }, null, 2) + '\n');
    // Immutable like the log, by its own bytes.
    const kept = writeImmutable(evidenceDir, `${safe(label)}.results`, '.json', body);
    const where = args.pathBase !== undefined ? relativeInside(args.pathBase, kept.file) : kept.file;
    if (where === null) throw new Error(`Evidence results ${kept.file} are outside the control root ${args.pathBase}.`);
    record.results = {
      format: report.format,
      path: where,
      sha256: kept.sha256,
      total: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    };
  }

  if (args.kind === 'red') {
    // On the tests the RED declares (from its report where one is configured), from the output alone otherwise.
    const judged = judgeRed({ exitCode, timedOut, output, results, declared: args.redDeclared ?? null, failedStep });
    record.red_reason = redReasonFor(judged.category);
    record.red_category = judged.category;
    record.red_fingerprint = judged.fingerprint;
    record.red_detail = judged.detail;
    if (judged.tests.length > 0) record.red_tests = judged.tests.slice(0, 64);
    if (args.redDeclared) record.red_declared = args.redDeclared.slice(0, 64).map((t) => ({ file: t.file, name: t.name }));
  }
  if (matched.length > 0) record.baseline_excluded = matched;
  if (args.candidateId !== undefined) record.candidate_id = args.candidateId;
  if (args.scenarioId !== undefined) record.scenario_id = args.scenarioId;

  return record;
}

/** Empty a report directory inside `cwd` before a run, so a stale report is never read; a link is unlinked, never followed. */
function clearReportDir(cwd: string, dir: string): void {
  if (!isInsideReal(cwd, dir)) throw new Error(`REPORT_DIR_OUTSIDE: ${dir} is not inside ${cwd}`);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) rmSync(dir, { force: true });
  else rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/** Ceiling on one report file read. */
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

/** The results a structured report holds; none when it is missing or cannot be read (every declared test then did not run). */
function readReport(report: ModuleReport, file: string | null, dir: string | null, cwd: string, modulePath: string | null): TestResult[] {
  // Through one descriptor, never through a link: what is checked is what is read.
  const read = (path: string): string | null => readRegular(path, MAX_REPORT_BYTES)?.bytes.toString('utf8') ?? null;
  if (file !== null) {
    const text = read(file);
    if (text === null) return [];
    try {
      if (report.format === 'vitest-json') return parseVitestJson(text, { root: cwd });
      // Node 22's reporter names no test file: each test is attributed from its module's sources, where they leave one.
      const scope = modulePath !== null && isInsideReal(cwd, resolve(cwd, modulePath)) ? resolve(cwd, modulePath) : cwd;
      return parseJUnit(text, { root: cwd, attribute: attributeByDeclaration({ root: cwd, scope }) });
    } catch {
      return [];
    }
  }
  if (dir === null) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.xml')).sort();
  } catch {
    return [];
  }
  const out: TestResult[] = [];
  for (const name of names) {
    const text = read(join(dir, name));
    if (text === null) continue;
    try {
      out.push(...(report.format === 'junit-xml' ? parseJUnit(text, { root: cwd, moduleDir: modulePath }) : parseVitestJson(text, { root: cwd })));
    } catch {
      // An unreadable report file names no result.
    }
  }
  return out;
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
