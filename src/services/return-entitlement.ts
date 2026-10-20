import { Prisma } from '@prisma/client';
import { round2 } from '@utils/tax';

export class ReturnEligibilityError extends Error {}
export async function lockSale(tx: Prisma.TransactionClient, saleId: string) {
  await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
}

/** Allocate the persisted charged total by discounted line value, then by unit.
 * Rounded product boundaries allocate VAT and order discounts; each partial
 * return takes a rounded share of the remaining cents. The final units exhaust
 * the exact original charged total. Rejected reservations release both quantity and value.
 */
export function entitlement(sale: any, returns: any[]) {
  if (!sale || sale.status !== 'COMPLETED')
    throw new ReturnEligibilityError('Sale is not eligible for returns');
  const products = new Map<string, any>();
  for (const line of [...sale.items].sort((a, b) => a.id.localeCompare(b.id))) {
    const p = products.get(line.productId) || {
      productId: line.productId,
      productName: line.productName,
      quantity: 0,
      weight: 0,
    };
    p.quantity += line.quantity;
    p.weight += Math.max(0, line.totalPrice);
    products.set(line.productId, p);
  }
  const totalCents = Math.round(round2(sale.totalAmount) * 100);
  const weight = [...products.values()].reduce((n, p) => n + p.weight, 0);
  if (
    !Number.isSafeInteger(totalCents) ||
    totalCents < 0 ||
    (weight === 0 && totalCents !== 0)
  )
    throw new ReturnEligibilityError('Invalid original sale valuation');
  let cumulative = 0,
    allocated = 0;
  return [...products.values()].map((p) => {
    cumulative += p.weight;
    const boundary = weight
      ? Math.round((totalCents * cumulative) / weight)
      : 0;
    const cents = boundary - allocated;
    allocated = boundary;
    const active = returns.filter((r) =>
      r.status !== 'REJECTED' || r.processedAt != null ||
      r.items.some((item: any) => item.restocked),
    );
    const used = active
      .flatMap((r) => r.items)
      .filter((i) => i.productId === p.productId)
      .reduce((n, i) => n + i.quantity, 0);
    // Persisted unit prices represent the exact reservation value (not rounded
    // display prices); this also detects overvalued historical returns.
    const usedCents = Math.round(
      active
        .flatMap((r) => r.items)
        .filter((i) => i.productId === p.productId)
        .reduce((n, i) => n + i.quantity * i.unitPrice * 100, 0),
    );
    if (used > p.quantity || usedCents > cents)
      throw new ReturnEligibilityError(
        'Prior returns exceed original sale entitlement',
      );
    return {
      ...p,
      remainingQuantity: p.quantity - used,
      remainingCents: cents - usedCents,
    };
  });
}
export function refundCents(p: any, quantity: number) {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > p.remainingQuantity
  )
    throw new ReturnEligibilityError(
      'Requested quantity exceeds remaining sale entitlement',
    );
  return Math.round((p.remainingCents * quantity) / p.remainingQuantity);
}
export async function loadEntitlement(
  tx: Prisma.TransactionClient,
  saleId: string,
  shopId: string,
  excludeId?: string,
) {
  const sale = await tx.sale.findFirst({
    where: { id: saleId, shopId },
    include: { items: true },
  });
  const returns = await tx.return.findMany({
    where: { saleId, shopId, ...(excludeId ? { id: { not: excludeId } } : {}) },
    include: { items: true },
  });
  return entitlement(sale, returns);
}
