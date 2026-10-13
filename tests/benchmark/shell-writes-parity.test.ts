/**
 * The plugin's fence and the benchmark's monitor read a Bash call alike.
 *
 * Core refuses a controller's write before it runs (src/hooks/fence.ts,
 * src/security/shell-writes.ts); the benchmark, independently, stops a
 * with-arm controller at the first write it finds in the session's stream
 * (lib/transcripts.mjs editScanner). Each reads the shell the way the shell
 * does (lib/shell.mjs, src/security/shell.ts), and both must reach the same
 * verdict on every spelling an agent used or could use: cd, git -C,
 * redirections, heredocs, sed/perl -i, tee, cp, mv, rm, python, node, a
 * script written and run, a worker's gate — and on every read, build, test,
 * control-repository commit and Mycelink CLI call, which are not writes.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM module without type declarations
import { controllerEdits } from '../../evals-public-projects/lib/transcripts.mjs';
import { shellWrites } from '../../src/security/shell-writes.js';

const WS = '/run/ws';
const CONTROL = `${WS}/platform`;
const REPO = `${WS}/repos/x`;
const WT = `${CONTROL}/.mycelink/worktrees/x__F-1.x.impl`;
const SLOT = `${WT}/.mycelink-worker/result-00000000-0000-4000-8000-0000000202a4.json`;
const EVIDENCE = `${CONTROL}/features/F-1/evidence`;
const ACCEPTANCE = `${CONTROL}/features/F-1/ACCEPTANCE.json`;
const ROOTS = [REPO, WT, EVIDENCE, ACCEPTANCE];
const M = 'node /opt/plugin/bin/mycelink.mjs';

const inside = (p: string, root: string) => p === root || p.startsWith(`${root}/`);

/** Core's verdict: does the call write (or run a worker's gate) under a root — or somewhere it cannot name? */
function core(command: string): boolean {
  const r = shellWrites(command, { cwd: WS, home: '/home/agent' });
  return r.gates.length > 0 || r.writes.some((w) => w.unknown === true || ROOTS.some((root) => inside(w.path, root)));
}

/** The benchmark's verdict, from a stream with this one top-level call. */
function bench(command: string): boolean {
  const text = [JSON.stringify({ type: 'system', subtype: 'init', cwd: WS }), JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] } })].join('\n') + '\n';
  return controllerEdits({ text, roots: ROOTS, cwd: WS }).length > 0;
}

/** CSET-203 r9's line 38, as the controller sent it: a graph generator that reads the approved criteria, then the PRD by heredoc. */
const R9_GEN = [
  `cd ${CONTROL}; cat > /tmp/gen/gen.py <<'EOF'`,
  'import json,yaml',
  "acc=json.load(open('features/F-1/ACCEPTANCE.json'))['criteria']",
  "mods={m['id']:m for m in json.load(open('/tmp/gen/mods.json'))['repositories'][0]['modules']}",
  "F='F-1'",
  "nodes=[dict(id=f'{F}.x.impl',allowed_paths=['packages/x/**'],forbidden_paths=['**/node_modules/**','**/dist/**'])]",
  "g=dict(feature_id=F,acceptance_criteria=[dict(id=a['id'],text=a['text']) for a in acc],nodes=nodes)",
  "yaml.safe_dump(g,open('features/F-1/PORTFOLIO-GRAPH.yaml','w'),sort_keys=False)",
  'EOF',
  'python3 -I /tmp/gen/gen.py',
  "cat > features/F-1/PRD.md <<'EOF'",
  '# PRD',
  'EOF',
].join('\n');

