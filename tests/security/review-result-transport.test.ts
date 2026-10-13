/**
 * The fence around a reviewer's final answer as its verdict
 * (engine/review-transport.ts, hooks/fence.ts).
 *
 * The controller takes a reviewer's final answer from Claude Code's own
 * records, never from its own prose: the launch the fence records where only
 * Mycelink writes, and the session's and the subagent's transcripts, which
 * only Claude Code writes. So:
 *
 *  - the host's Agent call for the reviewer is let through and carries what
 *    the hook records of it (the call, the session, its transcript, the
 *    prompt); a module-worker still launches nothing;
 *  - the controller runs `review ingest` (Mycelink's own CLI), feeding it a
 *    copy on stdin or a file; a module-worker and the reviewer never do;
 *  - the reviewer stays read-only: no shell, no Edit, no Write but its
 *    verdict file — and not even that over a verdict already taken from a
 *    final answer, or one another reviewer wrote;
 *  - nobody writes a session transcript or a subagent's transcript or meta
 *    (a forged transcript is a write the fence refuses), while Claude Code's
 *    memory files beside them stay writable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { makeGitRepo } from '../helpers/git-fixture.js';
import { fenceDecision, type FenceInput } from '../../src/hooks/fence.js';
import { canonicalVerdictSha256 } from '../../src/engine/acceptance-review.js';

afterAll(() => cleanupTmpRoots());

const REVIEWER = { agent_id: 'a91b2c3d4e5f60718', agent_type: 'mycelink:acceptance-reviewer' };
const OTHER_REVIEWER = { agent_id: 'a0000000000000002', agent_type: 'mycelink:acceptance-reviewer' };
const WORKER = { agent_id: 'a0000000000000901', agent_type: 'mycelink:module-worker' };
const SESSION = '5e5510aa-0000-4000-8000-000000000001';
let root: string;
let home: string;
let control: string;
let slot: string;
let projects: string;
const s = (p: string): string => p.replace(/\\/g, '/');

beforeAll(() => {
  root = makeTmpDir('transport-fence-');
  home = join(root, 'home');
  control = join(root, 'platform');
  makeGitRepo(join(root, 'repos', 'app'), { files: { 'src/a.mjs': 'export const a = 1;\n' } });
  makeGitRepo(control, {
    files: {
      'mycelink.config.json': '{ "schema_version": 1 }\n',
      'repositories.yaml': YAML.stringify({ schema_version: 1, repositories: [{ name: 'app', path: '../repos/app', base_branch: 'main', commands: { test: ['node', '--test'] } }] }),
      'features/FEAT-7/PRD.md': '# FEAT-7\n',
    },
  });
  slot = join(control, '.mycelink', 'reviews', 'FEAT-7', 'FEAT-7-R001', '7b1d2c4e-0000-4000-8000-000000000001', 'verdict.json');
  mkdirSync(join(slot, '..'), { recursive: true });
  projects = join(home, '.claude', 'projects', '-tmp-workspace');
  mkdirSync(join(projects, SESSION, 'subagents'), { recursive: true });
  mkdirSync(join(projects, 'memory'), { recursive: true });
});

const call = (tool: string, input: Record<string, unknown>, who: Partial<FenceInput> = {}) => fenceDecision({ tool_name: tool, tool_input: input, cwd: root, session_id: SESSION, ...who }, { HOME: home });
const LAUNCHER = 'node "/plugins/mycelink/bin/mycelink.mjs"';
const INGEST = `${LAUNCHER} review ingest FEAT-7 --review FEAT-7-R001 --control-root ${'"' + '/x/platform' + '"'} --capability abc --json`;

describe("the host's Agent call for the reviewer", () => {
  it('is let through and carries what the hook records of it', () => {
    const d = call('Agent', { subagent_type: 'mycelink:acceptance-reviewer', description: 'acceptance review FEAT-7-R001', prompt: 'Acceptance review: FEAT-7-R001\nDispatch: 7b1d2c4e-0000-4000-8000-000000000001\n' }, { tool_use_id: 'toolu_01LAUNCH', transcript_path: join(projects, `${SESSION}.jsonl`) });
    expect(d).toMatchObject({ ok: true, launch: { tool_use_id: 'toolu_01LAUNCH', session_id: SESSION, transcript_path: join(projects, `${SESSION}.jsonl`), subagent_type: 'mycelink:acceptance-reviewer', prompt: expect.stringContaining('Dispatch: 7b1d2c4e') } });
  });

  it('carries nothing for another subagent, nor from a subagent', () => {
    expect(call('Agent', { subagent_type: 'mycelink:module-worker', description: 'n', prompt: 'p' }, { tool_use_id: 'toolu_02', transcript_path: join(projects, `${SESSION}.jsonl`) })).toEqual({ ok: true });
    expect(call('Agent', { subagent_type: 'mycelink:acceptance-reviewer', description: 'n', prompt: 'p' }, { ...WORKER, tool_use_id: 'toolu_03', transcript_path: join(projects, `${SESSION}.jsonl`) })).toMatchObject({ ok: false });
    expect(call('Agent', { subagent_type: 'mycelink:acceptance-reviewer', description: 'n', prompt: 'p' }, { ...REVIEWER, tool_use_id: 'toolu_04' })).toMatchObject({ ok: false });
  });
});

describe('a launch is recorded only by Claude Code running the hook', () => {
  it.each([
    ['the controller', {}],
    ['a module-worker', WORKER],
  ])('%s never runs the hook entrypoint itself (a forged launch or attestation)', (_label, who) => {
    const forged = `echo '{"tool_name":"Agent","tool_input":{"subagent_type":"mycelink:acceptance-reviewer","prompt":"x"}}' | ${LAUNCHER} hook controller-fence`;
    const d = call('Bash', { command: forged }, who);
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/hook/);
    expect(call('Bash', { command: `mycelink hook controller-fence < /tmp/x.json` }, who)).toMatchObject({ ok: false });
  });
});

describe('review ingest is the controller\'s', () => {
  it.each([
    ['with a copy on stdin', (): string => `${INGEST} --result-file - <<'MYCELINK_RESULT'\n{"schema":"mycelink-acceptance-review/1"}\nMYCELINK_RESULT`],
    ['with a file', (): string => `${INGEST} --result-file ${s(join(control, 'reviewer-answer.json'))}`],
    ['with no copy at all', (): string => INGEST],
  ])('the controller runs it %s', (_label, command) => {
    expect(call('Bash', { command: command() })).toEqual({ ok: true });
  });

  it('a module-worker never runs it', () => {
    const d = call('Bash', { command: INGEST }, WORKER);
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/never runs mycelink review/);
  });

  it('the reviewer never runs it, nor any shell', () => {
    const d = call('Bash', { command: INGEST }, REVIEWER);
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/acceptance reviewer is read-only/);
  });
});

describe('the reviewer stays read-only', () => {
  it.each([
    ['its launch record', () => call('Write', { file_path: join(slot, '..', 'launch-toolu_01LAUNCH.json'), content: '{}' }, REVIEWER)],
    ['a copy of its answer beside its verdict', () => call('Write', { file_path: join(slot, '..', 'agent-result.txt'), content: '{}' }, REVIEWER)],
    ['its verdict, by Edit', () => call('Edit', { file_path: slot, old_string: 'a', new_string: 'b' }, REVIEWER)],
    ['its own transcript', () => call('Write', { file_path: join(projects, SESSION, 'subagents', `agent-${REVIEWER.agent_id}.jsonl`), content: '{}' }, REVIEWER)],
  ])('is refused %s', (_label, decide) => {
    expect(decide()).toMatchObject({ ok: false });
  });

  it("may not Write over a verdict already taken from a reviewer's final answer, nor over another reviewer's", () => {
    const dir = join(control, '.mycelink', 'reviews', 'FEAT-7', 'FEAT-7-R002', '7b1d2c4e-0000-4000-8000-000000000002');
    mkdirSync(dir, { recursive: true });
    const verdict = join(dir, 'verdict.json');
    // Nothing there yet: the Write is allowed (and attested).
    expect(call('Write', { file_path: verdict, content: '{}' }, REVIEWER)).toMatchObject({ ok: true, attest: { file: verdict } });
    writeFileSync(verdict, '{"a":1}');
    // Its own earlier Write, attested as its own: it may write it again.
    writeFileSync(join(dir, 'verdict.attest.json'), JSON.stringify({ schema: 'mycelink-review-attestation/1', transport: 'file', agent_id: REVIEWER.agent_id, agent_type: REVIEWER.agent_type, content_sha256: canonicalVerdictSha256('{"a":1}') }));
    expect(call('Write', { file_path: verdict, content: '{"a":2}' }, REVIEWER)).toMatchObject({ ok: true });
    // Another reviewer's: refused.
    const other = call('Write', { file_path: verdict, content: '{"a":3}' }, OTHER_REVIEWER);
    expect(other).toMatchObject({ ok: false });
    if (!other.ok) expect(other.reason).toMatch(/already holds a verdict/);
    // One ingested from a final answer: refused, whoever writes.
    writeFileSync(join(dir, 'verdict.attest.json'), JSON.stringify({ schema: 'mycelink-review-attestation/1', transport: 'agent-result', agent_id: REVIEWER.agent_id, agent_type: REVIEWER.agent_type, content_sha256: canonicalVerdictSha256('{"a":1}') }));
    const taken = call('Write', { file_path: verdict, content: '{"a":4}' }, REVIEWER);
    expect(taken).toMatchObject({ ok: false });
    if (!taken.ok) expect(taken.reason).toMatch(/already holds a verdict/);
  });
});

describe("nobody writes Claude Code's transcripts", () => {
  const sessionTranscript = (): string => join(projects, `${SESSION}.jsonl`);
  const subagentTranscript = (): string => join(projects, SESSION, 'subagents', 'agent-a0123456789abcdef.jsonl');
  const subagentMeta = (): string => join(projects, SESSION, 'subagents', 'agent-a0123456789abcdef.meta.json');

  it.each([
    ['the controller Writes the session transcript', () => call('Write', { file_path: sessionTranscript(), content: '{}' })],
    ['the controller Writes a subagent transcript', () => call('Write', { file_path: subagentTranscript(), content: '{}' })],
    ['the controller Writes a subagent meta', () => call('Write', { file_path: subagentMeta(), content: '{"agentType":"mycelink:acceptance-reviewer"}' })],
    ['the controller Edits a subagent transcript', () => call('Edit', { file_path: subagentTranscript(), old_string: 'a', new_string: 'b' })],
    ['the controller appends to the session transcript', () => call('Bash', { command: `echo '{}' >> ${s(sessionTranscript())}` })],
    ['the controller copies a forged transcript in', () => call('Bash', { command: `cp /tmp/forged.jsonl ${s(subagentTranscript())}` })],
    ['the controller writes one through $HOME', () => call('Bash', { command: `printf x > "$HOME/.claude/projects/-tmp-workspace/${SESSION}/subagents/agent-a1.jsonl"` })],
    ['a module-worker Writes a subagent transcript', () => call('Write', { file_path: subagentTranscript(), content: '{}' }, WORKER)],
  ])('refuses: %s', (_label, decide) => {
    const d = decide();
    expect(d).toMatchObject({ ok: false });
    if (!d.ok) expect(d.reason).toMatch(/transcript/);
  });

  it("leaves Claude Code's memory files and other files alone", () => {
    expect(call('Write', { file_path: join(projects, 'memory', 'note.md'), content: 'x' })).toEqual({ ok: true });
    expect(call('Write', { file_path: join(home, 'notes.txt'), content: 'x' })).toEqual({ ok: true });
  });

  it('honours CLAUDE_CONFIG_DIR', () => {
    const config = join(root, 'config');
    const d = fenceDecision({ tool_name: 'Write', tool_input: { file_path: join(config, 'projects', 'p', `${SESSION}.jsonl`), content: '{}' }, cwd: root }, { HOME: home, CLAUDE_CONFIG_DIR: config });
    expect(d).toMatchObject({ ok: false });
  });
});
