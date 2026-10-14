#!/usr/bin/env node
/**
 * The quickstart feature, end to end, with a scripted worker and reviewer:
 * no model, no network, nothing outside a temporary directory.
 *
 *   node examples/quickstart/walkthrough.mjs [--out <empty dir>] [--keep] [--pace <ms>] [--mycelink <bin/mycelink.mjs>]
 *
 * Without --out it works in a new temporary directory and removes it at the end (--keep keeps it). A directory
 * given with --out is set up as setup.mjs would (an empty or new one) and always kept.
 *   node examples/quickstart/walkthrough.mjs --write-sample     regenerate SAMPLE-OUTPUT.md
 *
 * Everything the controller does here is real: the workspace setup.mjs
 * creates, the controller key, the graph's READY set, dispatch tickets,
 * isolated worktrees, the red/green/regression gates, settle's clean
 * re-verification and integration, the acceptance review's packet and
 * settle, the immutable candidate and delivery. What is scripted is the
 * part a model plays in a real run:
 *
 *  - the module-worker: it writes the files under scripted/ into the ticket's
 *    worktree, runs the ticket's gate lines (parsed back into argv, no
 *    shell), commits test-only then production-only, and writes its result;
 *  - the acceptance reviewer: its verdicts are fixed. Review 1 answers GAP on
 *    AC-4, because the scripted web worker's first implementation is planted
 *    with a fault no test covers (it throws on a payload without a status).
 *    Its verdict file is written through the plugin's PreToolUse fence, as
 *    the reviewer subagent's Write would be.
 *
 * The output is what SAMPLE-OUTPUT.md holds. It is not a model run.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  API_NODE,
  CANDIDATE_NODE,
  CHECKOUT_LAUNCHER,
  FEATURE_ID,
  HERE,
  QuickstartError,
  REPOS,
  WEB_NODE,
  cleanEnv,
  commitAll,
  copyTemplate,
  createWorkspace,
  fixedDateEnv,
  git,
  mycelinkArgv,
  run,
} from './lib/quickstart.mjs';

const REVIEWER = 'mycelink:acceptance-reviewer';
/** Synthetic ids for the scripted reviewer's tool call (no Claude Code session exists). */
const SCRIPTED_SESSION = '00000000-0000-4000-8000-000000000001';
const SCRIPTED_AGENT = 'a0000000000000001';
const SAMPLE = join(HERE, 'SAMPLE-OUTPUT.md');

/** What each scripted worker generation does: its steps under scripted/, and the test that proves each criterion. */
const SCRIPT = {
  [API_NODE]: [
    {
      red: 'api/1-red',
      green: 'api/2-green',
      proofs: { 'AC-1': 'a delayed order is published with its eta at contract version 2', 'AC-2': 'a delayed order without a valid eta is refused, naming the order' },
    },
  ],
  [WEB_NODE]: [
    { red: 'web/1-red', green: 'web/2-green', proofs: { 'AC-3': 'a delayed order shows its new expected date', 'AC-4': 'an unknown status shows Status unavailable' } },
    { red: 'web/3-rework-red', green: 'web/4-rework-green', proofs: { 'AC-4': 'a payload without a status shows Status unavailable' } },
  ],
};

/** The scripted reviewer's verdicts, by review: a GAP on AC-4 in the first, nothing in the second. */
const GAPS = [
  {
    'AC-4': {
      summary: 'no test renders a payload without a status',
      missing: 'AC-4 says a payload "that has no status at all" renders "Status unavailable" and rendering never throws; the only AC-4 test renders an unknown status string, and statusLine calls payload.status.toLowerCase(), which throws when status is absent',
      reproduction: 'render { version: 2, id: "A-10" } (no status field) and assert the line is exactly "Order A-10: Status unavailable" without throwing',
      producer: { node_id: WEB_NODE, module: 'web:ui' },
    },
  },
  {},
];