const WRITES: [string, string][] = [
  ['sed -i on a result slot (r2, read)', `cd ${CONTROL}; F=.mycelink/worktrees/x__F-1.x.impl/.mycelink-worker/result-00000000-0000-4000-8000-0000000202a4.json; sed -i 's/invalid changesets > collects/collects/' $F && grep -o '"name":"[^"]*"' $F`],
  ['cat > a result slot through a heredoc (r2, cli)', `cd ${CONTROL}; F=.mycelink/worktrees/x__F-1.x.impl/.mycelink-worker/result-00000000-0000-4000-8000-0000000202a4.json; ls $(dirname $F); cat > $F <<'EOF'\n{"schema_version":1}\nEOF\n${M} settle F-1 F-1.x.impl --capability ${'a'.repeat(64)} --json`],
  ['a redirection after cd', `cd ${WT} && echo 'export const x = 1;' > src/x.mjs`],
  ['git add and commit after cd', `cd ${WT} && git add -A && git commit -qm wip`],
  ['git -C commit', `git -C ${WT} commit -qm wip`],
  ['git -C on the product repository', `git -C ${REPO} cherry-pick abc123`],
  ['tee', `printf x | tee ${WT}/src/y.mjs`],
  ['cp', `cp /tmp/a.mjs ${WT}/src/index.mjs`],
  ['mv', `mv ${WT}/src/a.mjs ${WT}/src/b.mjs`],
  ['rm', `rm -f ${SLOT}`],
  ['touch', `touch ${REPO}/src/new.java`],
  ['perl -pi', `perl -pi -e 's/a/b/' ${WT}/src/index.mjs`],
  ['truncate', `truncate -s 0 ${EVIDENCE}/F-1.x.impl/F-1.x.impl.red.log`],
  ['find -delete', `find ${WT}/src -name '*.bak' -delete`],
  ['python -c writing a file', `python3 -c "open('${WT}/src/z.mjs', 'w').write('x')"`],
  ['python fed a script through a heredoc', `cd ${WT} && python3 - <<'PY'\nfrom pathlib import Path\nPath('src/w.mjs').write_text('x')\nPY`],
  ['node -e writing a result slot', `node -e "require('fs').writeFileSync('${SLOT}', '{}')"`],
  ['a script written by a heredoc, then run', `cat > /tmp/fix.mjs <<'EOF'\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('${SLOT}', '{}');\nEOF\nnode /tmp/fix.mjs`],
  ['a target only a substitution names, from inside a worktree', `cd ${WT} && sed -i 's/a/b/' "$(ls src/*.mjs | head -1)"`],
  ["a worker's gate", `${M} tdd green F-1 F-1.x.impl --control-root ${CONTROL} --capability ${'b'.repeat(64)}`],
  ['python writing the approved criteria by a literal path', `cd ${CONTROL} && python3 -c "import json; json.dump({}, open('features/F-1/ACCEPTANCE.json', 'w'))"`],
  ['python writing through a path it computes (where cannot be told)', `cd ${CONTROL} && python3 -c "import os; p=os.path.join('features', 'F-1', 'ACCEPT' + 'ANCE.json'); open(p, 'w').write('{}')"`],
  ['node writing through a path it computes', `node -e "const p = process.argv[1]; require('fs').writeFileSync(p, '{}')" ${SLOT}`],
  ['pathlib writing by a literal path', `python3 - <<'PY'\nfrom pathlib import Path\nPath('${ACCEPTANCE}').write_text('{}')\nPY`],
  ['shutil copying over the criteria', `python3 -c "import shutil; shutil.copy('/tmp/a.json', '${ACCEPTANCE}')"`],
  ['os.replace onto the criteria', `python3 -c "import os; os.replace('/tmp/a.json', '${ACCEPTANCE}')"`],
  ['node renaming onto a result slot', `node -e "require('fs').renameSync('/tmp/r.json', '${SLOT}')"`],
  ['a shell script it wrote, run with bash', `cat > /tmp/fix.sh <<'EOF'\necho x > ${WT}/src/a.mjs\nEOF\nbash /tmp/fix.sh`],
  ['a shell script it wrote, sourced', `cat > /tmp/fix.sh <<'EOF'\nrm -f ${SLOT}\nEOF\n. /tmp/fix.sh`],
  ['nohup in the background', `nohup python3 -c "open('${SLOT}', 'w').write('{}')" > /dev/null 2>&1 &`],
  ['a script on disk it cannot read, run by an interpreter', `python3 /tmp/missing-helper-${process.pid}.py`],
];

const READS: [string, string][] = [
  ['cat and grep', `cat ${WT}/src/index.mjs; grep -rn "describe(" ${WT}/src; grep -o '"name":"[^"]*"' ${SLOT}`],
  ['sed -n', `sed -n 1,20p ${WT}/src/index.mjs`],
  ['git log, diff and status', `git -C ${WT} log --oneline | head -3; cd ${WT} && git diff HEAD~1 --stat && git status --short`],
  ['tests in a worktree', `cd ${WT} && pnpm vitest run src/ 2>&1 | tail -20`],
  ['python reading a file', `python3 -c "print(open('${WT}/src/index.mjs').read())"`],
  ['node reading a file', `node -e "console.log(require('fs').readFileSync('${SLOT}', 'utf8'))"`],
  ['the controller CLI', `cd ${CONTROL}; ${M} dispatch F-1 --json --authority k > /tmp/t.json; ${M} settle F-1 F-1.x.impl --capability ${'a'.repeat(64)} --json`],
  ["a bound test's id", `${M} tdd tests F-1 F-1.x.impl --control-root ${CONTROL} --capability ${'b'.repeat(64)} --match status`],
  ['a commit of the control repository', `cd ${CONTROL} && git add -A && git commit -qm "F-1 plan"`],
  ['a script that only reads, written and run', `cat > /tmp/gen.mjs <<'EOF'\nconsole.log(1);\nEOF\nnode /tmp/gen.mjs`],
  ['a target only a substitution names, from the control repository', `cd ${CONTROL} && echo x > "$(mktemp)"`],
  ['a temporary file', `echo hi > /tmp/notes.txt; sed -i 's/hi/ho/' /tmp/notes.txt`],
  ["CSET-203 r9's graph generator: it reads the approved criteria and writes the graph and the PRD", R9_GEN],
  ["CSET-203 r6's node graph generator: readFileSync of the criteria, writeFileSync of the graph", `cd ${CONTROL} && cat > /tmp/mkgraph.mjs <<'EOF'\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst acc = JSON.parse(readFileSync('features/F-1/ACCEPTANCE.json', 'utf8'));\nwriteFileSync('features/F-1/PORTFOLIO-GRAPH.yaml', JSON.stringify({ acceptance_criteria: acc.criteria }));\nEOF\nnode /tmp/mkgraph.mjs`],
  ['python with open() of the criteria for reading, mode given', `python3 -c "import json; print(json.load(open('${ACCEPTANCE}', 'r')))"`],
  ['a string replace is no file write', `python3 -c "s = open('${ACCEPTANCE}').read(); print(s.replace('a', 'b'))"`],
  ['a shell script it wrote, run with bash, that only reads', `cat > /tmp/look.sh <<'EOF'\ncat ${ACCEPTANCE}\nEOF\nbash /tmp/look.sh`],
];

describe('core and the benchmark agree on what a Bash call writes', () => {
  it.each(WRITES)('a write: %s', (_label, command) => {
    expect(core(command), 'core').toBe(true);
    expect(bench(command), 'bench').toBe(true);
  });

  it.each(READS)('not a write: %s', (_label, command) => {
    expect(core(command), 'core').toBe(false);
    expect(bench(command), 'bench').toBe(false);
  });
});
