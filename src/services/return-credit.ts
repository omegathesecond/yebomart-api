import { Prisma } from "@prisma/client";
import {
  applyCustomerCredit,
  creditBalanceChange,
  lockCustomerCredit,
} from "./customerCredit.service";
import { ReturnEligibilityError } from "./return-entitlement";

const cents = (value: number) => Math.round(value * 100);

// Caller holds the sale lock. Repayments are account-wide: never guess which
// sale they paid. Reverse the purchase entitlement and retain any account credit.
export async function validateCreditReturn(
  tx: Prisma.TransactionClient,
  input: {
    saleId: string;
    shopId: string;
    customerId?: string | null;
    type: string;
    exchangeItems: unknown[];
  },
) {
  const sale = await tx.sale.findFirst({
    where: { id: input.saleId, shopId: input.shopId },
  });
  if (!sale || sale.paymentMethod !== "CREDIT") return null;
  if (input.type !== "STORE_CREDIT" || input.exchangeItems.length)
    throw new ReturnEligibilityError(
      "Pay-later returns require an account adjustment (Store Credit); cash refunds and exchanges are not supported.",
    );
  if (
    !sale.customerId ||
    (input.customerId && input.customerId !== sale.customerId)
  )
    throw new ReturnEligibilityError(
      "Return customer must be the original pay-later debtor.",
    );
  const customerId = sale.customerId;
  await lockCustomerCredit(tx, { customerId, shopId: input.shopId });
  const ledger = await tx.customerCredit.findMany({ where: { customerId } });
  const entries = await tx.customerCredit.findMany({
    where: { saleId: sale.id },
  });
  const purchases = entries.filter((e) => e.type === "PURCHASE");
  const completed = await tx.return.findMany({
    where: { saleId: sale.id, status: "COMPLETED" },
    include: { items: true },
  });
  const purchase = purchases[0];
  if (
    purchases.length !== 1 ||
    purchase.customerId !== customerId ||
    purchase.shopId !== input.shopId ||
    !Number.isFinite(purchase.amount) ||
    purchase.amount <= 0 ||
    purchase.returnId !== null ||
    cents(purchase.amount) !== cents(sale.totalAmount) ||
    entries.some(
      (e) =>
        e.customerId !== customerId ||
        e.shopId !== input.shopId ||
        (e.type === "PAYMENT" &&
          (!Number.isFinite(e.amount) || e.amount < 0)) ||
        (e.type !== "PURCHASE" &&
          e.type !== "PAYMENT" &&
          !(e.type === "ADJUSTMENT" && e.returnId && e.amount < 0)),
    ) ||
    completed.some(
      (r) =>
        r.shopId !== input.shopId ||
        r.customerId !== customerId ||
        r.type !== "STORE_CREDIT" ||
        !entries.some(
          (e) =>
            e.returnId === r.id &&
            cents(-e.amount) ===
              cents(r.items.reduce((n, i) => n + i.quantity * i.unitPrice, 0)),
        ),
    ) ||
    entries.some(
      (e) => e.returnId && !completed.some((r) => r.id === e.returnId),
    )
  )
    throw new ReturnEligibilityError(
      "Pay-later sale has missing or ambiguous debt history; reconcile the account before returning items.",
    );
  const customer = await tx.customer.findFirst({
    where: { id: customerId, shopId: input.shopId },
  });
  if (
    !customer ||
    ledger.some(
      (e) => e.shopId !== input.shopId || !Number.isFinite(e.amount),
    ) ||
    cents(customer.balance) !==
      cents(
        ledger.reduce((n, e) => n + creditBalanceChange(e.type, e.amount), 0),
      )
  )
    throw new ReturnEligibilityError(
      "Customer balance does not match the ledger; reconcile the account first.",
    );
  return {
    customerId,
    purchase,
    reversedCents: entries.reduce(
      (n, e) => n + (e.returnId ? cents(-e.amount) : 0),
      0,
    ),
  };
}

export async function settleCreditReturn(
  tx: Prisma.TransactionClient,
  record: {
    id: string;
    saleId: string | null;
    shopId: string;
    customerId: string | null;
    type: string;
    exchangeItems: unknown[];
    items: Array<{ quantity: number; unitPrice: number }>;
  },
  userId?: string,
) {
  if (!record.saleId) return;
  const debt = await validateCreditReturn(tx, {
    ...record,
    saleId: record.saleId,
  });
  if (!debt) return;
  const amount = cents(
    record.items.reduce((n, i) => n + i.quantity * i.unitPrice, 0),
  );
  if (amount <= 0 || amount + debt.reversedCents > cents(debt.purchase.amount))
    throw new ReturnEligibilityError(
      "Return exceeds the remaining booked debt entitlement.",
    );
  await applyCustomerCredit(
    tx,
    {
      shopId: record.shopId,
      customerId: debt.customerId,
      saleId: record.saleId,
      returnId: record.id,
      type: "ADJUSTMENT",
      amount: -amount / 100,
      userId,
      note: `Return ${record.id}: reversal of purchase ${debt.purchase.id}; repayments retained; no cash refund`,
    },
    { currencySymbol: "" },
  );
}
