/**
 * What the repository publishes beside the release ZIP — documentation, eval
 * reports, the benchmark harness, the plugin and controller sources, and the
 * tests with their fixtures — names no developer's machine: no personal home
 * directory, no host name, no personal e-mail address and no secret-like
 * value, and it holds no recorded model session. The ZIP has its own scan
 * (`package.test.ts`).
 *
 * Tests hold synthetic values only: placeholder users' home directories
 * (`/home/alice`, `C:\Users\me`), dummy credentials in the tests that check
 * their redaction, and in the benchmark fixtures hand-authored transcripts
 * with synthetic session, agent and tool-use ids
 * (tests/benchmark/fixtures/README.md). The files inside a fixture archive
 * (scripts/fixture-archive.mjs) are scanned like tracked files, each named
 * `<archive>!/<path>`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
// @ts-expect-error -- plain ESM script without type declarations
import { verifyArchive } from '../../scripts/fixture-archive.mjs';

const ROOT = resolve(process.cwd());
const ARCHIVE = /^tests\/benchmark\/fixtures\/([a-z0-9-]+)\.tar$/;
/** The text of each archived file, by `<archive>!/<path>`. */
const archived = new Map<string, string>();

/** Every tracked file; in a fixture archive's place, its files, the archive verified against its manifest first. */
function tracked(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
  return ls.stdout
    .split('\0')
    .filter((f) => f !== '')
    .flatMap((f) => {
      const name = ARCHIVE.exec(f)?.[1];
      if (name === undefined) return [f];
      const { files } = verifyArchive(name, join(ROOT, 'tests', 'benchmark', 'fixtures')) as { files: { path: string; data: Buffer }[] };
      return files.map(({ path, data }) => {
        archived.set(`${f}!/${path}`, data.toString('utf8'));
        return `${f}!/${path}`;
      });
    });
}
const text = (file: string): string => archived.get(file) ?? readFileSync(join(ROOT, file), 'utf8');
/** Every match of `pattern` in each file, as `file: match`. */
const matches = (files: string[], pattern: RegExp, keep: (m: string, file: string) => boolean = () => true): string[] =>
  files.flatMap((file) => [...text(file).matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].map((m) => m[0]).filter((m) => keep(m, file)).map((m) => `${file}: ${m}`));

