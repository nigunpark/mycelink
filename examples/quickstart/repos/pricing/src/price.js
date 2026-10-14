/** Whole cents as a dollar string: 1250 -> "$12.50". */
export function formatPrice(cents) {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new RangeError(`price_cents must be a non-negative integer, got ${cents}`);
  }
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
