/**
 * Public identity, licensing and documentation are consistent.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
/** Prose with line wraps, blockquote markers and emphasis collapsed. */
const prose = (rel: string): string =>
  read(rel).replace(/^>\s?/gm, '').replace(/\*\*/g, '').replace(/\s+/g, ' ');
const json = <T = Record<string, unknown>>(rel: string): T => JSON.parse(read(rel)) as T;

const REPO_URL = 'https://github.com/nigunpark/mycelink';
const pkg = json<{ name: string; version: string; license: string; private: boolean; author: string; engines: { node: string } }>('package.json');
const lock = json<{ version: string; packages: Record<string, { version?: string; license?: string }> }>('package-lock.json');
const plugin = json<Record<string, unknown>>('.claude-plugin/plugin.json');
const market = json<{ name: string; owner: { name: string }; metadata: { version: string }; plugins: Record<string, unknown>[] }>(
  '.claude-plugin/marketplace.json',
);

describe('identity and version', () => {
  it('uses the permanent names', () => {
    expect(pkg.name).toBe('mycelink');
    expect(plugin['name']).toBe('mycelink');
    expect(plugin['displayName']).toBe('Mycelink');
    expect(market.name).toBe('mycelink-marketplace');
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0]?.['name']).toBe(plugin['name']);
    expect(market.plugins[0]?.['source']).toBe('./');
  });

  it('agrees on one version everywhere', () => {
    expect(pkg.version).toBe('0.2.0-beta.1');
    for (const v of [lock.version, lock.packages['']?.version, plugin['version'], market.metadata.version, market.plugins[0]?.['version']]) {
      expect(v).toBe(pkg.version);
    }
  });

  it('is GitHub-distributed, not npm-published, on supported Node versions', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.engines.node).toBe('^22.12.0 || ^24.0.0');
  });

  it('credits Mycelink Contributors and points at the real GitHub repository', () => {
    expect(pkg.author).toBe('Mycelink Contributors');
    expect((plugin['author'] as { name: string }).name).toBe('Mycelink Contributors');
    expect(market.owner.name).toBe('Mycelink Contributors');
    const raw = pkg as Record<string, unknown>;
    expect(raw['homepage']).toBe(`${REPO_URL}#readme`);
    expect(raw['repository']).toEqual({ type: 'git', url: `git+${REPO_URL}.git` });
    expect(raw['bugs']).toEqual({ url: `${REPO_URL}/issues` });
    expect(plugin['homepage']).toBe(`${REPO_URL}#readme`);
    expect(plugin['repository']).toBe(REPO_URL);
    const all = read('.claude-plugin/plugin.json') + read('.claude-plugin/marketplace.json') + read('package.json');
    expect(all).not.toMatch(/example\.com|your-org|<owner>|TODO/i);
  });
});

describe('licensing', () => {
  it('uses Apache-2.0 consistently', () => {
    expect(pkg.license).toBe('Apache-2.0');
    expect(lock.packages['']?.license).toBe('Apache-2.0');
    expect(plugin['license']).toBe('Apache-2.0');
    expect(market.plugins[0]?.['license']).toBe('Apache-2.0');
  });

  it('ships the unmodified Apache License 2.0 text', () => {
    const hash = createHash('sha256').update(readFileSync(join(ROOT, 'LICENSE'))).digest('hex');
    expect(hash).toBe('cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
  });

  it('has a NOTICE with the copyright line and the non-affiliation statement', () => {
    const notice = prose('NOTICE');
    expect(notice).toContain('Copyright 2026 Mycelink Contributors');
    expect(notice).toMatch(/not affiliated with, endorsed by, or sponsored by Anthropic/);
  });

  it('states non-affiliation in the README', () => {
    expect(prose('README.md')).toMatch(/not affiliated with or endorsed by Anthropic/);
  });

  it('declares no telemetry', () => {
    expect(read('README.md')).toMatch(/No telemetry/);
    expect(read('docs/DATA_HANDLING.md')).toMatch(/No telemetry/);
  });
});

describe('public documentation and community files', () => {
  it.each([
    'README.md',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    'SUPPORT.md',
    'GOVERNANCE.md',
    'docs/THREAT_MODEL.md',
    'docs/PERMISSION_MODEL.md',
    'docs/DATA_HANDLING.md',
    'docs/ADAPTERS.md',
    'docs/RELEASING.md',
    '.github/ISSUE_TEMPLATE/bug.yml',
    '.github/ISSUE_TEMPLATE/feature.yml',
    '.github/ISSUE_TEMPLATE/compatibility.yml',
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/pull_request_template.md',
    '.github/dependabot.yml',
    '.github/CODEOWNERS',
  ])('%s exists', (rel) => {
    expect(existsSync(join(ROOT, rel))).toBe(true);
  });

  it('the README covers every required section', () => {
    const readme = read('README.md');
    for (const heading of ['Architecture', 'Security model', 'Install', 'Quickstart', 'Configuration', 'Examples', 'Update and uninstall', 'Limitations', 'Troubleshooting']) {
      expect(readme, heading).toMatch(new RegExp(`^## ${heading}`, 'm'));
    }
  });

  it('the Code of Conduct is the Contributor Covenant 2.1 with attribution and no placeholder', () => {
    const coc = read('CODE_OF_CONDUCT.md');
    expect(coc).toMatch(/Contributor Covenant/);
    expect(coc).toMatch(/version 2\.1/);
    expect(coc).toContain('https://www.contributor-covenant.org/version/2/1/code_of_conduct.html');
    expect(coc).not.toMatch(/INSERT CONTACT/);
  });

  it('SECURITY.md routes reports through GitHub Security Advisories and invents no e-mail', () => {
    const security = read('SECURITY.md');
    expect(security).toMatch(/Security Advisories/);
    expect(security).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it('public security reports are disabled in favour of SECURITY.md', () => {
    const config = read('.github/ISSUE_TEMPLATE/config.yml');
    expect(config).toMatch(/blank_issues_enabled:\s*false/);
    expect(config).toMatch(/SECURITY\.md|security\/advisories/);
  });

  it('CODEOWNERS and the GOVERNANCE maintainers table name the same owner', () => {
    expect(read('.github/CODEOWNERS')).toMatch(/^\*\s+@nigunpark\s*$/m);
    const governance = read('GOVERNANCE.md');
    expect(governance).toMatch(/^\| \[@nigunpark\]\(https:\/\/github\.com\/nigunpark\) \| all \|$/m);
    expect(governance).toMatch(/CODEOWNERS/);
    expect(governance).not.toMatch(/to be filled in/i);
  });

  it('install instructions and community links use the real repository, not a placeholder', () => {
    const readme = read('README.md');
    expect(readme).toContain('claude plugin marketplace add nigunpark/mycelink');
    expect(readme).not.toMatch(/<owner>/);
    expect(read('SECURITY.md')).toContain(`${REPO_URL}/security/advisories/new`);
    expect(read('SUPPORT.md')).toContain(`${REPO_URL}/issues`);
    expect(read('.github/ISSUE_TEMPLATE/config.yml')).toContain(`${REPO_URL}/security/advisories/new`);
  });

  it('documents ECC as optional and unverified against a live installation', () => {
    const adapters = read('docs/ADAPTERS.md');
    expect(adapters).toMatch(/optional/i);
    expect(adapters).toMatch(/not against output from a live ECC/);
  });
});