function parseArgs(argv) {
  const opts = { out: null, keep: false, pace: 0, mycelink: CHECKOUT_LAUNCHER, writeSample: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') opts.keep = true;
    else if (a === '--write-sample') opts.writeSample = true;
    else if (a === '--out' || a === '--mycelink' || a === '--pace') {
      const v = argv[++i];
      if (v === undefined) throw new QuickstartError(`${a} needs a value`);
      if (a === '--pace') opts.pace = Number(v);
      else opts[a.slice(2)] = v;
    } else if (a === '--help' || a === '-h') opts.help = true;
    else throw new QuickstartError(`Unknown argument ${JSON.stringify(a)}`);
  }
  return opts;
}

// ---- output -----------------------------------------------------------------

const lines = [];
let pace = 0;
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function say(tag, text = '') {
  const line = tag === '' ? text : `${`[${tag}]`.padEnd(13)}${text}`;
  lines.push(line);
  process.stdout.write(`${line}\n`);
  if (pace > 0) sleep(pace);
}
const short = (sha) => (sha ?? '').slice(0, 12);

// ---- the controller, through its CLI ----------------------------------------

let ctx = null;

/** Run the CLI as the host does: argv, from the control repository. Controller commands carry the key. */
function cli(args, { authority = false, allowFail = false } = {}) {
  const argv = mycelinkArgv(ctx.launcher, [...args, '--control-root', ctx.control, ...(authority ? ['--authority', ctx.key] : [])]);
  const r = run(argv, { cwd: ctx.control, env: cleanEnv(fixedDateEnv()) });
  if (r.code !== 0 && !allowFail) throw new QuickstartError(`mycelink ${args.slice(0, 2).join(' ')} exited ${r.code}\n${r.stdout}${r.stderr}`);
  return r;
}
const cliJson = (args, options) => JSON.parse(cli([...args, '--json'], options).stdout);

/**
 * A gate or settle line from a ticket, back into argv. The controller renders
 * only arguments every shell reads alike (worker-protocol.ts renderGateCommand):
 * bare words, or double-quoted words without quotes or escapes inside.
 */
function lineArgv(line) {
  const argv = [];
  for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) argv.push(m[1] ?? m[2]);
  if (argv[0] === 'node') argv[0] = process.execPath;
  return argv;
}

function runLine(line) {
  return run(lineArgv(line), { cwd: ctx.control, env: cleanEnv(fixedDateEnv()) });
}

function commitControl(message) {
  if (git(ctx.control, ['status', '--porcelain']) === '') return;
  commitAll(ctx.control, message);
}

function state() {
  return JSON.parse(readFileSync(join(ctx.control, 'features', FEATURE_ID, 'STATE.json'), 'utf8')).data;
}

// ---- the scripted module-worker -----------------------------------------------

/** The `<id> <status> <path> › <name>` lines a gate prints. */
function gateTests(out) {
  return [...out.matchAll(/^ {2}([0-9a-f]{16}) (passed|failed|skipped) (.+?) › (.*)$/gm)].map((m) => ({ id: m[1], status: m[2], path: m[3], name: m[4] }));
}

function gate(ticket, name) {
  const line = ticket.gate_commands.find((g) => g.gate === name)?.command;
  if (line === undefined) throw new QuickstartError(`the ticket for ${ticket.node_id} has no ${name} gate`);
  const r = runLine(line);
  const out = `${r.stdout}${r.stderr}`;
  return { code: r.code, out, sha256: /sha256 ([0-9a-f]{64})/.exec(out)?.[1] ?? null, tests: gateTests(out) };
}

function packOf(ticket) {
  const m = /<mycelink-context-pack>\s*([\s\S]*?)\s*<\/mycelink-context-pack>/.exec(ticket.prompt);
  if (!m) throw new QuickstartError('no context pack in the ticket prompt');
  return JSON.parse(m[1]);
}

function commitWorktree(worktree, files, message) {
  git(worktree, ['-c', 'commit.gpgsign=false', 'add', '--', ...files]);
  git(worktree, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], fixedDateEnv());
  return git(worktree, ['rev-parse', 'HEAD']);
}

