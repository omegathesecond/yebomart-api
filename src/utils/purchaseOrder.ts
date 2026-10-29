import { Prisma } from '@prisma/client';

interface ReceiptLine {
  quantity: number;
  receivedQty: number;
  totalCost: number;
}

/** Cumulative supplier payable, including proportional purchase tax (never revenue).
 * Zero-value orders allocate tax on final receipt, when no value weighting exists.
 * Final receipt absorbs every cent left by partial-receipt rounding.
 */
export function receivedPayable(
  po: { subtotal: number; tax: number; totalAmount: number },
  items: ReceiptLine[],
): number {
  if (items.every(item => item.receivedQty === item.quantity)) {
    return new Prisma.Decimal(po.totalAmount).toDecimalPlaces(2).toNumber();
  }
  const base = items.reduce((sum, item) =>
    sum.plus(new Prisma.Decimal(item.totalCost).times(item.receivedQty).div(item.quantity)), new Prisma.Decimal(0));
  const tax = po.subtotal > 0
    ? base.times(po.tax).div(po.subtotal)
    : new Prisma.Decimal(0);
  return base.plus(tax).toDecimalPlaces(2).toNumber();
}
