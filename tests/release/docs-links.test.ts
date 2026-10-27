/**
 * Every link in the repository's Markdown resolves.
 *
 * The release ZIP checks its own shipped files (package.test.ts). This covers
 * what GitHub shows beside it: relative links and their #anchors, and links
 * into this repository written as absolute GitHub URLs (shipped files must
 * use those for anything the ZIP leaves out), which must name a path that
 * exists on the branch being tested, or an issue form that exists. Inline HTML
 * (an image's src and srcset, a link's href) is held to the same rules.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const REPO_PATH = /^https:\/\/github\.com\/nigunpark\/mycelink\/(?:blob|tree)\/main\/([^#?]+)/;
const ISSUE_FORM = /^https:\/\/github\.com\/nigunpark\/mycelink\/issues\/new\?template=([^&#]+)/;

/** Tracked and new Markdown files outside tests/ (the benchmark fixtures hold recorded third-party text). */
function markdownFiles(): string[] {
  const ls = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '*.md'], { cwd: ROOT, encoding: 'utf8' });
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
  return ls.stdout.split('\0').filter((f) => f !== '' && !f.startsWith('tests/') && existsSync(join(ROOT, f)));
}

const withoutCode = (text: string): string => text.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const m of readFileSync(join(ROOT, file), 'utf8').replace(/^```[\s\S]*?^```/gm, '').matchAll(/^#{1,6} (.+)$/gm)) {
    const slug = (m[1] as string).trim().toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    out.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return out;
}

/** Each link in `file` that does not resolve, as `file -> target`. */
function brokenLinks(file: string): string[] {
  const broken: string[] = [];
  const text = withoutCode(readFileSync(join(ROOT, file), 'utf8'));
  const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/\s(?:src|srcset|href)="([^"\s]+)"/g)].map((m) => m[1] as string);
  for (const target of targets) {
    const form = ISSUE_FORM.exec(target);
    const repoPath = REPO_PATH.exec(target);
    if (form) {
      if (!existsSync(join(ROOT, '.github', 'ISSUE_TEMPLATE', form[1] as string))) broken.push(`${file} -> ${target}`);
      continue;
    }
    if (repoPath) {
      if (!existsSync(join(ROOT, repoPath[1] as string))) broken.push(`${file} -> ${target}`);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [path, fragment] = target.split('#') as [string, string | undefined];
    const resolved = path === '' ? file : posix.normalize(posix.join(posix.dirname(file), path));
    if (!existsSync(join(ROOT, resolved))) broken.push(`${file} -> ${target}`);
    else if (fragment && resolved.endsWith('.md') && !anchors(resolved).has(fragment)) broken.push(`${file} -> ${target} (no such heading)`);
  }
  return broken;
}

describe('Markdown links', () => {
  const files = markdownFiles();

  it('cover the public documentation', () => {
    expect(files).toEqual(expect.arrayContaining(['README.md', 'CONTRIBUTING.md', 'docs/ROADMAP.md', 'examples/quickstart/README.md']));
  });

  it("check the README's inline HTML images", () => {
    const readme = withoutCode(readFileSync(join(ROOT, 'README.md'), 'utf8'));
    expect([...readme.matchAll(/\ssrc(?:set)?="([^"\s]+)"/g)].map((m) => REPO_PATH.exec(m[1] as string)?.[1])).toEqual([
      'docs/assets/social-preview.png',
      'docs/assets/quickstart-demo-static.png',
      'docs/assets/quickstart-demo.gif',
    ]);
  });

  it('all resolve: relative paths, their anchors, and this repository’s GitHub URLs', () => {
    expect(files.flatMap((f) => brokenLinks(f))).toEqual([]);
  });

  it('links the shipped Codex guide from the README and security documentation', () => {
    const guide = readFileSync(join(ROOT, 'docs/CODEX.md'), 'utf8');
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain('(docs/CODEX.md)');
    for (const name of ['ADAPTERS', 'PERMISSION_MODEL', 'THREAT_MODEL', 'DATA_HANDLING', 'RELEASING']) {
      expect(readFileSync(join(ROOT, `docs/${name}.md`), 'utf8'), name).toContain('(CODEX.md)');
    }
    for (const term of ['CODEX_RUNTIME_DENIED', '0.163.0', 'CODEX_HOME', 'AppContainer', 'hardlink', 'mcp_servers']) {
      expect(guide, term).toContain(term);
    }
    expect(readFileSync(join(ROOT, 'scripts/package.mjs'), 'utf8')).toContain("'docs/CODEX.md'");
  });
});
