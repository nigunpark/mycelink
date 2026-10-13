#!/usr/bin/env node
/**
 * A stand-in for a with-arm host session on the real CSET-201 workspace
 * (never a benchmark subject), for the model-free check that worktree setup
 * fixes what stopped the first pilot: the base checkout had node_modules,
 * every Mycelink node worktree had none, and the types node's GREEN
 * (`pnpm build`) exited 127.
 *
 * Inside the session's sandbox it drives the sealed plugin as the run
 * command tells a host to: init the control repository (the generated
 * repositories.yaml is kept), open the key, plan the r1 controller's graph
 * (types, declaration-only -> assemble -> cli -> candidate), dispatch, and
 * work the types node as its worker would — the ReleaseReason declaration
 * from the public requirement, GREEN, the production-only commit, regression
 * — settle it, dispatch again, and run the downstream node's own
 * verification in its worktree. It records what it saw in $FAKE_CLAUDE_PLAN's
 * log and exits 0; it never delivers.
 */
import { execSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Pipes are asynchronous on macOS and Windows (synchronous on Linux): a stand-in that exits right after its last
// line would drop what was still buffered, cutting its own stream mid-line. Write through, as a real CLI does.
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);

const plan = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_PLAN, 'utf8'));
const given = process.argv.slice(2);
readFileSync(0, 'utf8');
const ws = process.cwd();
const control = join(ws, 'platform');
const FEATURE = 'CSET-201';
const bin = join(given[given.indexOf('--plugin-dir') + 1], 'bin', 'mycelink.mjs');
// Host mode starts no worker process: an accidental nested spawn fails on a stand-in that is not there.
const env = { ...process.env, CLAUDE_PID: String(process.pid), MYCELINK_FAKE_CLAUDE: join(process.cwd(), 'no-claude-here') };
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (entry) => appendFileSync(plan.log, `${JSON.stringify(entry)}\n`);
let toolId = 0;
function bash(command, run) {
  const id = `toolu_fake_${++toolId}`;
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const r = run();
  emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000) }] } });
  return r;
}
function mycelink(args, { allowFail = false } = {}) {
  const r = bash(`node ${bin} ${args.join(' ')}`, () => spawnSync(process.execPath, [bin, ...args], { cwd: ws, env, encoding: 'utf8', maxBuffer: 64 << 20 }));
  if (r.status !== 0 && !allowFail) throw new Error(`mycelink ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}
const json = (args) => JSON.parse(mycelink(args).stdout);
const git = (cwd, args) => {
  const r = bash(`git -C ${cwd} ${args.join(' ')}`, () => spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }));
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const sh = (cwd, script) => bash(script, () => spawnSync('sh', ['-c', script], { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20 }));
const commitControl = (message) => {
  git(control, ['add', '--all']);
  git(control, ['commit', '-q', '--no-verify', '--allow-empty', '-m', message]);
};

const BUILD = 'pnpm build && git checkout -- packages/config/package.json';
const worker = { model: 'sonnet', effort: 'high', max_turns: 30, max_wall_clock_minutes: 30, max_attempts: 2, nested_delegation: false };
const node = (id, extra) => ({ id, level: 'executable-node', repository: 'changesets', forbidden_paths: [], contract_inputs: [], contract_outputs: [], required_resources: [], worker, invalidation_rules: [], ...extra });
const TYPES = `${FEATURE}.types.reason.impl`;
const ASSEMBLE = `${FEATURE}.assemble.reasons.impl`;
const CLI = `${FEATURE}.cli.explain.impl`;
/** The graph, its verifiers selected from the module allowlist `repo modules` prints. */
const graphOf = (verifier) => ({
  schema_version: 1,
  feature_id: FEATURE,
  title: 'Explain why each package is in the release plan',
  prd: `features/${FEATURE}/PRD.md`,
  acceptance_criteria: [
    { id: 'AC-1', text: 'types: ReleaseReason union and optional reasons on ComprehensiveRelease' },
    { id: 'AC-2', text: 'assemble-release-plan records reasons causally when options.explain is true' },
    { id: 'AC-3', text: 'changeset status --explain prints reason lines and writes reasons with --output' },
  ],
  resources: { workspace: { capacity: 1 } },
  repositories: ['changesets'],
  capabilities: [
    { id: 'CAP-TYPES', repository: 'changesets', title: 'ReleaseReason types', acceptance_criteria: ['AC-1'] },
    { id: 'CAP-ASSEMBLE', repository: 'changesets', title: 'Record release reasons', acceptance_criteria: ['AC-2'] },
    { id: 'CAP-CLI', repository: 'changesets', title: 'status --explain', acceptance_criteria: ['AC-3'] },
  ],
  nodes: [
    node(TYPES, { capability: 'CAP-TYPES', node_type: 'contract-lock', depends_on: [], allowed_paths: ['packages/types/**'], required_evidence: ['green', 'regression'], verification_commands: [verifier('types')], acceptance_criteria: ['AC-1'] }),
    node(ASSEMBLE, { capability: 'CAP-ASSEMBLE', node_type: 'implementation', depends_on: [TYPES], allowed_paths: ['packages/assemble-release-plan/**'], required_evidence: ['red', 'green', 'regression'], verification_commands: [verifier('assemble-release-plan')], acceptance_criteria: ['AC-2'] }),
    node(CLI, { capability: 'CAP-CLI', node_type: 'implementation', depends_on: [ASSEMBLE], allowed_paths: ['packages/cli/**'], required_evidence: ['red', 'green', 'regression'], verification_commands: [verifier('cli')], acceptance_criteria: ['AC-3'] }),
  ],
});

// The declaration AC-1 of the public requirement asks for.
const REASON = `export type ReleaseReason =
  | { type: "changeset"; changeset: string; bumpType: VersionType }
  | {
      type: "dependent";
      dependency: string;
      dependencyType: DependencyType;
      versionRange: string;
      bumpType: VersionType;
    }
  | { type: "fixed"; group: string[]; bumpType: VersionType }
  | { type: "linked"; group: string[]; bumpType: VersionType }
  | { type: "prerelease-exit"; bumpType: "patch" };

`;

emit({ type: 'system', subtype: 'init', cwd: ws });
const seen = { probes: {} };
for (const p of plan.probePaths ?? []) seen.probes[p] = existsSync(p) ? 'present' : 'ENOENT';

mycelink(['init', control]);
const key = json(['controller', 'open', '--control-root', control, '--json']).authority;
seen.registered = readFileSync(join(control, 'repositories.yaml'), 'utf8');
const featureDir = join(control, 'features', FEATURE);
mkdirSync(featureDir, { recursive: true });
writeFileSync(join(featureDir, 'PRD.md'), readFileSync(join(control, 'requirements', `${FEATURE}.md`)));
const allowlist = json(['repo', 'modules', '--control-root', control, '--json']).repositories[0];
seen.modules = allowlist.modules.map((m) => ({ id: m.id, path: m.path, runtime_tests: m.runtime_tests, test: m.test }));
const verifier = (id) => allowlist.modules.find((m) => m.id === id).verifier;
writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), JSON.stringify(graphOf(verifier), null, 2) + '\n');
commitControl(`${FEATURE}: control plane`);
mycelink(['graph', 'validate', FEATURE, '--control-root', control, '--json']);
mycelink(['feature', 'init', FEATURE, '--control-root', control, '--authority', key, '--json']);
commitControl(`${FEATURE}: feature initialised`);

const first = json(['dispatch', FEATURE, '--control-root', control, '--authority', key, '--json']);
seen.first = { status: first.status, detail: first.detail, node: first.ticket?.node_id, worktree_setup: first.ticket?.worktree_setup };
if (first.status === 'DISPATCHED') {
  const t = first.ticket;
  const wt = t.worktree;
  seen.first.tsdown = existsSync(join(wt, 'node_modules', '.bin', 'tsdown'));
  const file = join(wt, 'packages', 'types', 'src', 'index.ts');
  let src = readFileSync(file, 'utf8');
  src = src.replace('interface ComprehensiveReleaseBase {\n  name: string;', `${REASON}interface ComprehensiveReleaseBase {\n  name: string;\n  reasons?: ReleaseReason[];`);
  writeFileSync(file, src);
  const verify = sh(wt, `${BUILD} && pnpm tsc`);
  seen.first.verify = { status: verify.status, tail: `${verify.stdout}${verify.stderr}`.slice(-600) };
  const gate = (name) => {
    const line = t.gate_commands.find((g) => g.gate === name).command;
    const r = bash(line, () => {
      try {
        return { status: 0, stdout: execSync(line, { cwd: control, env, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 << 20 }), stderr: '' };
      } catch (error) {
        return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
      }
    });
    return { gate: name, exit: r.status, sha256: /sha256 ([0-9a-f]{64})/.exec(r.stdout)?.[1] ?? null, tail: `${r.stdout}${r.stderr}`.slice(-400) };
  };
  seen.first.gates = [gate('green')];
  git(wt, ['add', '--', 'packages/types/src/index.ts']);
  git(wt, ['commit', '-q', '--no-verify', '-m', 'feat(types): ReleaseReason and optional reasons']);
  seen.first.gates.push(gate('regression'));
  const result = {
    schema_version: 1,
    node_id: t.node_id,
    claim_id: t.claim_id,
    dispatch_id: t.dispatch_id,
    outcome: 'SUBMITTED',
    commands: seen.first.gates.map((g) => ({ command: [`gate:${g.gate}`], exit_code: g.exit })),
    commit_sha: git(wt, ['rev-parse', 'HEAD']),
    changed_paths: ['packages/types/src/index.ts'],
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
    // AC-1 is a declaration: the typecheck its GREEN ran is the evidence.
    criterion_evidence: [{ criterion: 'AC-1', gate: 'green', output_sha256: seen.first.gates[0].sha256 }],
  };
  mkdirSync(join(wt, '.mycelink-worker'), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  const settled = json(['settle', FEATURE, t.node_id, '--capability', t.capability, '--control-root', control, '--json']);
  seen.settled = { outcome: settled.outcome, detail: settled.detail };
  commitControl(`${FEATURE}: types settled`);
  const second = json(['dispatch', FEATURE, '--control-root', control, '--authority', key, '--json']);
  seen.second = { status: second.status, detail: second.detail, node: second.ticket?.node_id, worktree_setup: second.ticket?.worktree_setup };
  if (second.status === 'DISPATCHED') {
    const downstream = sh(second.ticket.worktree, `${BUILD} && pnpm vitest run packages/assemble-release-plan`);
    seen.second.verify = { status: downstream.status, tail: `${downstream.stdout}${downstream.stderr}`.slice(-600) };
  }
}
log(seen);
emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 9, total_cost_usd: 0, result: `types: ${seen.settled?.outcome ?? first.status}; next: ${seen.second?.node ?? '-'}` });
process.exit(0);
