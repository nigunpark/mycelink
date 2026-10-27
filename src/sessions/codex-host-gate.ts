import { verifyReadonlyFixture } from './context-pack.js';
import type { ReadonlyFixture } from '../model/types.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { samePath } from '../security/paths.js';
import { checkEvidenceOutput, observeEvidenceOutput } from '../evidence/paths.js';
import { readGateTests } from '../evidence/gate-tests.js';
import { canonicalTestId } from '../evidence/test-ids.js';
import type { EvidenceRecord } from '../model/types.js';

export interface HostGateOptions {
  readonlyFixture?: ReadonlyFixture;
  controlRoot: string;
  featureId: string;
  gate: 'red' | 'green' | 'regression';
  cwd: string;
  argv: readonly string[];
  deadlineMs: number;
  /** Re-read the controller's current claim record before and after the CLI run. */
  readRecord: () => EvidenceRecord | undefined;
  requireTests?: boolean;
}

/** Only the host runs this argv; a completed CLI turn is not gate evidence. */
export function executeHostClaimGate(args: HostGateOptions): { exitCode: number; output: string; outputSha256?: string; testIds?: string[] } {
  const fail = (code: string) => ({ exitCode: 2, output: code });
  if (!args.argv.length || !Number.isSafeInteger(args.deadlineMs) || args.deadlineMs < 1 || args.deadlineMs > 600_000) return fail('CHANNEL_GATE_INVALID');
  try { if (args.readonlyFixture) verifyReadonlyFixture(args.controlRoot, args.readonlyFixture); } catch (e) { return fail((e as Error).message); }
  const before = args.readRecord()?.output_sha256;
  const run = spawnSync(args.argv[0] === 'node' ? process.execPath : args.argv[0]!, args.argv.slice(1), {
    cwd: args.cwd, shell: false, windowsHide: true, timeout: args.deadlineMs, maxBuffer: 64 * 1024, encoding: 'utf8',
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.slice(0, 32 * 1024);
  if (run.error || run.status === null) return fail(run.error && 'code' in run.error && run.error.code === 'ETIMEDOUT' ? 'CHANNEL_GATE_TIMEOUT' : 'CHANNEL_GATE_EXEC_FAILED');
  if (run.status !== 0) {
    // A failed verifier still writes a controller-owned log. Its CLI prints a
    // control-relative path, which a worker in a separate worktree cannot read
    // from its cwd. Publish a resolved diagnostic location only for a fresh,
    // intact receipt; the path never changes the gate's failure verdict.
    const record = args.readRecord();
    if (record && record.output_sha256 !== before && record.kind === args.gate && record.exit_code !== 0 &&
        samePath(isAbsolute(record.cwd) ? record.cwd : resolve(args.controlRoot, record.cwd), args.cwd) &&
        checkEvidenceOutput(args.controlRoot, args.featureId, record, { overlay: false }) === null) {
      const observed = observeEvidenceOutput(args.controlRoot, args.featureId, record.output_path);
      if (observed.kind === 'file' && observed.sha256 === record.output_sha256) {
        const native = observed.path;
        const wsl = process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(native)
          ? native.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`)
          : null;
        return { exitCode: run.status, output: `${output}\nController evidence log: ${native}${wsl ? `\nWSL evidence log: ${wsl}` : ''}` };
      }
    }
    return { exitCode: run.status, output };
  }
  const record = args.readRecord();
  // The tdd CLI exits zero on an accepted RED, but its evidence records the
  // verifier's nonzero exit; GREEN and regression record zero instead.
  if (!record || record.output_sha256 === before || record.kind !== args.gate ||
      (args.gate === 'red' ? record.exit_code === 0 : record.exit_code !== 0) ||
      !samePath(isAbsolute(record.cwd) ? record.cwd : resolve(args.controlRoot, record.cwd), args.cwd)) return fail('CHANNEL_GATE_EVIDENCE_MISSING');
  if (checkEvidenceOutput(args.controlRoot, args.featureId, record, { overlay: false }) !== null) return fail('CHANNEL_GATE_OUTPUT_INVALID');
  if (!record.results) return args.requireTests === false ? { exitCode: 0, output, outputSha256: record.output_sha256, testIds: [] } : fail('CHANNEL_GATE_TESTS_MISSING');
  const observed = observeEvidenceOutput(args.controlRoot, args.featureId, record.results.path);
  if (observed.kind !== 'file' || observed.sha256 !== record.results.sha256) return fail('CHANNEL_GATE_TESTS_INVALID');
  let format: unknown;
  try { format = (JSON.parse(readFileSync(observed.path, 'utf8')) as { format?: unknown }).format; } catch { return fail('CHANNEL_GATE_TESTS_INVALID'); }
  if (format !== record.results.format) return fail('CHANNEL_GATE_TESTS_INVALID');
  const tests = readGateTests(args.controlRoot, record);
  if (!tests || (args.requireTests !== false && tests.length === 0) || tests.length > 10_000 ||
      tests.some((t) => t.id !== canonicalTestId(record.results!.format, t.path, t.full_name) || !['passed', 'failed', 'skipped', 'not-run'].includes(t.status))) {
    return fail('CHANNEL_GATE_TEST_IDS_INVALID');
  }
  return { exitCode: 0, output, outputSha256: record.output_sha256, testIds: tests.map((t) => t.id).slice(0, 256) };
}
