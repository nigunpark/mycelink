import { UsageError, parseArgs } from './args.mjs';
import { ApiError, createClient } from './client.mjs';
import { orders } from './commands/orders.mjs';

export const GROUPS = { orders };

export const USAGE = `usage: ledger [--api <url>] <group> <command> [args]

  orders create --amount <cents> [--currency USD|EUR|KRW] [--key <idempotency-key>] [--id <order_id>]
  orders show <order_id>
  orders capture <order_id>
  orders events <order_id>

Output is one JSON document on stdout. Errors are {"error":{...}} on stderr.
Exit codes: 0 ok, 1 the API refused the request, 2 usage error, 3 API unreachable.`;

/** Returns the exit code; never calls process.exit itself. */
export async function main(argv, { env = process.env, out = console.log, err = console.error } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    err(JSON.stringify({ error: { code: 'USAGE', message: error.message } }));
    return 2;
  }
  const [groupName, commandName, ...rest] = parsed.positionals;
  const group = GROUPS[groupName];
  const command = group?.[commandName];
  if (!command) {
    err(USAGE);
    return 2;
  }
  try {
    const request = createClient(parsed.flags.api ?? env.LEDGER_API_URL);
    const result = await command({ positionals: rest, flags: parsed.flags }, request);
    out(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err(JSON.stringify({ error: { code: 'USAGE', message: error.message } }));
      return 2;
    }
    if (error instanceof ApiError) {
      err(JSON.stringify({ error: error.error }));
      return 1;
    }
    err(JSON.stringify({ error: { code: 'UNREACHABLE', message: String(error?.message ?? error) } }));
    return 3;
  }
}