/** The worker's own TDD claim: each run of test-only commits, then the production commits after it. */
function tddClaim(worktree, base, head, testFiles) {
  const cycles = [];
  for (const sha of git(worktree, ['log', '--reverse', '--format=%H', `${base}..${head}`]).split('\n').filter(Boolean)) {
    const files = git(worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean);
    const isTest = files.every((f) => testFiles.has(f));
    const last = cycles.at(-1);
    if (isTest && (last === undefined || last.green_commits.length > 0)) cycles.push({ red_commits: [sha], green_commits: [] });
    else if (isTest) last.red_commits.push(sha);
    else last.green_commits.push(sha);
  }
  return { base_sha: base, head_sha: head, cycles };
}

function fulfil(ticket) {
  const pack = packOf(ticket);
  const generation = pack.rework ? 1 : 0;
  const script = SCRIPT[ticket.node_id]?.[generation];
  if (script === undefined) throw new QuickstartError(`no script for ${ticket.node_id} generation ${generation}`);
  const repo = ticket.repository;
  const wt = ticket.worktree;
  if (pack.rework) say('rework', `${ticket.node_id}: brief from ${pack.rework.origin?.review_id ?? 'review'}, criteria ${pack.rework.acceptance_criteria.join(', ')}`);

  const tests = copyTemplate(join(HERE, 'scripted', script.red), wt);
  const red = gate(ticket, 'red');
  const failed = red.tests.filter((t) => t.status === 'failed');
  if (red.code !== 0) throw new QuickstartError(`the red gate refused the scripted RED:\n${red.out}`);
  say('red', `${repo}: RED accepted, ${failed.length} declared test${failed.length === 1 ? '' : 's'} failed for the missing behaviour`);
  for (const t of failed) say('', `${''.padEnd(13)}  failed  ${t.name}`);
  const redSha = commitWorktree(wt, tests, `test(${repo}): ${ticket.node_id} RED`);
  say('commit', `${repo}: ${short(redSha)} tests only`);

  const impl = copyTemplate(join(HERE, 'scripted', script.green), wt);
  const green = gate(ticket, 'green');
  if (green.code !== 0) throw new QuickstartError(`the green gate failed:\n${green.out}`);
  say('green', `${repo}: module tests pass, the same command the RED failed`);
  const greenSha = commitWorktree(wt, impl, `feat(${repo}): ${ticket.node_id}`);
  say('commit', `${repo}: ${short(greenSha)} production only`);
  const regression = gate(ticket, 'regression');
  if (regression.code !== 0) throw new QuickstartError(`the regression gate failed:\n${regression.out}`);
  say('regress', `${repo}: full suite passes`);

  const criterion_evidence = Object.entries(script.proofs).map(([criterion, name]) => {
    const t = red.tests.find((x) => x.name === name && x.status === 'failed');
    if (t === undefined) throw new QuickstartError(`the red gate printed no failed test "${name}"`);
    return { criterion, test_id: t.id, gate: 'red', output_sha256: red.sha256 };
  });
  for (const carried of pack.rework?.carried_criteria ?? []) {
    if (!criterion_evidence.some((e) => e.criterion === carried.criterion)) criterion_evidence.push({ criterion: carried.criterion, test_id: carried.test_id, gate: 'red', output_sha256: carried.output_sha256 });
  }
  const head = git(wt, ['rev-parse', 'HEAD']);
  const result = {
    schema_version: 1,
    node_id: ticket.node_id,
    claim_id: ticket.claim_id,
    dispatch_id: ticket.dispatch_id,
    orchestration_epoch: ticket.orchestration?.epoch ?? 0,
    outcome: 'SUBMITTED',
    commands: [red, green, regression].map((g, i) => ({ command: [`gate:${['red', 'green', 'regression'][i]}`], exit_code: g.code })),
    commit_sha: head,
    changed_paths: [...tests, ...impl],
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
    tdd: tddClaim(wt, ticket.tdd.base_sha, head, new Set(tests)),
    criterion_evidence,
  };
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, JSON.stringify(result, null, 2) + '\n');
  const check = runLine(ticket.gate_commands.find((g) => g.gate === 'red').command.replace(' tdd red ', ' tdd check '));
  if (check.code !== 0) throw new QuickstartError(`tdd check refused the scripted result:\n${check.stdout}${check.stderr}`);
  const proved = Object.keys(script.proofs).sort();
  const carried = criterion_evidence.map((e) => e.criterion).filter((c) => !proved.includes(c)).sort();
  say('result', `${ticket.node_id}: SUBMITTED, ${proved.join(' ')} proved by this RED${carried.length > 0 ? `, ${carried.join(' ')} carried from the earlier RED` : ''} (tdd check ok)`);

  const settled = runLine(ticket.settle_command);
  const out = JSON.parse(settled.stdout);
  if (out.outcome !== 'DONE') throw new QuickstartError(`settle answered ${out.outcome}:\n${settled.stdout}${settled.stderr}`);
  const integrated = git(ctx.repos[repo], ['rev-parse', `feature/${FEATURE_ID}`]);
  say('settle', `${ticket.node_id}: DONE, re-verified on a clean checkout, feature/${FEATURE_ID} @ ${short(integrated)}`);
}

