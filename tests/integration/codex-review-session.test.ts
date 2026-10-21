import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCodexReviewSession } from '../../src/engine/codex-review-session.js';
import { codexReviewerPaths, codexReviewPrompt } from '../../src/engine/codex-review-session.js';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(final: unknown, mode = 'normal') {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.env.TEMP ?? '.', 'mycelink-review-'));
  roots.push(root);
  const script = join(root, 'provider.mjs');
  writeFileSync(script, `const args=process.argv.slice(2);\nconst prompt=await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s))});\nconst emit=e=>console.log(JSON.stringify(e));\nif(args.join(' ').includes('--dangerously')||!args.includes('read-only')||!args.includes('--json')||!args.includes('--cd')||!args.includes('-'))process.exit(9);\nemit({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});emit({type:'turn.started'});\nif(${JSON.stringify(mode)}==='file-change')emit({type:'item.completed',item:{id:'edit',type:'file_change',changes:[]}});\nemit({type:'item.completed',item:{id:'answer',type:'agent_message',text:${JSON.stringify(JSON.stringify(final))}}});emit({type:'turn.completed',usage:{input_tokens:10,output_tokens:12}});\n`);
  return { root, script };
}
const binding = { featureId: 'ORD-101', reviewId: 'ORD-101-R001', dispatchId: 'dispatch-1', inputsSha256: 'a'.repeat(64), criteria: ['AC-1', 'AC-2'] };
const verdict = { schema: 'mycelink-acceptance-review/1', feature_id: binding.featureId, review_id: binding.reviewId, dispatch_id: binding.dispatchId, inputs_sha256: binding.inputsSha256, criteria: [{ criterion: 'AC-1', verdict: 'PASS' }, { criterion: 'AC-2', verdict: 'GAP', gap: { missing: 'status on timeout', reproduction: 'timeout request; expect status' } }], overall: 'GAPS' };

describe('separate Codex reviewer process evidence (not acceptance settlement)', () => {
  it('maps only Windows drive paths in the WSL review prompt and process cwd', () => {
    expect(codexReviewerPaths('C:/control/packet.json and D:/repo/file.ts', 'D:/repo', true)).toEqual({ prompt: '/mnt/c/control/packet.json and /mnt/d/repo/file.ts', cwd: '/mnt/d/repo' });
  });
  it('gives the separate read-only process a final-answer-only brief without Claude Write instructions', () => {
    const prompt = codexReviewPrompt('Read the packet and inspect criteria.', 'C:/control/packet.json');
    expect(prompt).toContain('C:/control/packet.json');
    expect(prompt).toContain('exactly one JSON object');
    expect(prompt).not.toMatch(/Write tool|Agent tool|verdict file/i);
  });
  it('tells the WSL reviewer how to read Windows checkout and evidence paths inside its packet', () => {
    const prompt = codexReviewPrompt('Read the packet and inspect criteria.', 'C:/control/packet.json');
    expect(prompt).toContain('/mnt/c/');
    expect(prompt).toMatch(/WSL, Windows drive-letter paths inside the packet/);
  });
  it('records a hash-bound separate JSONL session with a per-criterion gap and no authority in its prompt', async () => {
    const { root, script } = fixture(verdict);
    const result = await runCodexReviewSession({ executable: process.execPath, prefixArgs: [script], cwd: root, prompt: 'Review these criteria', binding, evidenceDir: join(root, 'evidence'), timeoutMs: 5000 });
    expect(result.verdict).toEqual(verdict);
    expect(result.receipt).toMatchObject({ review_id: binding.reviewId, dispatch_id: binding.dispatchId, overall: 'GAPS', criteria: [{ criterion: 'AC-1', verdict: 'PASS' }, { criterion: 'AC-2', verdict: 'GAP' }], terminal: 'completed', thread_id: '11111111-1111-4111-8111-111111111111' });
    expect(readFileSync(result.jsonlPath, 'utf8')).toContain('thread.started');
    expect(JSON.stringify(result.receipt)).not.toContain('Review these criteria');
    expect(existsSync(result.receiptPath)).toBe(true);
  });
  it('rejects an answer bound to another dispatch without persisting a verdict receipt', async () => {
    const { root, script } = fixture({ ...verdict, dispatch_id: 'old-dispatch' });
    await expect(runCodexReviewSession({ executable: process.execPath, prefixArgs: [script], cwd: root, prompt: 'Review', binding, evidenceDir: join(root, 'evidence'), timeoutMs: 5000 })).rejects.toThrow(/BINDING/);
    expect(existsSync(join(root, 'evidence', 'receipt.json'))).toBe(false);
  });
  it('rejects a reported file change even when the process exits zero', async () => {
    const { root, script } = fixture(verdict, 'file-change');
    await expect(runCodexReviewSession({ executable: process.execPath, prefixArgs: [script], cwd: root, prompt: 'Review', binding, evidenceDir: join(root, 'evidence'), timeoutMs: 5000 })).rejects.toThrow(/FILE_CHANGE/);
  });
  it('preserves a rejected stream for forensic diagnosis without creating a verdict receipt', async () => {
    const { root, script } = fixture(verdict);
    const source = readFileSync(script, 'utf8');
    writeFileSync(script, source.replace(/emit\(\{type:'item.completed',item:\{id:'answer'.*?\}\}\);/, ''));
    const evidenceDir = join(root, 'evidence');
    await expect(runCodexReviewSession({ executable: process.execPath, prefixArgs: [script], cwd: root, prompt: 'Review', binding, evidenceDir, timeoutMs: 5000 })).rejects.toThrow(/CODEX_REVIEW_STREAM_INVALID/);
    expect(readFileSync(join(evidenceDir, 'rejected-session.jsonl'), 'utf8')).toContain('turn.completed');
    expect(existsSync(join(evidenceDir, 'receipt.json'))).toBe(false);
  });
});
