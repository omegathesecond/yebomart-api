import { Sale, SaleItem, Return, ReturnItem, ReturnExchangeItem } from '@prisma/client';
import { entitlement } from './return-entitlement';
import { round2 } from '@utils/tax';

type Receipt = Sale & { items: SaleItem[] };
type CompletedReturn = Return & {
  items: ReturnItem[];
  exchangeItems: ReturnExchangeItem[];
};
export interface Movement {
  productId: string;
  name: string;
  staffId: string | null;
  quantity: number;
  grossSales: number;
  returns: number;
  exchangeSales: number;
  salesTax: number;
  returnedTax: number;
  exchangeTax: number;
  salesCost: number;
  reversedCost: number;
  exchangeCost: number;
  unitPrice: number;
}
export const emptyMovement = (productId: string, name: string, staffId: string | null): Movement => ({
  productId,
  name,
  staffId,
  quantity: 0,
  grossSales: 0,
  returns: 0,
  exchangeSales: 0,
  salesTax: 0,
  returnedTax: 0,
  exchangeTax: 0,
  salesCost: 0,
  reversedCost: 0,
  exchangeCost: 0,
  unitPrice: 0,
});

// Use the same discounted product weights / cent boundaries as return entitlement.
// The charged total and VAT are immutable even if prices or shop tax settings change.
export function receiptProducts(sale: Receipt) {
  const allocated = entitlement(sale, []);
  const taxCents = Math.round(sale.tax * 100);
  const totalCents = Math.round(sale.totalAmount * 100);
  let grossBefore = 0,
    taxBefore = 0;
  return allocated.map((p) => {
    grossBefore += p.remainingCents;
    const taxBoundary = totalCents ? Math.round((taxCents * grossBefore) / totalCents) : 0;
    const tax = (taxBoundary - taxBefore) / 100;
    taxBefore = taxBoundary;
    const lines = sale.items.filter((i) => i.productId === p.productId);
    return {
      id: p.productId as string,
      name: p.productName as string,
      quantity: p.quantity as number,
      gross: p.remainingCents / 100,
      tax,
      cost: lines.reduce((n, i) => n + i.costPrice * i.quantity, 0),
      unitPrice: lines.reduce((n, i) => n + i.unitPrice, 0) / lines.length,
    };
  });
}

/** Read-only merchandise journal. Account credits and debt reversals are NOT
 * additional returns or payouts. Only ReturnItem reservations reverse merchandise.
 * Receiptless values and exchange lines lacking evidence remain explicitly outside
 * known revenue/VAT/COGS. No current product costs are substituted for history. */
