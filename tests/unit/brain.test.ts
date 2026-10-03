import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import {
  adoptCodewiki,
  brainRoot,
  consolidate,
  initBrain,
  listPages,
  markStale,
  readPage,
  selectMemories,
  supersede,
  writePage,
  type MemoryFrontmatter,
} from '../../src/knowledge/brain.js';

afterAll(() => cleanupTmpRoots());

function page(patch: Partial<MemoryFrontmatter> = {}): MemoryFrontmatter {
  return {
    id: 'deploy-preflight',
    title: 'Deploy preflight',
    type: 'procedure',
    status: 'instructed_not_verified',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    source_refs: [{ kind: 'user_instruction', ref: 'session-1' }],
    verification: {
      structural: 'not_run',
      references: 'not_run',
      build: 'not_run',
      tests: 'not_run',
      runtime: 'not_run',
    },
    ...patch,
  };
}

function freshBrain(): string {
  return initBrain(brainRoot(makeTmpDir('brain-')));
}

describe('brain pages', () => {
  it('creates the vault layout and a schema document', () => {
    const root = freshBrain();
    expect(existsSync(join(root, 'SCHEMA.md'))).toBe(true);
    expect(existsSync(join(root, 'procedures'))).toBe(true);
    expect(existsSync(join(root, 'code', 'modules'))).toBe(true);
    expect(readFileSync(join(root, 'SCHEMA.md'), 'utf8')).toMatch(/never rewritten to `passed`/);
  });

  it('writes and reads back a page with its frontmatter', () => {
    const root = freshBrain();
    const result = writePage(root, page(), 'Check the queue depth before deploying.');
    expect(result.problems).toEqual([]);
    const read = readPage(result.path);
    expect(read?.frontmatter.id).toBe('deploy-preflight');
    expect(read?.body).toContain('queue depth');
  });

  it('refuses a code page with no source anchor', () => {
    const root = freshBrain();
    const result = writePage(
      root,
      page({
        id: 'legacy-sync-manager',
        type: 'code-module',
        source_refs: [{ kind: 'user_instruction', ref: 'session-1' }],
      }),
      'Actually the entry point for new order sync.',
    );
    expect(result.problems.map((p) => p.code)).toContain('CODE_CLAIM_UNANCHORED');
    expect(result.path).toBe('');
  });

  it('accepts a code page anchored to a symbol', () => {
    const root = freshBrain();
    const result = writePage(
      root,
      page({
        id: 'legacy-sync-manager',
        type: 'code-module',
        source_refs: [{ kind: 'source', ref: 'src/sync/LegacySyncManager.java', symbol: 'LegacySyncManager' }],
      }),
      'Despite the name, the entry point for new order sync.',
    );
    expect(result.problems).toEqual([]);
  });

  it('refuses "verified" when nothing was actually verified', () => {
    const root = freshBrain();
    const result = writePage(root, page({ status: 'verified' }), 'body');
    expect(result.problems.map((p) => p.code)).toContain('VERIFIED_WITHOUT_VERIFICATION');
  });

  it('accepts "verified" once a verification step passed', () => {
    const root = freshBrain();
    const result = writePage(
      root,
      page({
        status: 'verified',
        verification: {
          structural: 'passed',
          references: 'not_run',
          build: 'not_run',
          tests: 'not_run',
          runtime: 'not_run',
        },
      }),
      'body',
    );
    expect(result.problems).toEqual([]);
  });
});

