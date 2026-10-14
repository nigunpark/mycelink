# FEAT-101 — Show sale prices on product cards

Status: approved

## Problem

A product can be put on sale by a whole percentage, but nothing computes the
sale price and the storefront still shows the full price. `pricing` owns
prices; `storefront` renders the label a product card shows. The two
repositories share one record shape:
`{ "name": string, "price_cents": integer, "percent_off"?: integer, "sale_cents"?: integer }`.

## Scope

| Repository | Change |
|---|---|
| `pricing` | compute `sale_cents` from `price_cents` and `percent_off` |
| `storefront` | show the sale price, and the price it replaces, when a record has `sale_cents` |

No other change. Add no dependencies.

## Acceptance criteria

**AC-1 — sale price (pricing).** `applySale(product)`, exported from
`src/price.js`, returns a new record with every field of `product` plus
`sale_cents`: `price_cents` reduced by `percent_off` percent, rounded down to
a whole cent. `applySale({ name: "Mug", price_cents: 1250, percent_off: 20 })`
returns `{ name: "Mug", price_cents: 1250, percent_off: 20, sale_cents: 1000 }`,
and `percent_off: 15` on `price_cents: 999` gives `sale_cents: 849`. The input
record is not modified.

**AC-2 — no sale and invalid sales (pricing).** A record without
`percent_off` is returned unchanged, with no `sale_cents`. A `percent_off`
that is not an integer from 1 to 90 throws a `RangeError` whose message names
`percent_off`.

**AC-3 — sale label (storefront).** `productLabel(product)` of a record with
`sale_cents` returns `"<name>: <sale price> (was <price>)"`, for example
`"Mug: $10.00 (was $12.50)"`.

**AC-4 — unchanged behaviour (compatibility).** `formatPrice` and the label
of a record without `sale_cents` are unchanged: every existing test in both
repositories keeps passing.
