/** A controller declaration grants exactly two named siblings, never a subtree selector. */
export function validFixtureSibling(path: unknown, manifest: boolean): path is string {
  if (typeof path !== 'string' || !/^\.\.\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path)) return false;
  const name = path.slice(3);
  if (name.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) return false;
  return !manifest || (name.endsWith('.json') && name.length > 5);
}
