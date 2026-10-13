/** `text` as a regular expression that matches exactly it: every metacharacter escaped, the backslash included. */
export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}
