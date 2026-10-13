/**
 * The acceptance reviewer is read-only, and its verdict is attested.
 *
 * The reviewer subagent (agents/acceptance-reviewer.md) judges the work of
 * the module-workers before any candidate; its only output is one JSON
 * verdict. The plugin's PreToolUse fence (hooks/fence.ts) holds it to that,
 * whatever its tools list says: no Edit, no shell, no subagent, and a Write
 * only to a verdict file of an open review in Mycelink's scratch area
 * (`.mycelink/reviews/<feature>/<review>/<dispatch>/verdict.json`). Every
 * such Write it lets through is attested beside the verdict — the subagent's
 * id and type, the session and the hash of what it wrote — so settle can
 * refuse a verdict anyone else put there. Nobody else writes it: the
 * controller and a module-worker are refused there as in the rest of the
 * scratch area, and a module-worker never settles a review.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { makeGitRepo } from '../helpers/git-fixture.js';
import { fenceDecision } from '../../src/hooks/fence.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { canonicalVerdictSha256 } from '../../src/engine/acceptance-review.js';

afterAll(() => cleanupTmpRoots());

const REVIEWER = { agent_id: 'a91b2c3d4e5f60718', agent_type: 'mycelink:acceptance-reviewer' };
const WORKER = { agent_id: 'a0000000000000901', agent_type: 'mycelink:module-worker' };
let root: string;
let control: string;
let repo: string;
let slot: string;

beforeAll(() => {
  root = makeTmpDir('reviewer-fence-');
  control = join(root, 'platform');
  repo = makeGitRepo(join(root, 'repos', 'app'), { files: { 'src/a.mjs': 'export const a = 1;\n' } });
  makeGitRepo(control, {
    files: {
      'mycelink.config.json': '{ "schema_version": 1 }\n',
      'repositories.yaml': YAML.stringify({ schema_version: 1, repositories: [{ name: 'app', path: '../repos/app', base_branch: 'main', commands: { test: ['node', '--test'] } }] }),
      'features/FEAT-7/PRD.md': '# FEAT-7\n',
    },
  });
  slot = join(control, '.mycelink', 'reviews', 'FEAT-7', 'FEAT-7-R001', '7b1d2c4e-0000-4000-8000-000000000001', 'verdict.json');
  mkdirSync(join(slot, '..'), { recursive: true });
});

const call = (tool: string, input: Record<string, unknown>, who: Record<string, string> = REVIEWER) => fenceDecision({ tool_name: tool, tool_input: input, cwd: root, ...who }, { HOME: root });

describe('the reviewer reads, and writes only its verdict', () => {
  it('may Write the verdict file of an open review', () => {
    expect(call('Write', { file_path: slot, content: '{}' })).toMatchObject({ ok: true });
  });

  it.each([
    ['a product file', () => call('Write', { file_path: join(repo, 'src', 'a.mjs'), content: 'x' })],
    ['a new product file', () => call('Write', { file_path: join(repo, 'src', 'b.mjs'), content: 'x' })],
    ['the PRD', () => call('Write', { file_path: join(control, 'features', 'FEAT-7', 'PRD.md'), content: 'x' })],
    ['the graph', () => call('Write', { file_path: join(control, 'features', 'FEAT-7', 'PORTFOLIO-GRAPH.yaml'), content: 'x' })],
    ['STATE', () => call('Write', { file_path: join(control, 'features', 'FEAT-7', 'STATE.json'), content: '{}' })],
    ['a review receipt', () => call('Write', { file_path: join(control, 'features', 'FEAT-7', 'reviews', 'FEAT-7-R001.json'), content: '{}' })],
    ['its attestation', () => call('Write', { file_path: join(slot, '..', 'verdict.attest.json'), content: '{}' })],
    ['another name in its slot', () => call('Write', { file_path: join(slot, '..', 'notes.json'), content: '{}' })],
    ['a slot that was never opened', () => call('Write', { file_path: join(control, '.mycelink', 'reviews', 'FEAT-7', 'FEAT-7-R009', '7b1d2c4e-0000-4000-8000-000000000009', 'verdict.json'), content: '{}' })],
    ['the packet', () => call('Write', { file_path: join(control, '.mycelink', 'reviews', 'FEAT-7', 'FEAT-7-R001', 'packet.json'), content: '{}' })],
    ['a file outside the workspace', () => call('Write', { file_path: join(makeTmpDir('elsewhere-'), 'x.txt'), content: 'x' })],
    ['its verdict, by Edit', () => call('Edit', { file_path: slot, old_string: 'a', new_string: 'b' })],
    ['its verdict, by MultiEdit', () => call('MultiEdit', { file_path: slot, edits: [] })],
    ['a notebook', () => call('NotebookEdit', { notebook_path: join(repo, 'n.ipynb'), new_source: 'x' })],
    ['a shell read', () => call('Bash', { command: `cat ${join(repo, 'src', 'a.mjs').replace(/\\/g, '/')}` })],
    ['a shell write', () => call('Bash', { command: `echo x > ${slot.replace(/\\/g, '/')}` })],
    ['a test run', () => call('Bash', { command: 'node --test' })],
    ['a subagent', () => call('Agent', { subagent_type: 'mycelink:module-worker', description: 'fix', prompt: 'fix AC-1' })],
    ['a task', () => call('Task', { subagent_type: 'general-purpose', description: 'x', prompt: 'x' })],
  ])('is refused %s', (_label, decide) => {
    const d = decide();
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/^Blocked: .*acceptance reviewer/);
  });

  it('reads freely', () => {
    for (const tool of ['Read', 'Glob', 'Grep']) expect(call(tool, { file_path: join(repo, 'src', 'a.mjs'), pattern: '**/*', path: repo })).toMatchObject({ ok: true });
  });
});

