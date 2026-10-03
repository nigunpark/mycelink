/** Minimal, dependency-free argv parsing with `--` passthrough. */

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  /** Everything after a bare `--`, used for verifier commands. */
  passthrough: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const passthrough: string[] = [];

  let afterDashDash = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (afterDashDash) {
      passthrough.push(token);
      continue;
    }
    if (token === '--') {
      afterDashDash = true;
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags, passthrough };
}

export function flagString(args: ParsedArgs, name: string, fallback?: string): string {
  const value = args.flags[name];
  if (typeof value === 'string') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required --${name}`);
}

export function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
  const value = args.flags[name];
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}
