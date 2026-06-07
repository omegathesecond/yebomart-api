/**
 * VAT / tax computation for a sale, shared by the sale flow and any other
 * consumer that needs authoritative tax numbers. The shop config is the single
 * source of truth — never trust a client-supplied tax.
 *
 * `vatRate` is a PERCENTAGE (e.g. 15 = 15%). Two pricing models:
 *   - exclusive (pricesIncludeVat = false): VAT is added on top of the net.
 *       tax   = net * rate
 *       total = net + tax
 *   - inclusive (pricesIncludeVat = true): product prices already include VAT,
 *     so the total is unchanged and we extract the VAT component.
 *       tax   = net - net / (1 + rate)
 *       total = net
 *
 * When the shop is not VAT-registered (or rate <= 0) tax is 0 and total = net,
 * leaving non-registered shops exactly as they were.
 */
export interface ShopVatConfig {
  vatRegistered: boolean;
  vatRate: number; // percentage
  pricesIncludeVat: boolean;
}

export interface VatResult {
  /** net = subtotal - discount (never negative). */
  net: number;
  /** VAT amount, rounded to 2 decimals. */
  tax: number;
  /** Amount payable, rounded to 2 decimals. */
  totalAmount: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeVat(subtotal: number, discount: number, cfg: ShopVatConfig): VatResult {
  const net = Math.max(0, subtotal - discount);

  if (!cfg.vatRegistered || !cfg.vatRate || cfg.vatRate <= 0) {
    return { net, tax: 0, totalAmount: round2(net) };
  }

  const rate = cfg.vatRate / 100;

  if (cfg.pricesIncludeVat) {
    const tax = round2(net - net / (1 + rate));
    return { net, tax, totalAmount: round2(net) };
  }

  const tax = round2(net * rate);
  return { net, tax, totalAmount: round2(net + tax) };
}