describe('nobody else writes a verdict; a worker never settles a review', () => {
  it('the controller and a module-worker are refused at the verdict file', () => {
    for (const who of [{}, WORKER, { agent_id: 'x1', agent_type: 'general-purpose' }]) {
      const d = call('Write', { file_path: slot, content: '{}' }, who as Record<string, string>);
      expect(d.ok, JSON.stringify(who)).toBe(false);
    }
    expect(call('Bash', { command: `cp /tmp/v.json ${slot.replace(/\\/g, '/')}` }, {}).ok).toBe(false);
  });

  it('a module-worker never runs review settle, and spawns no subagent', () => {
    const settle = call('Bash', { command: 'node /opt/plugin/bin/mycelink.mjs review settle FEAT-7 --review FEAT-7-R001 --capability ab --json' }, WORKER);
    expect(settle.ok).toBe(false);
    if (!settle.ok) expect(settle.reason).toMatch(/review/);
    expect(call('Agent', { subagent_type: 'general-purpose', description: 'x', prompt: 'x' }, WORKER).ok).toBe(false);
  });

  it('the controller still dispatches subagents', () => {
    expect(call('Agent', { subagent_type: 'mycelink:acceptance-reviewer', description: 'acceptance review FEAT-7-R001', prompt: 'x' }, {})).toMatchObject({ ok: true });
  });

  it('the plugin registers the fence for subagent launches too', () => {
    const hooks = JSON.parse(readFileSync(join(process.cwd(), 'hooks', 'hooks.json'), 'utf8')) as { hooks: { PreToolUse: { matcher: string }[] } };
    const matcher = new RegExp(`^(?:${hooks.hooks.PreToolUse[0]!.matcher})$`);
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'Task']) expect(matcher.test(tool), tool).toBe(true);
    for (const tool of ['Read', 'Glob', 'Grep']) expect(matcher.test(tool), tool).toBe(false);
  });
});

describe('the verdict Write the fence lets through is attested', () => {
  async function hook(payload: Record<string, unknown>): Promise<{ code: number; err: string }> {
    let err = '';
    const io: CliIo = { out: () => undefined, err: (t) => (err += t), stdin: JSON.stringify(payload) };
    return { code: await main(['hook', 'controller-fence'], io), err };
  }

  it('records the subagent, the session and the canonical hash of what it wrote, beside the verdict', async () => {
    const content = JSON.stringify({ schema: 'mycelink-acceptance-review/1', overall: 'PASS' }, null, 2);
    const r = await hook({ session_id: 'session-42', agent_id: REVIEWER.agent_id, agent_type: REVIEWER.agent_type, cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: slot, content } });
    expect(r).toEqual({ code: 0, err: '' });
    const attest = JSON.parse(readFileSync(join(slot, '..', 'verdict.attest.json'), 'utf8'));
    expect(attest).toMatchObject({ schema: 'mycelink-review-attestation/1', agent_id: REVIEWER.agent_id, agent_type: REVIEWER.agent_type, session_id: 'session-42', content_sha256: canonicalVerdictSha256(content) });
    // Reformatting is not a different verdict; any other change is.
    expect(canonicalVerdictSha256(JSON.stringify(JSON.parse(content)))).toBe(attest.content_sha256);
    expect(canonicalVerdictSha256(content.replace('PASS', 'GAPS'))).not.toBe(attest.content_sha256);
    expect(canonicalVerdictSha256('not json')).toBe(createHash('sha256').update('not json').digest('hex'));
  });

  it('attests nothing it refuses', async () => {
    const elsewhere = join(control, '.mycelink', 'reviews', 'FEAT-7', 'FEAT-7-R002', '7b1d2c4e-0000-4000-8000-000000000002');
    mkdirSync(elsewhere, { recursive: true });
    const r = await hook({ session_id: 's', agent_id: 'w', agent_type: WORKER.agent_type, cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(elsewhere, 'verdict.json'), content: '{}' } });
    expect(r.code).toBe(2);
    expect(existsSync(join(elsewhere, 'verdict.attest.json'))).toBe(false);
    writeFileSync(join(elsewhere, 'marker'), 'x');
  });
});
