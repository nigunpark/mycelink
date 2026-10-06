import { assertAmountCents } from '../../vendor/ledger-core/index.mjs';
import { UsageError, intFlag } from '../args.mjs';

function orderIdArg(positionals) {
  const id = positionals[0];
  if (!id) throw new UsageError('an order id is required');
  return encodeURIComponent(id);
}

/** ledger refunds <create|list> ... */
export const refunds = {
  async create({ positionals, flags }, request) {
    const id = orderIdArg(positionals);
    let amount_cents;
    try {
      amount_cents = assertAmountCents(intFlag(flags, 'amount'), '--amount');
    } catch (error) {
      throw new UsageError(error.message);
    }
    if (!flags.key) throw new UsageError('--key is required: refunds must carry an idempotency key');
    const body = { amount_cents };
    if (flags.reason !== undefined) body.reason = flags.reason;
    return (await request('POST', `/orders/${id}/refunds`, { body, headers: { 'idempotency-key': flags.key } })).refund;
  },
  async list({ positionals }, request) {
    return (await request('GET', `/orders/${orderIdArg(positionals)}/refunds`)).refunds;
  },
};
