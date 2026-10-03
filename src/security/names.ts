/**
 * Identifier safety.
 *
 * Feature ids, node ids, candidate ids, repository names and branch names all
 * become filesystem path segments, git ref names or git argv. Validating them
 * once, at the boundary, is what keeps a hostile name from turning into a
 * traversal ("../"), a git option ("--upload-pack=..."), or a corrupted log.
 */

export class UnsafeNameError extends Error {
  readonly kind: string;
  readonly value: string;
  constructor(kind: string, value: string, why: string) {
    super(`Unsafe ${kind} ${JSON.stringify(value).slice(0, 120)}: ${why}`);
    this.name = 'UnsafeNameError';
    this.kind = kind;
    this.value = value;
  }
}

export const FEATURE_ID_PATTERN = /^[A-Z][A-Z0-9]*-[0-9]+$/;
export const REPOSITORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const NODE_SUFFIX = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const RESERVED_FILE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function assertFeatureId(id: string): void {
  if (typeof id !== 'string' || !FEATURE_ID_PATTERN.test(id)) {
    throw new UnsafeNameError('feature id', String(id), 'expected UPPERCASE-123 (for example FEAT-42)');
  }
}

export function isSafeFeatureId(id: string): boolean {
  return typeof id === 'string' && FEATURE_ID_PATTERN.test(id);
}

export function assertRepositoryName(name: string): void {
  if (typeof name !== 'string' || name.length > 64 || !REPOSITORY_NAME_PATTERN.test(name)) {
    throw new UnsafeNameError('repository name', String(name), 'expected lowercase letters, digits and "-"');
  }
}

/**
 * Node ids are `<FEATURE>.<suffix>`; the suffix becomes part of a git ref and
 * a directory name, so it must also satisfy ref-name rules.
 */
export function nodeIdProblem(id: string): string | null {
  if (typeof id !== 'string') return 'not a string';
  const dot = id.indexOf('.');
  if (dot === -1) return 'missing "<feature>." prefix';
  if (!FEATURE_ID_PATTERN.test(id.slice(0, dot))) return 'invalid feature prefix';
  const suffix = id.slice(dot + 1);
  if (!NODE_SUFFIX.test(suffix)) return 'suffix may contain only letters, digits, "_", "." and "-" and must not start with "-" or "."';
  if (suffix.includes('..')) return 'contains ".."';
  if (suffix.endsWith('.') || suffix.endsWith('.lock')) return 'must not end with "." or ".lock"';
  if (id.length > 200) return 'too long';
  return null;
}

export function assertNodeId(id: string): void {
  const problem = nodeIdProblem(id);
  if (problem !== null) throw new UnsafeNameError('node id', String(id), problem);
}

/**
 * Git ref-name rules (git check-ref-format) plus "must not look like an
 * option", so a branch name can never be parsed by git as a flag.
 */
export function refNameProblem(ref: string): string | null {
  if (typeof ref !== 'string' || ref === '') return 'empty';
  if (ref.startsWith('-')) return 'starts with "-" (would be read as a git option)';
  if (ref === '@') return 'is "@"';
  if (ref.length > 200) return 'too long';
  if (/[\u0000- \u007f ~^:?*[\\]/.test(ref)) return 'contains a space, control character or one of ~ ^ : ? * [ \\';
  if (ref.includes('..')) return 'contains ".."';
  if (ref.includes('@{')) return 'contains "@{"';
  if (ref.includes('//')) return 'contains "//"';
  if (ref.startsWith('/') || ref.endsWith('/')) return 'starts or ends with "/"';
  if (ref.endsWith('.')) return 'ends with "."';
  for (const component of ref.split('/')) {
    if (component.startsWith('.')) return 'a component starts with "."';
    if (component.endsWith('.lock')) return 'a component ends with ".lock"';
  }
  return null;
}

export function assertRefName(ref: string, kind = 'branch name'): void {
  const problem = refNameProblem(ref);
  if (problem !== null) throw new UnsafeNameError(kind, String(ref), problem);
}

export function assertCandidateId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Z][A-Z0-9]*-[0-9]+-C[0-9]{3,}$/.test(id)) {
    throw new UnsafeNameError('candidate id', String(id), 'expected <FEATURE>-C<nnn>');
  }
}

/** A single file name with no directory part, usable on every platform. */
export function assertPlainFileName(name: string): void {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.length > 255 ||
    /[\u0000-\u001f<>:"/\\|?*]/.test(name) ||
    RESERVED_FILE.test(name)
  ) {
    throw new UnsafeNameError('file name', String(name), 'expected a plain file name without a directory');
  }
}
