/** A separate read-only Codex process and its JSONL evidence, not a settled review. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexTranscriptReader } from '../sessions/codex-transcript.js';
import { extractReviewerResult } from './review-transport.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export interface CodexReviewBinding {
  featureId: string; reviewId: string; dispatchId: string; inputsSha256: string; criteria: string[];
}
export interface CodexReviewReceipt {
  schema: 'mycelink-codex-review-process/1';
  process_session_id: string; pid: number | null; thread_id: string;
  review_id: string; dispatch_id: string; inputs_sha256: string;
  terminal: 'completed'; overall: 'PASS' | 'GAPS';
  criteria: { criterion: string; verdict: 'PASS' | 'GAP' }[];
  prompt_sha256: string; jsonl_sha256: string; verdict_sha256: string;
  role_attested: false;
}

export async function runCodexReviewSession(options: {
  executable: string; /** For a controller-selected WSL prefix or a test executable; never user-supplied extra flags. */ prefixArgs?: string[];
  cwd: string; prompt: string; binding: CodexReviewBinding;
  evidenceDir: string; timeoutMs: number;
}): Promise<{ verdict: Record<string, unknown>; receipt: CodexReviewReceipt; jsonlPath: string; receiptPath: string }> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 1_800_000) throw new Error('CODEX_REVIEW_TIMEOUT_INVALID');
  if (Buffer.byteLength(options.prompt) > 256 * 1024 || options.prompt.length === 0) throw new Error('CODEX_REVIEW_PROMPT_INVALID');
  const jsonlPath = join(options.evidenceDir, 'session.jsonl');
  const receiptPath = join(options.evidenceDir, 'receipt.json');
  if (existsSync(jsonlPath) || existsSync(receiptPath)) throw new Error('CODEX_REVIEW_EVIDENCE_EXISTS');
  const sessionId = randomUUID();
  const child = spawn(options.executable, [...(options.prefixArgs ?? []), 'exec', '--json', '--cd', options.cwd, '--sandbox', 'read-only', '-'],
    { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let jsonl = '';
  let overflow = false;
  child.stdout.on('data', (chunk: Buffer) => {
    if (Buffer.byteLength(jsonl) + chunk.length > 8 * 1024 * 1024) { overflow = true; child.kill(); return; }
    jsonl += chunk.toString('utf8');
  });
  // stderr is not verdict evidence and may contain provider details or credentials.
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.stdin.end(options.prompt);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
  const outcome = await new Promise<{ code: number | null; error: Error | null }>((resolve) => {
    let error: Error | null = null;
    child.on('error', (e) => { error = e; });
    child.on('close', (code) => resolve({ code, error }));
  });
  clearTimeout(timer);
  if (timedOut || overflow || outcome.error || outcome.code !== 0) throw new Error(`CODEX_REVIEW_PROCESS_FAILED: ${timedOut ? 'timeout' : overflow ? 'oversized JSONL' : outcome.error ? 'spawn failed' : `exit ${outcome.code}`}`);
  const reader = new CodexTranscriptReader();
  let answer: string | null = null;
  for (const line of jsonl.trimEnd().split('\n')) {
    reader.consume(line);
    // The reader rejects malformed events; only its completed final hash can bind this text.
    try {
      const e = JSON.parse(line) as { type?: string; item?: { type?: string; text?: unknown } };
      if (e.type === 'item.completed' && e.item?.type === 'file_change') throw new Error('CODEX_REVIEW_FILE_CHANGE');
      if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') answer = e.item.text;
    } catch (err) { if ((err as Error).message === 'CODEX_REVIEW_FILE_CHANGE') throw err; }
  }
  const stream = reader.finish();
  if (stream.terminal !== 'completed' || !stream.thread_id || !stream.final || answer === null || sha(answer) !== stream.final.sha256) throw new Error('CODEX_REVIEW_STREAM_INVALID');
  const extracted = extractReviewerResult(answer);
  if (!extracted.ok) throw new Error(`CODEX_REVIEW_VERDICT_INVALID: ${extracted.reason}`);
  const verdict = extracted.value;
  const b = options.binding;
  if (verdict['schema'] !== 'mycelink-acceptance-review/1' || verdict['feature_id'] !== b.featureId || verdict['review_id'] !== b.reviewId || verdict['dispatch_id'] !== b.dispatchId || verdict['inputs_sha256'] !== b.inputsSha256) throw new Error('CODEX_REVIEW_BINDING_MISMATCH');
  if (!Array.isArray(verdict['criteria']) || verdict['criteria'].length !== b.criteria.length) throw new Error('CODEX_REVIEW_CRITERIA_INVALID');
  const criteria = verdict['criteria'].map((v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('CODEX_REVIEW_CRITERIA_INVALID');
    const item = v as Record<string, unknown>;
    if (typeof item['criterion'] !== 'string' || !b.criteria.includes(item['criterion']) || (item['verdict'] !== 'PASS' && item['verdict'] !== 'GAP')) throw new Error('CODEX_REVIEW_CRITERIA_INVALID');
    return { criterion: item['criterion'], verdict: item['verdict'] as 'PASS' | 'GAP' };
  });
  if (new Set(criteria.map((c) => c.criterion)).size !== b.criteria.length) throw new Error('CODEX_REVIEW_CRITERIA_INVALID');
  const overall = criteria.some((c) => c.verdict === 'GAP') ? 'GAPS' : 'PASS';
  if (verdict['overall'] !== overall) throw new Error('CODEX_REVIEW_OVERALL_INVALID');
  const receipt: CodexReviewReceipt = {
    schema: 'mycelink-codex-review-process/1', process_session_id: sessionId, pid: child.pid ?? null,
    thread_id: stream.thread_id, review_id: b.reviewId, dispatch_id: b.dispatchId,
    inputs_sha256: b.inputsSha256, terminal: 'completed', overall, criteria,
    prompt_sha256: sha(options.prompt), jsonl_sha256: sha(jsonl), verdict_sha256: sha(extracted.json), role_attested: false,
  };
  mkdirSync(options.evidenceDir, { recursive: true });
  writeFileSync(jsonlPath, jsonl, { flag: 'wx' });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return { verdict, receipt, jsonlPath, receiptPath };
}