// ---- the scripted acceptance reviewer -------------------------------------------

function verdictFor(packet, gaps) {
  const repoOf = (node) => packet.nodes.find((n) => n.id === node)?.repository ?? null;
  const criteria = packet.criteria.map((c) => {
    const proofs = packet.criterion_evidence.filter((e) => e.criterion === c.id && e.test_id !== null);
    const evidence = [...new Set(proofs.flatMap((e) => [`test:${e.test_id}`, `file:${e.repository ?? repoOf(e.node)}:${e.test.path}`]))];
    const names = proofs.map((e) => e.test.name).join('; ');
    const gap = gaps[c.id];
    return {
      criterion: c.id,
      verdict: gap ? 'GAP' : 'PASS',
      confidence: 'high',
      clauses: c.clauses.map((cl) => ({ clause: cl.id, evidence, trace: `${cl.id} is asserted by ${names}` })),
      boundaries: [{ kind: 'failure', boundary: `the failure paths ${c.id} names`, covered: !gap, evidence: gap ? [] : evidence.filter((e) => e.startsWith('test:')) }],
      gap: gap ? { missing: gap.missing, reproduction: gap.reproduction } : null,
      producer: gap ? gap.producer : null,
    };
  });
  return {
    schema: 'mycelink-acceptance-review/1',
    feature_id: packet.feature_id,
    review_id: packet.review_id,
    dispatch_id: packet.dispatch_id,
    inputs_sha256: packet.inputs_sha256,
    reviewer: { agent: REVIEWER, model: 'scripted-walkthrough' },
    criteria,
    overall: criteria.some((c) => c.verdict === 'GAP') ? 'GAPS' : 'PASS',
  };
}

function review(ticket, round) {
  const packet = JSON.parse(readFileSync(ticket.packet_path, 'utf8'));
  say('review', `${ticket.review_id}: independent read-only review of ${packet.criteria.length} criteria against ${packet.repositories.map((r) => `${r.name}@${short(r.head_sha)}`).join(' ')}`);
  const gaps = GAPS[round] ?? {};
  const content = JSON.stringify(verdictFor(packet, gaps), null, 2);
  // The reviewer's only write, through the fence the plugin installs, as its Write tool call would be.
  const event = { session_id: SCRIPTED_SESSION, agent_id: SCRIPTED_AGENT, agent_type: REVIEWER, cwd: ctx.control, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: ticket.result_slot, content } };
  const hook = run(mycelinkArgv(ctx.launcher, ['hook', 'controller-fence']), { cwd: ctx.control, input: JSON.stringify(event), env: cleanEnv() });
  if (hook.code !== 0) throw new QuickstartError(`the fence refused the scripted verdict: ${hook.stderr}`);
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, content);
  const settled = runLine(ticket.settle_command);
  const out = JSON.parse(settled.stdout);
  if (Object.keys(gaps).length > 0) {
    if (out.outcome !== 'GAPS') throw new QuickstartError(`review settle answered ${out.outcome}, not GAPS:\n${settled.stdout}${settled.stderr}`);
    for (const [criterion, gap] of Object.entries(gaps)) say('review', `${ticket.review_id}: GAP ${criterion}: ${gap.summary} (scripted, see walkthrough.mjs)`);
    say('rework', `${(out.reworked ?? []).join(', ')} reopened; no candidate is cut while a gap is open`);
  } else {
    if (out.outcome !== 'PASS') throw new QuickstartError(`review settle answered ${out.outcome}, not PASS:\n${settled.stdout}${settled.stderr}`);
    say('review', `${ticket.review_id}: PASS on every criterion`);
  }
}