/** A home directory named after a person, not a placeholder, a CI runner or an eval sandbox. */
const PERSONAL_PATHS = [
  /\/home\/(?!<|\$|u\b|user\b|runner\b|cwd\b)[a-z_][a-z0-9_.-]*/,
  /(?<![A-Za-z:])\/Users\/(?!<|\$|someone\b|you\b|name\b)[A-Za-z][A-Za-z0-9._-]*/,
  /[A-Za-z]:[\\/]+Users[\\/]+(?!<|%|\$|someone\b|you\b|name\b|runner(?:admin)?\b)[A-Za-z0-9._-]+/i,
  /\/mnt\/[a-z]\/Users\/(?!<|\$)[A-Za-z0-9._-]+/,
  // Claude Code names its per-project directories after the project's path.
  /-home-(?!runner-|user-)[a-z0-9]+-|[A-Za-z]--Users-[A-Za-z0-9]+/,
];
/** In tests, the placeholder users a fixture's paths may name as well. */
const TEST_USERS = 'alice|bob|bench|operator|agent|u|user|runner|cwd';
const TEST_PERSONAL_PATHS = [
  new RegExp(`/home/(?!<|\\$|(?:${TEST_USERS})\\b)[a-z_][a-z0-9_.-]*`),
  /(?<![A-Za-z:])\/Users\/(?!<|\$|someone\b|you\b|name\b|u\b)[A-Za-z][A-Za-z0-9._-]*/,
  /[A-Za-z]:[\\/]+Users[\\/]+(?!<|%|\$|someone\b|you\b|name\b|u\b|me\b|alice\b|runner(?:admin)?\b)[A-Za-z0-9._-]+/i,
  /\/mnt\/[a-z]\/Users\/(?!<|\$)[A-Za-z0-9._-]+/,
  new RegExp(`-home-(?!(?:${TEST_USERS})-)[a-z0-9]+-|[A-Za-z]--Users-(?!Alice\\b)[A-Za-z0-9]+`),
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NOT_PERSONAL_EMAIL = /@(?:[A-Za-z0-9-]+\.)*(?:invalid|example\.(?:com|org|net))$|@users\.noreply\.github\.com$|^git@/i;
// Third-party license texts carry their authors' addresses.
const THIRD_PARTY_TEXT = new Set(['THIRD_PARTY_NOTICES.md', 'dist/mycelink.mjs']);
// A PEM block's line breaks are newlines in a file and `\n` escapes in a test's string literal.
const SECRET = /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-ant-[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?:\\n|\n)[^\n\\-]*(?:\\n|\n)-----END)?|\bxox[baprs]-[A-Za-z0-9-]{10,}/;
/** A credential a test made up to be caught: it says so, counts, repeats a letter, or is a PEM block with no key in it. */
const DUMMY_SECRET = /secret|example|dummy|fake|0123456789|1234567890|abcdefghij|(.)\1{7}|-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|\n)[A-Za-z0-9+/=]{0,8}(?:\\n|\n)-----END/i;
/** Identifiers the Anthropic API and Claude Code mint for a real request, message, tool use or session. */
const API_IDS = /\b(?:req|msg)_01[A-Za-z0-9]{20,}\b|\b(?:srv)?toolu_01[A-Za-z0-9]{20,}\b/;
const SYNTHETIC_SESSION = /^00000000-0000-4000-8000-[0-9a-f]{12}$/;
const SYNTHETIC_AGENT = /^a0{9}[0-9a-f]{7}$/;
/** What a host's environment says of itself: kernel, OS and build-host lines. */
const MACHINE = /microsoft-standard|\bLinux \d+\.\d+\.\d+[.-]|OS Version:|git\.build\.host with value (?!evalhost\b)\S+/i;
/** A run's capability or controller key written out: anything but one character repeated is a real one. */
const KEY_VALUE = /(?:--(?:capability|authority)[ =]|\bK=)([0-9a-f]{64})\b/g;
/** Fields only a recorded Claude Code session carries: thinking signatures, usage and cost, its own ids and environment. */
const RECORDING_KEYS = new Set(['signature', 'usage', 'modelUsage', 'total_cost_usd', 'costUSD', 'totalCostUSD', 'uuid', 'parentUuid', 'leafUuid', 'promptId', 'userType', 'entrypoint', 'gitBranch', 'version', 'claude_code_version', 'attachment', 'rendered', 'sessionId', 'session_id', 'apiKeySource', 'memory_paths', 'slash_commands', 'mcp_servers', 'permission_denials', 'subagent_stats', 'inference_geo', 'service_tier']);

describe('tracked files outside tests/', () => {
  const files = tracked().filter((f) => !f.startsWith('tests/'));

  it('include the documentation and eval reports the scan is for', () => {
    expect(files).toEqual(expect.arrayContaining(['README.md', 'docs/THREAT_MODEL.md', 'docs/evals/2026-10-12-public-project-final-matrix.md']));
  });

  it('name no personal home directory', () => {
    expect(PERSONAL_PATHS.flatMap((p) => matches(files, p))).toEqual([]);
  });

  it('carry no personal e-mail address', () => {
    expect(matches(files.filter((f) => !THIRD_PARTY_TEXT.has(f)), EMAIL, (e) => !NOT_PERSONAL_EMAIL.test(e))).toEqual([]);
  });

  it('carry no secret-like value', () => {
    expect(files.filter((file) => SECRET.test(text(file)))).toEqual([]);
  });
});