describe('brain retrieval', () => {
  function populated(): string {
    const root = freshBrain();
    writePage(
      root,
      page({
        id: 'incident-policy',
        title: 'Incident investigation policy',
        type: 'policy',
        status: 'verified',
        triggers: ['incident', 'outage'],
        tags: ['queue', 'core'],
        verification: {
          structural: 'passed',
          references: 'not_run',
          build: 'not_run',
          tests: 'not_run',
          runtime: 'not_run',
        },
      }),
      'Check Queue backlog and core heartbeat before restarting anything.',
    );
    writePage(
      root,
      page({
        id: 'queue-backlog-procedure',
        title: 'Check the Queue backlog',
        type: 'procedure',
        triggers: ['queue backlog'],
        tags: ['queue'],
      }),
      'Run the backlog query, then compare against the core heartbeat.',
    );
    writePage(
      root,
      page({
        id: 'serializer-mismatch',
        title: 'Serializer version mismatch',
        type: 'pitfall',
        status: 'stale',
        tags: ['queue', 'serializer'],
      }),
      'Empty results came from an core serializer version mismatch, not an API cache.',
    );
    writePage(
      root,
      page({ id: 'old-restart-first', title: 'Restart first', type: 'procedure', status: 'superseded' }),
      'Restart the service immediately.',
    );
    return root;
  }

  it('selects by trigger and ranks policy above other types', () => {
    const root = populated();
    const hits = selectMemories(root, { query: 'investigating a queue incident' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe('incident-policy');
  });

  it('excludes superseded pages from default retrieval but keeps them for audit', () => {
    const root = populated();
    const normal = selectMemories(root, { query: 'restart the service' });
    expect(normal.map((h) => h.id)).not.toContain('old-restart-first');

    const audit = selectMemories(root, { query: 'restart the service', includeExcluded: true });
    expect(audit.map((h) => h.id)).toContain('old-restart-first');
  });

  it('surfaces a stale page with a warning rather than hiding it', () => {
    const root = populated();
    const hits = selectMemories(root, { query: 'serializer mismatch queue' });
    const stale = hits.find((h) => h.id === 'serializer-mismatch');
    expect(stale).toBeDefined();
    expect(stale?.warning).toMatch(/STALE/);
  });

  it('marks an instructed-but-unverified page with a warning', () => {
    const root = populated();
    const hits = selectMemories(root, { query: 'queue backlog' });
    const procedure = hits.find((h) => h.id === 'queue-backlog-procedure');
    expect(procedure?.warning).toMatch(/NEVER EXECUTED/i);
  });

  it('returns bounded summaries, never whole page bodies', () => {
    const root = freshBrain();
    writePage(root, page({ id: 'long-one', tags: ['queue'] }), 'x'.repeat(5000));
    const hits = selectMemories(root, { query: 'queue' });
    expect(hits[0]?.summary.length).toBeLessThanOrEqual(300);
  });

  it('is deterministic for the same query', () => {
    const root = populated();
    const a = selectMemories(root, { query: 'queue incident' });
    const b = selectMemories(root, { query: 'queue incident' });
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
  });

  it('returns nothing for an unrelated query rather than guessing', () => {
    const root = populated();
    expect(selectMemories(root, { query: 'quarterly invoice formatting' })).toEqual([]);
  });
});

describe('brain lifecycle', () => {
  it('marks only pages watching a changed source as stale', () => {
    const root = freshBrain();
    writePage(
      root,
      page({
        id: 'queue-client-module',
        type: 'code-module',
        source_refs: [{ kind: 'source', ref: 'src/queue/client.ts', symbol: 'QueueClient' }],
        watch: ['src/queue/'],
      }),
      'Owns the Queue connection pool.',
    );
    writePage(
      root,
      page({ id: 'unrelated-procedure', watch: ['docs/'] }),
      'Unrelated to the Queue client.',
    );

    const affected = markStale(root, ['src/queue/client.ts']);
    expect(affected).toEqual(['queue-client-module']);
    const pages = listPages(root);
    expect(pages.find((p) => p.frontmatter.id === 'queue-client-module')?.frontmatter.status).toBe(
      'stale',
    );
    expect(pages.find((p) => p.frontmatter.id === 'unrelated-procedure')?.frontmatter.status).toBe(
      'instructed_not_verified',
    );
  });

  it('supersedes without destroying the old page', () => {
    const root = freshBrain();
    writePage(root, page({ id: 'old-way' }), 'The old way.');
    writePage(root, page({ id: 'new-way' }), 'The new way.');

    expect(supersede(root, 'old-way', 'new-way')).toBe(true);
    const old = listPages(root).find((p) => p.frontmatter.id === 'old-way');
    expect(old?.frontmatter.status).toBe('superseded');
    expect(old?.frontmatter.superseded_by).toEqual(['new-way']);
    // The body survives: history is kept, not rewritten.
    expect(old?.body).toContain('The old way.');
  });

  it('reports duplicate triggers without merging anything', () => {
    const root = freshBrain();
    writePage(root, page({ id: 'proc-a', triggers: ['deploy'] }), 'A');
    writePage(root, page({ id: 'proc-b', triggers: ['deploy'] }), 'B');
    const findings = consolidate(root);
    const duplicate = findings.find((f) => f.code === 'DUPLICATE_TRIGGER');
    expect(duplicate?.ids.sort()).toEqual(['proc-a', 'proc-b']);
    // Both pages still exist; nothing was merged.
    expect(listPages(root)).toHaveLength(2);
  });

  it('reports repeated episodes as a procedure promotion candidate', () => {
    const root = freshBrain();
    writePage(root, page({ id: 'ep-1', type: 'episode', tags: ['queue-restart'] }), 'first');
    writePage(root, page({ id: 'ep-2', type: 'episode', tags: ['queue-restart'] }), 'second');
    const findings = consolidate(root);
    expect(findings.some((f) => f.code === 'PROMOTION_CANDIDATE')).toBe(true);
  });

  it('reports a dangling reference', () => {
    const root = freshBrain();
    writePage(root, page({ id: 'proc-a', related: ['does-not-exist'] }), 'A');
    const findings = consolidate(root);
    expect(findings.some((f) => f.code === 'ORPHAN_REFERENCE')).toBe(true);
  });

  it('a no-change consolidation reports nothing and writes nothing', () => {
    const root = freshBrain();
    writePage(root, page({ id: 'only', triggers: ['unique-trigger'] }), 'body');
    const before = readFileSync(join(root, 'procedures', 'only.md'), 'utf8');
    expect(consolidate(root)).toEqual([]);
    expect(readFileSync(join(root, 'procedures', 'only.md'), 'utf8')).toBe(before);
  });
});

describe('codewiki adoption', () => {
  it('adopts an existing .codewiki by reference, without moving it', () => {
    const control = makeTmpDir('control-');
    const codewiki = join(control, '.codewiki');
    mkdirSync(join(codewiki, 'modules'), { recursive: true });
    writeFileSync(join(codewiki, 'modules', 'core.md'), '# core\n', 'utf8');

    const root = initBrain(brainRoot(control));
    const result = adoptCodewiki(control, root);

    expect(result.adopted).toBe(true);
    // Nothing was moved: existing extractors and tests keep working.
    expect(existsSync(join(codewiki, 'modules', 'core.md'))).toBe(true);
    const pointer = readFileSync(join(root, 'code', 'SUBVAULT.md'), 'utf8');
    expect(pointer).toContain('.codewiki');
    expect(pointer).toMatch(/not migrated/i);
  });

  it('is a no-op when there is no .codewiki', () => {
    const control = makeTmpDir('control-');
    const root = initBrain(brainRoot(control));
    expect(adoptCodewiki(control, root).adopted).toBe(false);
  });
});
