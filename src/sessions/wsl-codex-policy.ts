import { matchGlob } from '../git/worktree.js';

/** Trusted controller expansion: Python's root-owned seal independently rechecks exact names. */
export function expandAllowedProposalPaths(
  proposals: readonly string[],
  fence: { allowed: readonly string[]; forbidden: readonly string[] },
): string[] {
  if (proposals.length > 4096) throw new Error('PROPOSAL_BUDGET_EXCEEDED');
  const names = new Set<string>();
  const folded = new Set<string>();
  for (const name of proposals) {
    const segments = name.split('/');
    if (!/^[A-Za-z0-9_./-]{1,240}$/.test(name) || name.startsWith('/') ||
        segments.some((segment) => segment === '' || segment.startsWith('.') || segment.endsWith('.') || segment.endsWith(' ') || segment === '..')) {
      throw new Error(`UNSAFE_PROPOSAL: ${name.slice(0, 80)}`);
    }
    if (segments.some((segment) => ['result.json', 'verdict.json', '_receipt.json', 'mycelink'].includes(segment.toLowerCase()))) {
      throw new Error(`RESERVED_PROPOSAL: ${name.slice(0, 80)}`);
    }
    if (folded.has(name.toLowerCase())) throw new Error(`ALIAS_PROPOSAL: ${name.slice(0, 80)}`);
    folded.add(name.toLowerCase());
    if (!fence.allowed.some((glob) => matchGlob(glob, name)) ||
        fence.forbidden.some((glob) => matchGlob(glob, name))) {
      throw new Error(`OWNERSHIP_VIOLATION: ${name.slice(0, 80)}`);
    }
    names.add(name);
  }
  return [...names].sort();
}
