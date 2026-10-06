import { validationError } from './errors.mjs';

export const CURRENCIES = Object.freeze(['USD', 'EUR', 'KRW']);

/** Largest single amount any Ledgerline operation accepts, in minor units. */
export const MAX_AMOUNT_CENTS = 100_000_000;

/**
 * Amounts are always integer minor units ("cents"). Floats, strings and
 * non-positive values are rejected so rounding never happens implicitly.
 */
export function assertAmountCents(value, field = 'amount_cents') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_AMOUNT_CENTS) {
    throw validationError(`${field} must be a positive integer number of cents (max ${MAX_AMOUNT_CENTS})`, {
      field,
    });
  }
  return value;
}

export function assertCurrency(value, field = 'currency') {
  if (typeof value !== 'string' || !CURRENCIES.includes(value)) {
    throw validationError(`${field} must be one of ${CURRENCIES.join(', ')}`, { field });
  }
  return value;
}
