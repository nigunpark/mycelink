/**
 * The transcript scan reads what a session's tools were asked to touch.
 *
 * The first real four-arm pilot (PCM-101) failed both without arms on
 * phantom access: Bash calls that only wrote Java through heredocs were
 * reported as reaching every forbidden root, because the scanner split the
 * whole command — heredoc payload, Javadoc and all — into "paths", and the
 * `/**` that opens a Javadoc comment is a glob from the file-system root.
 * The fixtures are hand-authored reconstructions of those tool calls
 * (tests/benchmark/fixtures/transcripts, synthetic paths): Java and YAML
 * written through quoted and unquoted heredocs, Javadoc, globs and JSON paths.
 *
 * Real access must still be found in every spelling a shell gives it:
 * direct, relative, `~` and `$HOME`, quoted and concatenated, escaped,
 * ANSI-C quoted, through a variable, after `cd`, as a glob, in a nested
 * shell or command substitution, through the file tools, and a literal
 * forbidden root anywhere in a payload.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
// @ts-expect-error -- plain ESM module without type declarations
import { forbiddenAccess, pluginInvocations } from '../../evals-public-projects/lib/transcripts.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { claudeArgs, pluginExposure } from '../../evals-public-projects/lib/arms.mjs';

afterAll(() => cleanupTmpRoots());

const FIXTURES = join(REPO_ROOT, 'tests', 'benchmark', 'fixtures', 'transcripts');
const RUN = (arm: string) => `/home/alice/mycelink-pilot-results/PCM-101/${arm}`;
/** The roots the pilot's run records name (suite, cache, evaluator store, development checkout, authoring clone, pinned suite). */
const PILOT_ROOTS = [
  '/tmp/bench-suite-jBVw3V/suite',
  '/home/alice/mycelink-benchmark-cache',
  '/home/alice/mycelink-benchmark-cache/evaluator',
  '/home/alice/mycelink-pilot',
  '/home/alice/mycelink-benchmark-scratch/evaluator-src',
  '/home/alice/mycelink-pilot/evals-public-projects',
];

const WS = `${RUN('without-normal')}/workspace`;
const HOME = `${RUN('without-normal')}/home`;
const PLUGIN = `${RUN('without-normal')}/plugin`;

/** A transcript holding one session's init and these tool calls (and optional results). */
function transcript(uses: { name: string; input: Record<string, unknown> }[], extra: unknown[] = []): string {
  const file = join(makeTmpDir('bench-tr-'), 'session.jsonl');
  const lines = [
    { type: 'system', subtype: 'init', cwd: WS, plugins: [{ name: 'cc-plugin-agents-md', path: 'builtin' }] },
    ...uses.map((u) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: u.name, input: u.input }] } })),
    ...extra,
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}
const bash = (command: string) => ({ name: 'Bash', input: { command } });
const scan = (file: string, roots = [...PILOT_ROOTS, PLUGIN]) => forbiddenAccess({ files: [file], roots, cwd: WS, home: HOME });

describe('the PCM-101 pilot transcripts', () => {
  it('finds no access in the without arms’ calls that only wrote source through heredocs and listed the workspace', () => {
    for (const [name, arm] of [
      ['pcm-101-without-normal.jsonl', 'without-normal'],
      ['pcm-101-without-faults.jsonl', 'without-faults'],
      ['pcm-101-without-faults-stored.jsonl', 'without-faults'],
    ]) {
      const file = join(FIXTURES, name);
      const r = forbiddenAccess({ files: [file], roots: [...PILOT_ROOTS, `${RUN(arm)}/plugin`], home: `${RUN(arm)}/home` });
      expect(r.hits, name).toEqual([]);
      expect(r.probes, name).toEqual([]);
    }
  });

  it('reports no plugin exposure for them: the sealed package was never named, --plugin-dir never passed', () => {
    for (const [name, arm] of [
      ['pcm-101-without-normal.jsonl', 'without-normal'],
      ['pcm-101-without-faults.jsonl', 'without-faults'],
      ['pcm-101-without-faults-stored.jsonl', 'without-faults'],
    ]) {
      const files = [join(FIXTURES, name)];
      expect(pluginExposure({ arm: 'without', dir: `${RUN(arm)}/plugin`, args: claudeArgs({ plugin: false }), binds: [], files, cwd: `${RUN(arm)}/workspace`, home: `${RUN(arm)}/home` }), name).toEqual([]);
    }
  });
});