export function account(sales: Receipt[], returns: CompletedReturn[], originals: Receipt[], startDate: Date) {
  const movements: Movement[] = [];
  const evidence = {
    receiptlessReturns: 0,
    receiptlessCount: 0,
    unvaluedExchange: 0,
    unvaluedExchangeCount: 0,
  };
  const originalsById = new Map(originals.map((s) => [s.id, s]));
  for (const sale of sales)
    for (const p of receiptProducts(sale)) {
      const lines = sale.items.filter((i) => i.productId === p.id).sort((a, b) => a.id.localeCompare(b.id));
      let weight = 0,
        grossBefore = 0,
        taxBefore = 0;
      const totalWeight = lines.reduce((n, i) => n + Math.max(0, i.totalPrice), 0);
      for (const line of lines) {
        weight += Math.max(0, line.totalPrice);
        const grossBoundary = totalWeight ? Math.round((p.gross * 100 * weight) / totalWeight) : 0;
        const taxBoundary = totalWeight ? Math.round((p.tax * 100 * weight) / totalWeight) : 0;
        movements.push({
          ...emptyMovement(p.id, line.productName, sale.userId),
          quantity: line.quantity,
          grossSales: (grossBoundary - grossBefore) / 100,
          salesTax: (taxBoundary - taxBefore) / 100,
          salesCost: line.costPrice * line.quantity,
          unitPrice: line.unitPrice,
        });
        grossBefore = grossBoundary;
        taxBefore = taxBoundary;
      }
    }
  // Cumulative completed allocations exhaust original VAT/cost cents exactly.
  // Previous completions are included for allocation, never recognized twice.
  const used = new Map<string, { gross: number; tax: number; restocked: number; cost: number }>();
  const sorted = [...returns].sort(
    (a, b) => a.processedAt!.getTime() - b.processedAt!.getTime() || a.id.localeCompare(b.id),
  );
  for (const r of sorted) {
    if (r.status !== 'COMPLETED' || !r.processedAt) continue;
    const inPeriod = r.processedAt >= startDate;
    const original = r.saleId ? originalsById.get(r.saleId) : undefined;
    if (r.saleId && !original) throw new Error(`Original sale evidence missing for return ${r.id}`);
    const products = original ? receiptProducts(original) : [];
    for (const item of r.items) {
      const gross = round2(item.quantity * item.unitPrice);
      if (!original) {
        if (!inPeriod) continue;
        evidence.receiptlessReturns = round2(evidence.receiptlessReturns + gross);
        continue;
      }
      const p = products.find((p) => p.id === item.productId);
      if (!p) throw new Error(`Original item evidence missing for return ${r.id}`);
      const key = `${original.id}:${p.id}`;
      const prior = used.get(key) || {
        gross: 0,
        tax: 0,
        restocked: 0,
        cost: 0,
      };
      const cumulativeGross = round2(prior.gross + gross);
      const cumulativeTax = p.gross ? round2((p.tax * cumulativeGross) / p.gross) : 0;
      const restocked = prior.restocked + (item.restockable && item.restocked ? item.quantity : 0);
      const cumulativeCost = round2((p.cost * restocked) / p.quantity);
      if (inPeriod)
        movements.push({
          ...emptyMovement(p.id, p.name, original.userId),
          quantity: -item.quantity,
          returns: gross,
          returnedTax: round2(cumulativeTax - prior.tax),
          reversedCost: round2(cumulativeCost - prior.cost),
        });
      used.set(key, {
        gross: cumulativeGross,
        tax: cumulativeTax,
        restocked,
        cost: cumulativeCost,
      });
    }
    if (!inPeriod) continue;
    if (!original) evidence.receiptlessCount++;
    for (const item of r.exchangeItems) {
      if (item.tax == null || item.costPrice == null || item.totalAmount == null) {
        evidence.unvaluedExchange = round2(evidence.unvaluedExchange + item.quantity * item.unitPrice);
        evidence.unvaluedExchangeCount++;
        continue;
      }
      movements.push({
        ...emptyMovement(item.productId, item.productName, r.userId),
        quantity: item.quantity,
        exchangeSales: item.totalAmount,
        exchangeTax: item.tax,
        exchangeCost: item.costPrice * item.quantity,
      });
    }
  }
  return { movements, evidence };
}
export function totals(rows: Movement[]) {
  const sum = (key: keyof Movement) => round2(rows.reduce((n, r) => n + Number(r[key]), 0));
  const grossSales = sum('grossSales'),
    returns = sum('returns'),
    exchangeSales = sum('exchangeSales');
  const salesTax = sum('salesTax'),
    returnedTax = sum('returnedTax'),
    exchangeTax = sum('exchangeTax');
  const grossCost = sum('salesCost'),
    reversedCost = sum('reversedCost'),
    exchangeCost = sum('exchangeCost');
  const totalSales = round2(grossSales - returns + exchangeSales);
  const totalTax = round2(salesTax - returnedTax + exchangeTax);
  const netRevenue = round2(totalSales - totalTax);
  const totalCost = round2(grossCost - reversedCost + exchangeCost);
  return {
    grossSales,
    returns,
    exchangeSales,
    totalSales,
    salesTax,
    returnedTax,
    exchangeTax,
    totalTax,
    grossCost,
    reversedCost,
    exchangeCost,
    totalCost,
    netRevenue,
    grossProfit: round2(netRevenue - totalCost),
  };
}
