/**
 * Installing from GitHub checks this repository out on the user's machine,
 * and on Windows it must do so without Git's `core.longpaths`.
 *
 * v0.3.0-beta.1 could not be installed this way on Windows.
 * `claude plugin marketplace add nigunpark/mycelink` cloned the repository,
 * and the checkout failed with `Filename too long` on a 181-character fixture
 * path. The two deep fixture trees are archives now
 * (scripts/fixture-archive.mjs).
 *
 * Where Claude Code checks a marketplace out (2.1.288 to 2.1.290, from its
 * code and a traced clone): into a staging directory beside the final one,
 * `<CLAUDE_CONFIG_DIR>\plugins\marketplaces\<name>..clone`, renamed into
 * place once the clone succeeds. It runs
 * `git clone --depth 1 --recurse-submodules --shallow-submodules -- <url> <dir>`.
 * The name is `nigunpark-mycelink` for `owner/repo`, `mycelink-marketplace`
 * when it refreshes the added marketplace, and `temp_git_<ms>_<6 chars>` for
 * a git URL. That last one is the longest: 36 characters with `..clone`
 * (`Date.now()` has 13 digits until 2286). Installing the plugin then copies
 * it into `plugins\cache\...` without Git; that copy takes long paths.
 *
 * What Windows takes: Git for Windows, with `core.longpaths` false (its
 * default), refuses a file whose absolute path is 260 characters or more
 * (MAX_PATH: 259 and the NUL). It refuses a directory at 248 or more,
 * because CreateDirectory keeps 12 characters for an 8.3 name.
 *
 * The budget allows a CLAUDE_CONFIG_DIR of up to 80 characters. That is more
 * than twice the default `C:\Users\<20-character name>\.claude` (37). The
 * staging directory is then at most 80 + 22 (`\plugins\marketplaces\`) + 36
 * = 138 characters, and a repository path follows one more separator. So
 * every tracked file must stay within 259 - 139 = 120 characters, and every
 * tracked directory within 247 - 139 = 108.
 */
import { describe, expect, it, type TestContext } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());

/** Git for Windows' limits with `core.longpaths` false: the longest absolute file and directory paths, NUL excluded. */
const WINDOWS_FILE_MAX = 259;
const WINDOWS_DIR_MAX = 247;
/** The longest CLAUDE_CONFIG_DIR an install from GitHub is kept working for. */
const CONFIG_DIR_MAX = 80;
const MARKETPLACES = '\\plugins\\marketplaces\\';
/** Claude Code's staging directories for this marketplace, by how it was added. */
const STAGING = {
  'owner/repo': 'nigunpark-mycelink..clone',
  refresh: 'mycelink-marketplace..clone',
  'git URL': `temp_git_${'0'.repeat(13)}_${'0'.repeat(6)}..clone`,
};
const LONGEST_STAGING = Math.max(...Object.values(STAGING).map((s) => s.length));
/** What comes before a repository path in the longest checkout: the config dir, `\plugins\marketplaces\`, the staging name, a separator. */
const PREFIX = CONFIG_DIR_MAX + MARKETPLACES.length + LONGEST_STAGING + 1;
const FILE_BUDGET = WINDOWS_FILE_MAX - PREFIX;
const DIR_BUDGET = WINDOWS_DIR_MAX - PREFIX;

function tracked(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
  return ls.stdout.split('\0').filter((f) => f !== '');
}

/** Every directory a checkout of `files` creates. */
const directoriesOf = (files: string[]): string[] => [...new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))].sort();

const WHY = [
  `Claude Code checks this repository out under <CLAUDE_CONFIG_DIR>${MARKETPLACES}<staging>\\, a staging name of up to ${LONGEST_STAGING} characters (${Object.values(STAGING).join(', ')}).`,
  `With core.longpaths false, Git for Windows refuses a file path of ${WINDOWS_FILE_MAX + 1}+ characters and a directory of ${WINDOWS_DIR_MAX + 1}+.`,
  `For a CLAUDE_CONFIG_DIR of up to ${CONFIG_DIR_MAX} characters, a tracked file must stay within ${FILE_BUDGET} characters and a directory within ${DIR_BUDGET}.`,
  'Shorten the paths below, or keep a deep recorded tree as a fixture archive (scripts/fixture-archive.mjs).',
].join('\n');

/** Git with no system or global configuration: what a fresh Windows install defaults to, whatever this machine has set. */
function gitEnv(home: string): NodeJS.ProcessEnv {
  const global = join(home, 'gitconfig');
  writeFileSync(global, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: global, GIT_TERMINAL_PROMPT: '0' };
}

