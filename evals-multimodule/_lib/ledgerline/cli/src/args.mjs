export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Split argv into positionals and --flag value pairs (every flag takes a value). */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
      i += 1;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

export function intFlag(flags, name) {
  const raw = flags[name];
  if (raw === undefined) throw new UsageError(`--${name} is required`);
  if (!/^-?\d+$/.test(raw)) throw new UsageError(`--${name} must be an integer`);
  return Number(raw);
}