describe('every tracked file, the tests and their fixtures included', () => {
  const files = tracked().filter((f) => !/\.(?:png|zip|exe)$/.test(f));
  const tests = files.filter((f) => f.startsWith('tests/'));
  const fixtures = tests.filter((f) => f.startsWith('tests/benchmark/fixtures/'));

  it('include the benchmark fixtures the scan is for', () => {
    expect(fixtures).toEqual(expect.arrayContaining(['tests/benchmark/fixtures/README.md', 'tests/benchmark/fixtures/transcripts/cset-202-r2-with-normal-task.jsonl', 'tests/benchmark/fixtures/pcm101-final.tar!/features/PCM-101/STATE.json']));
    // An archive is scanned through its files, never as one opaque blob.
    expect(fixtures.filter((f) => f.startsWith('tests/benchmark/fixtures/cset201-final.tar!/')).length).toBeGreaterThan(0);
    expect(fixtures.filter((f) => f.endsWith('.tar'))).toEqual([]);
  });

  it('name no personal home directory: only placeholder users', () => {
    expect(TEST_PERSONAL_PATHS.flatMap((p) => matches(tests, p))).toEqual([]);
  });

  it('carry no personal e-mail address', () => {
    expect(matches(tests, EMAIL, (e) => !NOT_PERSONAL_EMAIL.test(e))).toEqual([]);
  });

  it('carry a secret-like value only as a test’s made-up credential', () => {
    expect(matches(files.filter((f) => !f.startsWith('tests/')), SECRET)).toEqual([]);
    expect(matches(tests, SECRET, (m) => !DUMMY_SECRET.test(m))).toEqual([]);
  });

  it('hold no real run capability or controller key', () => {
    expect(matches(files, KEY_VALUE, (m) => new Set(m.slice(-64)).size > 1)).toEqual([]);
  });

  it('name no request, message, tool-use or session id of a real model session', () => {
    expect(matches(files, API_IDS)).toEqual([]);
    const offenders: string[] = [];
    const walk = (file: string, v: unknown, key: string | null): void => {
      if (Array.isArray(v)) v.forEach((x) => walk(file, x, key));
      else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(file, x, k);
      else if (typeof v === 'string') {
        if ((key === 'session_id' || key === 'sessionId') && !SYNTHETIC_SESSION.test(v)) offenders.push(`${file}: ${key} ${v}`);
        if ((key === 'agent_id' || key === 'agentId') && !SYNTHETIC_AGENT.test(v)) offenders.push(`${file}: ${key} ${v}`);
        for (const m of v.matchAll(/\/projects\/[^/]+\/([0-9a-f-]{36})(?:\.jsonl|\/)/g)) if (!SYNTHETIC_SESSION.test(m[1]!)) offenders.push(`${file}: session ${m[1]}`);
        for (const m of v.matchAll(/\bagent-(a[0-9a-f]{16})\b/g)) if (!SYNTHETIC_AGENT.test(m[1]!)) offenders.push(`${file}: agent ${m[1]}`);
      }
    };
    for (const file of fixtures.filter((f) => /\.jsonl?$/.test(f))) {
      for (const line of file.endsWith('.jsonl') ? text(file).split('\n').filter((l) => l.trim() !== '') : [text(file)]) walk(file, JSON.parse(line), null);
    }
    expect(offenders).toEqual([]);
  });

  it('hold no recorded model session: transcripts are hand-authored, with none of a recording’s own fields', () => {
    const offenders: string[] = [];
    const walk = (file: string, v: unknown): void => {
      if (Array.isArray(v)) v.forEach((x) => walk(file, x));
      else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (RECORDING_KEYS.has(k)) offenders.push(`${file}: ${k}`);
          if (k === 'type' && (x === 'thinking' || x === 'redacted_thinking')) offenders.push(`${file}: a ${x} block`);
          walk(file, x);
        }
      } else if (typeof v === 'string' && v.includes('<system-reminder>')) offenders.push(`${file}: a system reminder`);
    };
    const transcripts = files.filter((f) => f.endsWith('.jsonl'));
    expect(transcripts.length).toBeGreaterThan(0);
    for (const file of transcripts) for (const line of text(file).split('\n').filter((l) => l.trim() !== '')) walk(file, JSON.parse(line));
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('describe no evaluation host: no kernel, OS or build-host line', () => {
    expect(matches(files.filter((f) => f !== 'tests/release/repository-hygiene.test.ts'), MACHINE)).toEqual([]);
  });
});
