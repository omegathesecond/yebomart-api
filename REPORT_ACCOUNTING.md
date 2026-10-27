# Sales and return reporting

Reports recognize completed sales on createdAt and completed returns/exchanges on processedAt. Range endpoints include the full final day. Pending, approved and rejected returns and completions without processedAt are excluded. Reporting reads never post ledger entries or change stock.

Gross sales and returns include VAT. Net sales = gross sales - receipt-linked merchandise returns + valued exchange-out merchandise. Net revenue = net sales - net VAT. Average baskets and transaction counts describe original sales, so returns against earlier receipts can produce negative daily revenue without negative transaction counts.

ReturnItem quantity × persisted unitPrice is the reserved discounted charged value from return-entitlement.ts, regardless of REFUND, paid-sale STORE_CREDIT or CREDIT debt reversal. CustomerCredit entries and refundAmount are not additional merchandise adjustments. Payment breakdown contains original sale tenders; use cash-up reports for actual payouts.

Original Sale.tax and Sale.totalAmount are allocated using the same product cent boundaries as entitlement. Partial returns allocate VAT cumulatively over completed reserved value, exhausting original cents. Sale-time product costs use weighted original SaleItem costs if the same product appeared on multiple lines. Only restockable AND actually restocked units reverse COGS; damaged/unrestocked goods retain their cost. Returned merchandise belongs to the original cashier, exchanges to the return's staff attribution. Unattributed staff activity is retained so totals reconcile.

Outgoing exchanges are separate from cash sales. Completion captures costPrice, tax and totalAmount on ReturnExchangeItem, using the product cost and shop tax configuration applicable to that new outgoing supply. Reporting never reads current prices, costs or tax settings for historical valuation.

Receiptless returns have a recorded adjustment value but no original VAT/COGS evidence. They remain outside known revenue, VAT and profit, and reports visibly mark profit incomplete. Historical exchange lines without snapshots likewise remain a separately labeled unvalued amount (recorded quantity × unitPrice, not an invented tax-inclusive total). These exceptions appear in UI, CSV and printable PDF; they require original evidence before management profit can be finalized.

## Release ordering

Apply prisma/migrations/20261027000000_exchange_report_snapshots/migration.sql to dev and production before deploying the API. It adds nullable exchange snapshots and a completion-date reporting index; it deliberately does not backfill invented historical values. Then deploy API and app together for the updated required report fields. This implementation task does not apply migrations or deploy.