interface Scratch {
  /** A fresh repository holding `paths` (empty files), committed. */
  repo(paths: string[]): string;
  /** Claude Code's clone of `source` into a fresh git-URL staging directory under the CLAUDE_CONFIG_DIR. */
  clone(source: string): { dest: string; status: number | null; stderr: string };
}

/**
 * A CLAUDE_CONFIG_DIR of exactly CONFIG_DIR_MAX characters in the temp directory (its long form: Git resolves an
 * 8.3 alias such as RUNNER~1 to it), or a skip when the temp directory itself is too long for one.
 */
function scratch(ctx: TestContext): Scratch & { configDir: string } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mlp-')));
  ctx.onTestFinished(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const pad = CONFIG_DIR_MAX - base.length - 1;
  if (pad < 1) ctx.skip(`the temp directory ${base} leaves no room for a ${CONFIG_DIR_MAX}-character CLAUDE_CONFIG_DIR`);
  const configDir = join(base, 'c'.repeat(pad));
  expect(configDir.length).toBe(CONFIG_DIR_MAX);
  const env = gitEnv(base);
  const run = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  let repos = 0;
  let clones = 0;
  return {
    configDir,
    repo(paths) {
      const dir = join(base, `s${repos++}`);
      for (const p of paths) {
        const file = join(dir, ...p.split('/'));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, '');
      }
      run(dir, ['init', '-q', '-b', 'main']);
      run(dir, ['add', '-A', '-f']);
      run(dir, ['-c', 'user.name=Mycelink Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'paths']);
      return dir;
    },
    clone(source) {
      // Claude Code's staging name for a git URL: temp_git_<Date.now()>_<6 characters>..clone.
      const dest = join(configDir, 'plugins', 'marketplaces', `temp_git_${Date.now()}_${String(clones++).padStart(6, '0')}..clone`);
      expect(dest.length).toBe(PREFIX - 1);
      mkdirSync(dirname(dest), { recursive: true });
      // Claude Code clones over a transport, never a local copy; Git for Windows takes `file://C:/...` (not `file:///C:/...`).
      const url = `file://${source.split('\\').join('/')}`;
      const args = ['-c', 'core.longpaths=false', 'clone', '--depth', '1', '--recurse-submodules', '--shallow-submodules', '--', url, dest];
      const r = spawnSync('git', args, { env, encoding: 'utf8', windowsHide: true });
      return { dest, status: r.status, stderr: r.stderr };
    },
  };
}

describe('a Windows checkout of this repository from a marketplace, without core.longpaths', () => {
  const files = tracked();

  it(`keeps every tracked file within ${FILE_BUDGET} characters and every directory within ${DIR_BUDGET}`, () => {
    expect(PREFIX).toBe(139);
    const long = files.filter((f) => f.length > FILE_BUDGET).map((f) => `${f.length} ${f}`);
    const deep = directoriesOf(files)
      .filter((d) => d.length > DIR_BUDGET)
      .map((d) => `${d.length} ${d}/`);
    expect([...long, ...deep], WHY).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(`checks every tracked path out with Git into the longest staging directory, under a CLAUDE_CONFIG_DIR of ${CONFIG_DIR_MAX} characters`, (ctx) => {
    const t = scratch(ctx);
    const { dest, status, stderr } = t.clone(t.repo(files));
    expect({ status, stderr }, WHY).toEqual({ status: 0, stderr: expect.not.stringMatching(/Filename too long/) });
    expect(files.filter((f) => !existsSync(join(dest, ...f.split('/'))))).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('is the limit Git applies: a file or a directory at the budget checks out, one character longer is refused', (ctx) => {
    const t = scratch(ctx);
    const fileOf = (n: number) => `f/${'a'.repeat(n - 2)}`;
    const dirOf = (n: number) => `${'d'.repeat(n)}/x`;
    expect(fileOf(FILE_BUDGET).length).toBe(FILE_BUDGET);
    for (const [path, fits] of [
      [fileOf(FILE_BUDGET), true],
      [fileOf(FILE_BUDGET + 1), false],
      [dirOf(DIR_BUDGET), true],
      [dirOf(DIR_BUDGET + 1), false],
    ] as const) {
      const { dest, status, stderr } = t.clone(t.repo([path]));
      if (fits) {
        expect(status, `${path.length}-character ${path}: ${stderr}`).toBe(0);
        expect(existsSync(join(dest, ...path.split('/'))), path).toBe(true);
      } else {
        // If this Git checked it out, core.longpaths=false no longer bounds a checkout here, and the budget needs deriving again.
        expect(status, `${path.length}-character ${path} was checked out`).not.toBe(0);
        expect(stderr).toMatch(/Filename too long/);
      }
    }
  });
});
