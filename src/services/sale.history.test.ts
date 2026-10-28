import { beforeEach, describe, expect, it } from 'vitest';
import { SaleService } from './sale.service';
import { resetDb, seedSale } from '../test/prismaFake';

beforeEach(() => resetDb());
describe('sales history pagination', () => {
  it('returns all 65 shop sales in deterministic order, with dates and foreign-shop isolation', async () => {
    const base = new Date('2026-10-01T12:00:00Z');
    // Insert ids in reverse lexical order to catch missing timestamp tie-breaks.
    for (let i = 64; i >= 0; i--) {
      seedSale({ id: `sale-${String(i).padStart(3, '0')}`, shopId: 'shop-a', receiptNumber: `HIST-${i}`, createdAt: new Date(base.getTime() + Math.floor(i / 25) * 86400000) });
    }
    seedSale({ shopId: 'shop-b', receiptNumber: 'PRIVATE', createdAt: base });
    const ids: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const result = await SaleService.list({ shopId: 'shop-a', page, limit: 20 });
      expect(result.total).toBe(65);
      expect(result.hasNext).toBe(page < 4);
      expect(result.hasPrev).toBe(page > 1);
      ids.push(...result.sales.map(sale => sale.id));
    }
    expect(ids).toEqual(Array.from({ length: 65 }, (_, i) => `sale-${String(64 - i).padStart(3, '0')}`));
    const filtered = await SaleService.list({ shopId: 'shop-a', page: 1, limit: 20, startDate: new Date('2026-10-02T00:00:00Z'), endDate: new Date('2026-10-02T23:59:59.999Z') });
    expect(filtered.total).toBe(25);
    expect(filtered.sales.every(sale => sale.createdAt.toISOString().startsWith('2026-10-02'))).toBe(true);
    const receipt = await SaleService.getByReceiptNumber('HIST-0', 'shop-a');
    expect(receipt.id).toBe('sale-000');
    await expect(SaleService.getByReceiptNumber('PRIVATE', 'shop-a')).rejects.toThrow('not found');
    await expect(SaleService.getById(receipt.id, 'shop-b')).rejects.toThrow('not found');
  });
});