// ---- the run ------------------------------------------------------------------

function walkthrough(opts) {
  const started = Date.now();
  const scratch = opts.out === null ? mkdtempSync(join(tmpdir(), 'mlqs-')) : null;
  const out = opts.out ?? join(scratch, 'ws');
  pace = opts.pace;
  try {
    const ws = createWorkspace({ out, launcher: opts.mycelink });
    ctx = { ...ws, key: null };
    say('', `Mycelink ${ws.cliVersion} quickstart walkthrough: feature ${FEATURE_ID} across two Git repositories.`);
    say('', 'Scripted worker and reviewer, no model: see examples/quickstart/walkthrough.mjs.');
    say('', '');
    for (const [name, dir] of Object.entries(ws.repos)) {
      const t = run([process.execPath, '--test', '--test-reporter=spec'], { cwd: dir });
      const pass = /^ℹ pass (\d+)/m.exec(t.stdout)?.[1];
      if (t.code !== 0) throw new QuickstartError(`${REPOS[name]} baseline tests failed`);
      say('setup', `${REPOS[name].padEnd(10)} own Git repository, main ${short(ws.baseline[name])}, ${pass} tests pass`);
    }
    const before = run([process.execPath, join(HERE, 'acceptance', 'probe.mjs'), ws.repos.api, ws.repos.web, '--json']);
    say('setup', `acceptance probe on the baselines: ${JSON.parse(before.stdout).passed}/4 criteria pass (feature not pre-solved)`);

    ctx.key = cliJson(['controller', 'open']).authority;
    cli(['feature', 'init', FEATURE_ID], { authority: true });
    commitControl(`${FEATURE_ID}: feature initialised`);
    say('plan', `${FEATURE_ID} graph valid: ${API_NODE} -> ${WEB_NODE} -> ${CANDIDATE_NODE}`);
    const ready = cli(['orchestrate', 'ready', FEATURE_ID]).stdout.trim();
    say('plan', `${ready.replace(/^scheduled: /, 'READY ')} (the web node waits for the contract's producer)`);

    let reviews = 0;
    for (let i = 0; i < 12; i++) {
      const d = cliJson(['dispatch', FEATURE_ID], { authority: true });
      for (const r of d.controller_reports ?? []) say('controller', `${r.node_id}: ${r.outcome}`);
      if (d.status === 'ALL_SETTLED') break;
      if (d.status !== 'DISPATCHED') throw new QuickstartError(`dispatch answered ${d.status}: ${d.detail}`);
      const t = d.ticket;
      if (t.kind === 'acceptance-review') {
        say('dispatch', `${t.review_id}: acceptance review handed to ${t.agent}`);
        review(t, reviews++);
        commitControl(`${t.review_id} settled`);
        continue;
      }
      say('dispatch', `${t.node_id} -> ${t.agent}, worktree ${relative(ctx.control, t.worktree).split('\\').join('/')} (${t.branch})`);
      fulfil(t);
      commitControl(`${t.node_id} settled`);
    }

    const st = state();
    if (st.feature_state !== 'VERIFIED') throw new QuickstartError(`feature state ${st.feature_state}, not VERIFIED`);
    const candidateId = st.current_candidate;
    const verified = cliJson(['candidate', 'verify', FEATURE_ID]);
    if (!verified.ok) throw new QuickstartError(`candidate verify: ${JSON.stringify(verified.problems)}`);
    const bound = Object.fromEntries(Object.keys(REPOS).map((name) => [name, git(ws.repos[name], ['rev-parse', `feature/${FEATURE_ID}`])]));
    say('candidate', `${candidateId}: immutable, binds ${Object.entries(bound).map(([n, s]) => `${n}@${short(s)}`).join(' ')} (candidate verify ok)`);
    commitControl(`${FEATURE_ID} settled`);

    const delivered = cliJson(['deliver', FEATURE_ID], { authority: true });
    commitControl(`${FEATURE_ID} delivered`);
    const mains = Object.fromEntries(Object.keys(REPOS).map((name) => [name, git(ws.repos[name], ['rev-parse', 'main'])]));
    for (const name of Object.keys(REPOS)) if (mains[name] !== bound[name]) throw new QuickstartError(`${name} main ${mains[name]} is not the candidate's ${bound[name]}`);
    say('deliver', `${delivered.status} ${delivered.candidate_id}: main fast-forwarded in both repositories, nothing pushed`);
    for (const name of Object.keys(REPOS)) say('deliver', `${REPOS[name].padEnd(10)} main ${mains[name]}`);
    const complete = cliJson(['feature', 'verify', FEATURE_ID, '--delivered']);
    if (!complete.ok) throw new QuickstartError(`feature verify --delivered: ${JSON.stringify(complete.problems)}`);

    const probeDir = join(ws.root, 'delivered');
    for (const name of Object.keys(REPOS)) git(ws.repos[name], ['worktree', 'add', '-q', '--detach', join(probeDir, name), mains[name]]);
    const after = JSON.parse(run([process.execPath, join(HERE, 'acceptance', 'probe.mjs'), join(probeDir, 'api'), join(probeDir, 'web'), '--json']).stdout);
    for (const name of Object.keys(REPOS)) git(ws.repos[name], ['worktree', 'remove', '--force', join(probeDir, name)]);
    if (after.passed !== 4) throw new QuickstartError(`acceptance probe on the delivered commits: ${JSON.stringify(after.results)}`);
    say('verify', `feature verify --delivered ok; acceptance probe on the delivered commits: ${after.passed}/4 criteria pass`);
    const reviewsDone = st.acceptance_review.reviews.map((r) => `${r.review_id} ${r.overall}`).join(', ');
    say('', '');
    say('', `Done: 2 repositories, ${reviewsDone}, 1 rework, candidate ${candidateId}, 0 model calls.`);
    process.stderr.write(`(walkthrough took ${((Date.now() - started) / 1000).toFixed(1)}s${opts.keep || scratch === null ? `; workspace kept at ${ws.root}` : ''})\n`);
    return 0;
  } finally {
    // Only the temporary directory this run made itself is ever removed; an --out directory is the user's.
    if (scratch !== null && !opts.keep) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function sampleMarkdown(output) {
  return [
    '# Sample output: scripted walkthrough',
    '',
    'Source: `node examples/quickstart/walkthrough.mjs`, run by `node examples/quickstart/walkthrough.mjs --write-sample`.',
    '',
    'This is **not** a model run. The Mycelink controller, Git and the gates are real; the module-worker and the',
    'acceptance reviewer are scripted (`examples/quickstart/scripted/`, `walkthrough.mjs`). The GAP on AC-4 comes from',
    'a fault planted in the scripted web worker\'s first implementation. Commit SHAs are reproducible: every commit has',
    'a fixed identity and date, so the same Mycelink version prints the same SHAs on every machine.',
    '',
    '```text',
    ...output,
    '```',
    '',
  ].join('\n');
}

const isMain = process.argv[1] !== undefined && join(process.argv[1]) === join(HERE, 'walkthrough.mjs');
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write('Usage: node examples/quickstart/walkthrough.mjs [--out <empty dir>] [--keep] [--pace <ms>] [--mycelink <bin/mycelink.mjs>] [--write-sample]\n');
    } else {
      process.exitCode = walkthrough(opts);
      if (opts.writeSample) {
        writeFileSync(SAMPLE, sampleMarkdown(lines));
        process.stderr.write(`wrote ${relative(process.cwd(), SAMPLE)}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`walkthrough: ${err instanceof QuickstartError ? err.message : err.stack ?? err}\n`);
    process.exitCode = 1;
  }
}
