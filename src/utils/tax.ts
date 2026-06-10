/**
 * VAT / sales-tax computation — the single source of truth used by the sale
 * flow and reports. Mirrors app/src/lib/tax.ts so the POS shows exactly what
 * the server persists (and the client's amountPaid never trips the server's
 * "Insufficient payment" guard).
 *
 *  - taxInclusive=false → VAT is added on top:  tax = base * rate/100
 *  - taxInclusive=true  → VAT is already inside the price (extract it):
 *                         tax = base * rate/(100+rate)   (total unchanged)
 *
 * where `base = subtotal - discount`.
 */
export interface TaxConfig {
  taxRate: number;       // percent, e.g. 15
  taxInclusive: boolean;
}

export interface TaxBreakdown {
  tax: number;
  total: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeTax(subtotal: number, discount: number, cfg: TaxConfig): TaxBreakdown {
  const base = Math.max(0, subtotal - discount);
  const rate = cfg.taxRate || 0;

  if (rate <= 0) {
    return { tax: 0, total: round2(base) };
  }

  if (cfg.taxInclusive) {
    // Tax is the portion already inside the price; total is unchanged.
    const tax = round2((base * rate) / (100 + rate));
    return { tax, total: round2(base) };
  }

  // Exclusive: tax is added on top.
  const tax = round2((base * rate) / 100);
  return { tax, total: round2(base + tax) };
}
