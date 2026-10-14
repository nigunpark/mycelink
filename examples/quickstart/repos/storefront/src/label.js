const dollars = (cents) => `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

/** The one-line label a product card shows: "Mug: $12.50". */
export function productLabel(product) {
  return `${product.name}: ${dollars(product.price_cents)}`;
}