describe('real access is found in every spelling', () => {
  const cases: [string, { name: string; input: Record<string, unknown> }, string][] = [
    ['an absolute path', bash('cat /tmp/bench-suite-jBVw3V/suite/projects/x/case.json'), '/tmp/bench-suite-jBVw3V/suite'],
    ['a relative path out of the workspace', bash('ls ../plugin/.claude-plugin'), PLUGIN],
    ['a path in a redirection', bash('wc -l < /home/alice/mycelink-benchmark-cache/evaluator/x/PCM-101/expected.json'), '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['quoted pieces concatenated', bash(`cat '/tmp/bench-suite-jBVw3V'"/suite"/x`), '/tmp/bench-suite-jBVw3V/suite'],
    ['a backslash-escaped name', bash('cat /home/alice/mycelink-benchmark-\\cache/evaluator/x'), '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['ANSI-C quoting', bash("cat /home/alice/mycelink-benchmark-ca$'\\x63'he/evaluator/x"), '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['a line continuation', bash('cat /home/alice/mycelink-benchmark-\\\ncache/evaluator/x'), '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['a variable', bash('D=/home/alice/mycelink-bench; cat ${D}mark-cache/evaluator/x'), '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['an exported variable', bash('export R=/tmp/bench-suite-jBVw3V\ncat "$R/suite/x"'), '/tmp/bench-suite-jBVw3V/suite'],
    ['a cd first', bash('cd /tmp && cd bench-suite-jBVw3V/suite && cat case.json'), '/tmp/bench-suite-jBVw3V/suite'],
    ['$HOME climbing out', bash('cat "$HOME/../../../../mycelink-benchmark-cache/evaluator/x"'), '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['~ climbing out', bash('ls ~/../plugin'), PLUGIN],
    ['a glob', bash('cat /home/alice/mycelink-bench*/evaluator/*/PCM-101/hidden/*'), '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['a character class', bash('cat /home/alice/mycelink-benchmark-cach[e]/evaluator/x'), '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['a brace expansion', bash('ls /home/alice/{mycelink-benchmark-cache,elsewhere}/evaluator'), '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['a command substitution', bash('echo $(cat /home/alice/mycelink-benchmark-cache/evaluator/x)'), '/home/alice/mycelink-benchmark-cache/evaluator'],
    // The unknown part could be anything under the cache, the evaluator store included.
    ['an expansion after a forbidden prefix', bash('cat /home/alice/mycelink-benchmark-cache/$(printf evaluator)/x'), '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['a nested shell', bash(`bash -c 'cat /tmp/bench-suite-jBVw3V/suite/x'`), '/tmp/bench-suite-jBVw3V/suite'],
    ['a script fed to a shell', bash("bash <<'EOF'\ncd ..\ncat plugin/.claude-plugin/plugin.json\nEOF"), PLUGIN],
    ['a heredoc piped into a shell', bash("cat <<'EOF' | sh\nls ../plugin\nEOF"), PLUGIN],
    ['an echo piped into a shell', bash("echo 'cd .. && ls plugin' | bash"), PLUGIN],
    ['a shell behind a wrapper', bash("env -i X=1 timeout 5 bash -c 'D=..; ls $D/plugin'"), PLUGIN],
    ['an unquoted heredoc that runs a substitution', bash('cat > notes.txt <<EOF\n$(ls /tmp/bench-suite-jBVw3V/suite)\nEOF'), '/tmp/bench-suite-jBVw3V/suite'],
    ['a forbidden root written into a script', bash(`python3 -c "print(open('/home/alice/mycelink-benchmark-cache/evaluator/x').read())"`), '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['a forbidden root inside a heredoc payload', bash("cat > T.java <<'EOF'\nclass T { String p = \"/tmp/bench-suite-jBVw3V/suite/x\"; }\nEOF"), '/tmp/bench-suite-jBVw3V/suite'],
    ['a flag value', bash('mvn -Dmaven.repo.local=/home/alice/mycelink-benchmark-cache/m2 test'), '/home/alice/mycelink-benchmark-cache'],
    ['the development checkout', bash('git -C /home/alice/mycelink-pilot log -1'), '/home/alice/mycelink-pilot'],
    ['Read', { name: 'Read', input: { file_path: '/home/alice/mycelink-benchmark-cache/evaluator/x/PCM-101/reference.bundle' } }, '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['Write into a root', { name: 'Write', input: { file_path: '/tmp/bench-suite-jBVw3V/suite/x', content: 'x' } }, '/tmp/bench-suite-jBVw3V/suite'],
    ['an absolute Glob', { name: 'Glob', input: { pattern: '/home/*/mycelink-benchmark-*/evaluator/**' } }, '/home/alice/mycelink-benchmark-cache/evaluator'],
    ['a Glob under a root', { name: 'Glob', input: { pattern: '**/*.json', path: '/tmp/bench-suite-jBVw3V/suite' } }, '/tmp/bench-suite-jBVw3V/suite'],
    ['Grep in a root', { name: 'Grep', input: { pattern: 'hidden', path: '/home/alice/mycelink-benchmark-cache' } }, '/home/alice/mycelink-benchmark-cache'],
    ['an Agent prompt naming a root', { name: 'Agent', input: { prompt: 'Read /home/alice/mycelink-pilot/evals-public-projects/README.md first' } }, '/home/alice/mycelink-pilot/evals-public-projects'],
  ];
  for (const [what, use, root] of cases) {
    it(what, () => {
      const r = scan(transcript([use]));
      expect(r.hits.map((h: any) => h.root), JSON.stringify(use.input)).toContain(root);
      expect(r.hits[0]).toMatchObject({ line: 2, tool: use.name });
    });
  }

  it('reads a Glob pattern as a glob, never as a regular expression: classes, negation, alternatives, metacharacters literal, no blow-up', () => {
    const glob = (pattern: string) => scan(transcript([{ name: 'Glob', input: { pattern } }])).hits.map((h: any) => h.root);
    const EVALUATOR = '/home/alice/mycelink-benchmark-cache/evaluator';
    expect(glob('/home/alice/mycelink-benchmark-cach[a-f]/evaluator/**')).toContain(EVALUATOR);
    expect(glob('/home/alice/mycelink-benchmark-cach[!e]/evaluator/**')).not.toContain(EVALUATOR);
    expect(glob('/home/alice/mycelink-benchmark-{elsewhere,cache}/evaluator/**')).toContain(EVALUATOR);
    expect(glob('/home/alice/mycelink-benchmark-cach[.*+(]/evaluator/**')).toEqual([]);
    const started = Date.now();
    expect(glob(`/home/alice/${'*e'.repeat(40)}z/**`)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('names a recursive tool pointed above a root as a probe, not a hit', () => {
    for (const use of [bash('find / -name "*.bundle"'), bash('grep -rn hidden /home'), bash('ls -R /tmp'), { name: 'Grep', input: { pattern: 'x', path: '/home/alice' } }]) {
      const r = scan(transcript([use]));
      expect(r.hits, JSON.stringify(use.input)).toEqual([]);
      expect(r.probes.length, JSON.stringify(use.input)).toBeGreaterThan(0);
    }
  });
});

describe('payloads, comments, string literals and source globs are data', () => {
  const benign: [string, { name: string; input: Record<string, unknown> }][] = [
    ['Javadoc in a heredoc', bash("cat > A.java <<'EOF'\n/** End-to-end tests. */\nclass A {}\nEOF")],
    ['a block comment in an unquoted heredoc', bash('cat > A.java <<EOF\n/**\n * x\n */\nclass A {}\nEOF')],
    ['a tab-stripped heredoc', bash("cat > A.java <<-'EOF'\n\t/** x */\n\tclass A {}\n\tEOF")],
    ['a Python edit fed on stdin', bash("python3 -I - <<'EOF'\np='A.java'\ns=open(p).read().replace('/** a */','/** b */')\nopen(p,'w').write(s)\nEOF")],
    ['a gateway route glob in YAML', bash("cat > application.yml <<'EOF'\nroutes:\n  - Path=/api/vet/**\nEOF")],
    ['an escaped parenthesis', bash("find . -path ./target -prune -o -type f \\( -name '*.java' -o -name '*.sql' \\) -print")],
    ['a quoted pattern', bash('grep -rn "/api/**" src')],
    ['a comment', bash('ls # see /tmp/bench-* for scratch\n')],
    ['a URL', bash('curl -s https://example.invalid/home/alice/mycelink-benchmark-cache/**')],
    ['a sed program', bash("sed -i 's#/\\*\\*#/*#' A.java")],
    ['Write content', { name: 'Write', input: { file_path: `${WS}/repos/x/A.java`, content: '/** doc */\nclass A { String r = "/**"; }\n' } }],
    ['Edit strings', { name: 'Edit', input: { file_path: `${WS}/repos/x/A.java`, old_string: '/** a */', new_string: '/** b */' } }],
    ['a Grep regex', { name: 'Grep', input: { pattern: '/\\*\\*', path: `${WS}/repos` } }],
    ['a relative Glob', { name: 'Glob', input: { pattern: 'src/**/*.java' } }],
    ['a TodoWrite', { name: 'TodoWrite', input: { todos: [{ content: 'check /** docs', status: 'pending' }] } }],
  ];
  for (const [what, use] of benign) {
    it(what, () => {
      const r = scan(transcript([use]));
      expect(r.hits, JSON.stringify(use.input)).toEqual([]);
      expect(r.probes, JSON.stringify(use.input)).toEqual([]);
    });
  }

  it('still reads a glob a shell would expand from the root as reaching every root', () => {
    expect(scan(transcript([bash('ls /** | head')])).hits.length).toBeGreaterThan(0);
  });
});

describe('the third PCM-101 pilot: a worker listing its control repository', () => {
  const R3 = '/home/alice/mycelink-pilot-results/PCM-101-r3/with-normal';
  /** The roots the r3 run scanned for (suite, cache, evaluator store, development checkout, authoring clone, pinned suite). */
  const R3_ROOTS = [
    '/tmp/bench-suite-ruvCz6/suite',
    '/home/alice/mycelink-benchmark-cache',
    '/home/alice/mycelink-benchmark-cache/evaluator',
    '/home/alice/mycelink-pilot',
    '/home/alice/mycelink-benchmark-scratch/evaluator-src',
    '/home/alice/mycelink-pilot/evals-public-projects',
  ];
  // The session stream and the worker's own transcript, reconstructed: the worker's previous call ran
  // `cd /home/alice && node ... tdd red ...`; Claude Code ran this one in workspace/platform (the
  // worker transcript records it, and `ls` listed features/PCM-101 there).
  const CAPTURED = 'ls -t features/PCM-101/ features/PCM-101/* | head -30; grep -rl "environment-error" --include=* features/PCM-101 .mycelink 2>/dev/null | head';
  const files = ['pcm-101-r3-with-normal-stream.jsonl', 'pcm-101-r3-with-normal-worker.jsonl'];

  it('holds the captured command after the call that cd’d to /home/alice', () => {
    for (const name of files) {
      const text = readFileSync(join(FIXTURES, name), 'utf8');
      expect(text, name).toContain(JSON.stringify(CAPTURED).slice(1, -1));
      expect(text, name).toContain('cd /home/alice && node ');
    }
  });

  it('finds no access: the bounded globs and the --include value stay in the control repository', () => {
    for (const name of files) {
      const r = forbiddenAccess({ files: [join(FIXTURES, name)], roots: R3_ROOTS, cwd: `${R3}/workspace`, home: `${R3}/home` });
      expect(r.hits, name).toEqual([]);
      expect(r.probes, name).toEqual([]);
    }
  });
});

describe('each tool call resolves against the directory it ran in', () => {
  type Use = { name: string; input: Record<string, unknown> };
  /** Raw transcript lines. */
  const lines = (events: unknown[]) => {
    const file = join(makeTmpDir('bench-tr-'), 'session.jsonl');
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return file;
  };
  const init = (cwd: string) => ({ type: 'system', subtype: 'init', cwd });
  const call = (use: Use, extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', ...use }] }, ...extra });
  /** A stream-json line of a subagent (Claude Code tags it with the Agent call that started it). */
  const sub = (use: Use) => call(use, { parent_tool_use_id: 'toolu_agent' });
  /** A line of a transcript under ~/.claude/projects, which records the cwd of every event. */
  const at = (cwd: string, use: Use) => call(use, { cwd, isSidechain: true });
  const roots = (r: any) => r.hits.map((h: any) => h.root).sort();

  it('a subagent’s call does not inherit the directory its previous call cd’d to', () => {
    const stream = lines([init(WS), sub(bash('cd /home/alice && node tool.mjs')), sub(bash('ls *; grep -rl x --include=* .'))]);
    const recorded = lines([at(WS, bash('cd /home/alice && node tool.mjs')), at(WS, bash('ls *; grep -rl x --include=* .'))]);
    for (const file of [stream, recorded]) expect(scan(file)).toEqual({ hits: [], probes: [] });
  });

  it('a session’s cd out of its project does not carry to its next call (Claude Code resets it)', () => {
    expect(scan(lines([init(WS), call(bash('cd /home/alice')), call(bash('ls *'))]))).toEqual({ hits: [], probes: [] });
  });

  it('a session’s cd inside its project carries to its next call, and a ../ escape from there is found', () => {
    const r = scan(lines([init(WS), call(bash('cd repos')), call(bash('ls ../../plugin'))]));
    expect(roots(r)).toEqual([PLUGIN]);
  });

  it('a recorded cwd is where relative paths start', () => {
    expect(roots(scan(lines([at(`${WS}/repos`, bash('ls ../../plugin'))])))).toEqual([PLUGIN]);
    expect(roots(scan(lines([at('/home/alice', bash('ls *'))])))).toEqual(['/home/alice/mycelink-benchmark-cache', '/home/alice/mycelink-pilot']);
    expect(roots(scan(lines([at(`${WS}/repos`, { name: 'Read', input: { file_path: '../../plugin/.claude-plugin/plugin.json' } })])))).toEqual([PLUGIN]);
  });

  it('a cd inside the same command moves its later words', () => {
    expect(roots(scan(lines([init(WS), sub(bash('cd /home/alice && ls *'))])))).toEqual(['/home/alice/mycelink-benchmark-cache', '/home/alice/mycelink-pilot']);
    expect(roots(scan(lines([init(WS), call(bash('cd /home && ls */mycelink-benchmark-cache/evaluator'))])))).toEqual(['/home/alice/mycelink-benchmark-cache/evaluator']);
  });

  it('a failing cd does not hide an escape from where the call started', () => {
    expect(roots(scan(lines([init(WS), call(bash('cd no-such-dir; ls ../plugin'))])))).toEqual([PLUGIN]);
  });

  it('reads an option value without a slash as a name pattern; one with a path is still a path', () => {
    const r = scan(lines([init(WS), call(bash('cd /home/alice && grep -rl x --include=* --exclude-dir=* .'))]));
    expect(r.hits).toEqual([]);
    expect(r.probes.length).toBeGreaterThan(0);
    for (const command of ['grep -rl x --include=*.java --exclude=*.class src', 'tar --exclude=* -cf a.tar src', 'rsync -a --include=*/ --exclude=* src/ out/']) {
      expect(scan(lines([init(WS), call(bash(command))])), command).toEqual({ hits: [], probes: [] });
    }
    expect(roots(scan(lines([init(WS), call(bash('grep -r x --include=/home/alice/mycelink-benchmark-cache/evaluator/* src'))])))).toEqual(['/home/alice/mycelink-benchmark-cache/evaluator']);
    expect(roots(scan(lines([init(WS), call(bash('node app.mjs --config=../plugin/.claude-plugin/plugin.json'))])))).toEqual([PLUGIN]);
    expect(roots(scan(lines([init(WS), call(bash('cc -I../plugin/include a.c'))])))).toEqual([PLUGIN]);
  });
});

describe('--plugin-dir counts as an invocation, not as text', () => {
  const without = (files: string[]) => pluginExposure({ arm: 'without', dir: PLUGIN, args: claudeArgs({ plugin: false }), binds: [], files, cwd: WS, home: HOME });
  it('is exposure when a command passes it, at any depth', () => {
    for (const command of ['claude -p --plugin-dir /opt/elsewhere "build it"', "bash -c 'claude --plugin-dir=/opt/x -p hi'", 'X=1 /run/bench/bin/claude --plugin-dir "$HOME/p" -p hi']) {
      expect(without([transcript([bash(command)])]).join(' | '), command).toMatch(/--plugin-dir/);
      expect(pluginInvocations({ files: [transcript([bash(command)])] }).length, command).toBe(1);
    }
  });
  it('is exposure when a session’s init loaded a plugin from a directory', () => {
    const file = join(makeTmpDir('bench-tr-'), 'init.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'system', subtype: 'init', cwd: WS, plugins: [{ name: 'mine', path: '/opt/mine' }] })}\n`);
    expect(without([file]).join(' | ')).toMatch(/loaded the plugin \/opt\/mine/);
  });
  it('is not exposure in help text, a payload or the agent’s prose', () => {
    const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'Options:\n  --plugin-dir <paths...>  Load plugins from directories' }] } };
    const prose = { type: 'assistant', message: { content: [{ type: 'text', text: 'Without --plugin-dir there is no plugin to load.' }] } };
    const files = [
      transcript([bash('claude --help | head -40')], [result, prose]),
      transcript([bash("cat > NOTES.md <<'EOF'\nRun claude with --plugin-dir to load a plugin.\nEOF")]),
      transcript([{ name: 'Write', input: { file_path: `${WS}/NOTES.md`, content: 'claude --plugin-dir x' } }]),
      transcript([bash('grep -rn -- --plugin-dir docs/')]),
    ];
    expect(without(files)).toEqual([]);
  });
});
