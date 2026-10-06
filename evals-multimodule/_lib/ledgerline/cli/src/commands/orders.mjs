import { assertAmountCents, assertCurrency } from '../../vendor/ledger-core/index.mjs';
import { UsageError, intFlag } from '../args.mjs';

function orderIdArg(positionals) {
  const id = positionals[0];
  if (!id) throw new UsageError('an order id is required');
  return encodeURIComponent(id);
}

function validated(fn) {
  try {
    return fn();
  } catch (error) {
    throw new UsageError(error.message);
  }
}

/** ledger orders <create|show|capture|events> ... */
export const orders = {
  async create({ flags }, request) {
    const amount_cents = validated(() => assertAmountCents(intFlag(flags, 'amount'), '--amount'));
    const currency = validated(() => assertCurrency(flags.currency ?? 'USD', '--currency'));
    const headers = flags.key ? { 'idempotency-key': flags.key } : {};
    const body = { amount_cents, currency };
    if (flags.id) body.order_id = flags.id;
    return (await request('POST', '/orders', { body, headers })).order;
  },
  async show({ positionals }, request) {
    return (await request('GET', `/orders/${orderIdArg(positionals)}`)).order;
  },
  async capture({ positionals }, request) {
    return (await request('POST', `/orders/${orderIdArg(positionals)}/capture`)).order;
  },
  async events({ positionals }, request) {
    return (await request('GET', `/orders/${orderIdArg(positionals)}/events`)).events;
  },
};
