/** Sale-time metadata only. Missing values must never be inferred from today's shop. */
export interface ReceiptTax {
  taxRate?: number | null;
  taxInclusive?: boolean | null;
  taxNumber?: string | null;
}
export function hasReceiptTax(sale: ReceiptTax): boolean {
  return typeof sale.taxRate === 'number' && Number.isFinite(sale.taxRate)
    && typeof sale.taxInclusive === 'boolean' && sale.taxNumber !== undefined;
}
export function receiptTaxLabel(sale: ReceiptTax): string {
  return hasReceiptTax(sale)
    ? `VAT (${sale.taxRate}%${sale.taxInclusive ? ' incl.' : ''})`
    : 'VAT (historical settings unavailable)';
}
export function receiptTaxIdentity(sale: ReceiptTax): string {
  if (!hasReceiptTax(sale)) return 'Historical VAT settings and registration unavailable';
  return sale.taxNumber ? `VAT No: ${sale.taxNumber}` : 'VAT registration: none recorded at sale';
}
