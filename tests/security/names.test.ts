/**
 * Malicious repository, feature, node, branch and file names.
 *
 * Names end up in filesystem paths, git ref names and git argv. A name that
 * starts with "-" becomes a git option; one with ".." becomes a traversal; one
 * with control characters corrupts logs. All are refused at the boundary.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCandidateId,
  assertFeatureId,
  assertNodeId,
  assertPlainFileName,
  assertRefName,
  UnsafeNameError,
} from '../../src/security/names.js';
import { featurePaths } from '../../src/workspace/paths.js';
import { validateGraph, validateRepositories } from '../../src/graph/validate.js';
import { workerBranchName } from '../../src/git/worktree.js';
import { candidateFile } from '../../src/git/candidate.js';
import { main } from '../../src/cli/cli.js';
import { clone, VALID_GRAPH, VALID_REPOSITORIES } from '../helpers/graph-fixtures.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';

afterEach(() => cleanupTmpRoots());

describe('feature ids', () => {
  it.each(['FEAT-1', 'ABC-42', 'X1-0007'])('accepts %s', (id) => {
    expect(() => assertFeatureId(id)).not.toThrow();
  });

  it.each(['../FEAT-1', 'FEAT-1/../../x', 'feat-1', '', 'FEAT-1\n', 'FEAT-1;rm', '-FEAT-1', 'C:\\FEAT-1'])(
    'rejects %j',
    (id) => {
      expect(() => assertFeatureId(id)).toThrow(UnsafeNameError);
    },
  );

  it('featurePaths refuses a traversal feature id instead of escaping features/', () => {
    expect(() => featurePaths('/control', '../../etc')).toThrow(UnsafeNameError);
  });

  it('the CLI rejects a traversal feature id with a non-zero exit', async () => {
    const root = makeTmpDir('names-');
    const err: string[] = [];
    const code = await main(['feature', 'status', '../../outside', '--control-root', root], {
      out: () => undefined,
      err: (t) => err.push(t),
    });
    expect(code).not.toBe(0);
    expect(err.join('\n')).toMatch(/feature id/i);
  });
});

describe('node ids', () => {
  it.each(['FEAT-1.core.publish.impl', 'FEAT-1.a_b-c.d'])('accepts %s', (id) => {
    expect(() => assertNodeId(id)).not.toThrow();
  });

  it.each(['FEAT-1.a..b', 'FEAT-1.x.lock', 'FEAT-1.trailing.', 'FEAT-1.-opt', 'FEAT-1.a/b', 'FEAT-1.a b'])(
    'rejects %j',
    (id) => {
      expect(() => assertNodeId(id)).toThrow(UnsafeNameError);
    },
  );

  it('the graph validator reports an unsafe node id', () => {
    const g = clone(VALID_GRAPH);
    const node = g.nodes[0] as { id: string };
    node.id = `${g.feature_id}.core..evil`;
    const result = validateGraph(g);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain('UNSAFE_NODE_ID');
  });

  it('worker branch derivation refuses an unsafe node id', () => {
    expect(() => workerBranchName('FEAT-1', 'FEAT-1.a..b')).toThrow(UnsafeNameError);
  });
});

describe('git ref names (base branches)', () => {
  it.each(['main', 'release/1.2', 'feature/FEAT-1', 'dev_x'])('accepts %s', (ref) => {
    expect(() => assertRefName(ref)).not.toThrow();
  });

  it.each([
    '-c',
    '--upload-pack=evil',
    'a..b',
    'a b',
    'a~1',
    'a^',
    'a:b',
    'a?',
    'a*',
    'a[',
    'a\\b',
    'a@{1}',
    '@',
    'a.lock',
    'a/',
    '/a',
    'a//b',
    '.hidden',
    'a/.b',
    'a.',
    'a\u0007b',
    '',
  ])('rejects %j', (ref) => {
    expect(() => assertRefName(ref)).toThrow(UnsafeNameError);
  });

  it('the repository manifest rejects an option-shaped base branch', () => {
    const m = clone(VALID_REPOSITORIES);
    (m.repositories[0] as { base_branch: string }).base_branch = '--upload-pack=touch /tmp/pwned';
    const result = validateRepositories(m);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain('UNSAFE_REF_NAME');
  });

  it('the repository manifest rejects a malicious repository name', () => {
    for (const name of ['../core', '-core', 'Core', 'co re', 'core;x']) {
      const m = clone(VALID_REPOSITORIES);
      (m.repositories[0] as { name: string }).name = name;
      expect(validateRepositories(m).ok, name).toBe(false);
    }
  });
});

describe('candidate ids and plain file names', () => {
  it('candidate file lookup refuses a traversal id', () => {
    expect(() => assertCandidateId('FEAT-1-C001')).not.toThrow();
    expect(() => candidateFile('/f', '../../../etc/passwd')).toThrow(UnsafeNameError);
  });

  it.each(['../x.json', 'a/b.json', 'a\\b.json', '..', '.', 'CON', 'x\u0000.json', ''])(
    'plain file name rejects %j',
    (name) => {
      expect(() => assertPlainFileName(name)).toThrow(UnsafeNameError);
    },
  );

  it('checkpoint restore refuses a path outside the checkpoints directory', async () => {
    const root = makeTmpDir('names-');
    const err: string[] = [];
    const code = await main(
      ['checkpoint', 'restore', 'FEAT-1', '../../STATE.json', '--control-root', root],
      { out: () => undefined, err: (t) => err.push(t) },
    );
    expect(code).not.toBe(0);
    expect(err.join('\n')).toMatch(/file name/i);
  });
});
