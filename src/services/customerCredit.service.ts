import { CashSessionService } from './cashSession.service';
import { Prisma, CreditType, CollectionMethod } from '@prisma/client';

/**
 * Customer-credit money rules.
 *
 * Two invariants live here, with a transaction helper to enforce them under
 * concurrent writes:
 *
 *  1. Every ledger entry has a SIGNED effect on `Customer.balance`
 *     (positive balance = the customer owes the shop). PURCHASE adds debt,
 *     PAYMENT/REFUND reduce it, and ADJUSTMENT carries its own sign — a
 *     negative ADJUSTMENT reduces the balance, a positive one increases it.
 *     (Previously ADJUSTMENT was a no-op, so manual corrections never moved the
 *     balance.)
 *
 *  2. An entry that would push the balance ABOVE the customer's `creditLimit`
 *     is flagged so the caller can reject it (or let an owner override). Only
 *     entries that INCREASE outstanding debt can breach the limit; payments and
 *     refunds always pass. A `creditLimit <= 0` means "no limit configured" and
 *     is treated as unlimited.
 */

/** Round to 2 decimals to keep float money comparisons stable. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Signed change this ledger entry applies to `Customer.balance`.
 * Positive = customer owes more; negative = customer owes less.
 *
 * @throws if `type` is not a known CreditType — we never silently swallow an
 *         unknown type and leave the balance untouched (that was bug #2).
 */
export function creditBalanceChange(type: CreditType, amount: number): number {
  switch (type) {
    case 'PURCHASE':
      return amount; // bought on credit — owes more
    case 'PAYMENT':
      return -amount; // paid down the balance
    case 'REFUND':
      return -amount; // money returned to the customer
    case 'ADJUSTMENT':
      return amount; // signed: + increases debt, - reduces it
    default:
      throw new Error(`Unknown credit type: ${type as string}`);
  }
}

export interface CreditEvaluation {
  /** Signed amount applied to the balance. */
  balanceChange: number;
  /** Balance after the entry is applied. */
  newBalance: number;
  /** True if applying this entry would push the balance past the credit limit. */
  exceedsLimit: boolean;
}

/**
 * Evaluate a proposed credit entry against the customer's current balance and
 * credit limit. Pure — does not touch the DB.
 */
export function evaluateCredit(params: {
  type: CreditType;
  amount: number;
  currentBalance: number;
  creditLimit: number;
}): CreditEvaluation {
  const balanceChange = creditBalanceChange(params.type, params.amount);
  const newBalance = round2(params.currentBalance + balanceChange);

  // A limit of 0 (the schema default) or below means "no limit configured".
  const hasLimit = params.creditLimit > 0;
  const exceedsLimit =
    hasLimit && balanceChange > 0 && newBalance > round2(params.creditLimit);

  return { balanceChange, newBalance, exceedsLimit };
}

/** Format an amount with the shop's currency symbol, e.g. "E1,250.00". */
function money(symbol: string, amount: number): string {
  return `${symbol}${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Thrown when a ledger entry would push a customer past their credit limit.
 *
 * Carries the numbers so the HTTP layer can emit the same machine-readable
 * `CREDIT_LIMIT_EXCEEDED` contract that POST /customers/:id/credit already
 * returns (code + meta), instead of the caller string-matching a message.
 * Used by the POS credit-sale path, where — unlike the manual ledger endpoint —
 * there is no owner override: an over-limit sale is simply refused.
 */
export class CreditLimitExceededError extends Error {
  readonly creditLimit: number;
  readonly currentBalance: number;
  readonly attemptedBalance: number;

  constructor(params: {
    customerName: string;
    currencySymbol: string;
    amount: number;
    creditLimit: number;
    currentBalance: number;
    attemptedBalance: number;
  }) {
    super(
      `Credit limit exceeded: this credit entry of ${money(
        params.currencySymbol,
        params.amount,
      )} ` +
        `would raise ${params.customerName}'s balance to ` +
        `${money(
          params.currencySymbol,
          params.attemptedBalance,
        )}, over their ` +
        `${money(params.currencySymbol, params.creditLimit)} limit. ` +
        `Take a payment towards their account or raise their limit first.`,
    );
    this.name = 'CreditLimitExceededError';
    this.creditLimit = params.creditLimit;
    this.currentBalance = params.currentBalance;
    this.attemptedBalance = params.attemptedBalance;
  }
}

/** Acquire before creating rows with customer foreign keys, avoiding lock upgrades. */
export async function lockCustomerCredit(
  tx: Prisma.TransactionClient,
  entry: { customerId: string; shopId: string },
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${entry.customerId}
    AND "shopId" = ${entry.shopId} FOR UPDATE`;
}

/** Lock before reading: every debt writer shares this lock until its transaction commits.
 * Keep the ledger and balance mutation in the caller's transaction (including sales).
 */
export async function applyCustomerCredit(
  tx: Prisma.TransactionClient,
  entry: {
    shopId: string;
    customerId: string;
    type: CreditType;
    amount: number;
    userId?: string;
    note?: string;
    saleId?: string;
    returnId?: string;
    collectionMethod?: CollectionMethod;
    collectionKey?: string;
  },
  options: { currencySymbol: string; override?: boolean; role?: string },
) {
  const replay = async () => {
    const prior = await tx.customerCredit.findUnique({
      where: { shopId_collectionKey: { shopId: entry.shopId, collectionKey: entry.collectionKey! } },
    });
    if (!prior) return null;
    if (prior.customerId !== entry.customerId || prior.type !== entry.type ||
        prior.amount !== entry.amount || prior.collectionMethod !== entry.collectionMethod ||
        (prior.note ?? '') !== (entry.note ?? '') || (prior.saleId ?? '') !== (entry.saleId ?? '')) {
      throw new Error('Collection retry key was already used for a different entry');
    }
    const customer = await tx.customer.findFirstOrThrow({ where: { id: entry.customerId, shopId: entry.shopId } });
    return { credit: prior, newBalance: customer.balance, balanceChange: 0 };
  };
  let cashSessionId: string | undefined;
  if (entry.type === 'PAYMENT') {
    if (!entry.collectionKey || !['CASH', 'EXTERNAL_NONCASH'].includes(entry.collectionMethod ?? '') ||
        !Number.isFinite(entry.amount) || entry.amount <= 0) {
      throw new Error('Payment requires an explicit collection method, positive amount and retry key');
    }
    const prior = await replay();
    if (prior) return prior;
    // Same ordering as checkout/refunds: till, then customer. Close shares this till lock.
    if (entry.collectionMethod === 'CASH') {
      cashSessionId = await CashSessionService.lockOpenSessionId(tx, entry.shopId) ?? undefined;
      if (!cashSessionId) {
        const prior = await replay();
        if (prior) return prior;
        throw new Error('Open a till before collecting cash');
      }
    }
  } else if (entry.collectionMethod || entry.collectionKey) {
    throw new Error('Only customer payments may have collection attribution');
  }
  await lockCustomerCredit(tx, entry);
  if (entry.type === 'PAYMENT') {
    const prior = await replay();
    if (prior) return prior;
  }
  const customer = await tx.customer.findFirst({
    where: { id: entry.customerId, shopId: entry.shopId },
  });
  if (!customer) throw new Error('Customer not found');
  if (entry.saleId && !(await tx.sale.findFirst({ where: { id: entry.saleId, shopId: entry.shopId, customerId: entry.customerId } }))) {
    throw new Error('Sale not found for this customer and shop');
  }
  const evaluation = evaluateCredit({
    type: entry.type,
    amount: entry.amount,
    currentBalance: customer.balance,
    creditLimit: customer.creditLimit,
  });
  if (
    evaluation.exceedsLimit &&
    !(options.override === true && options.role === 'OWNER')
  ) {
    throw new CreditLimitExceededError({
      customerName: customer.name,
      currencySymbol: options.currencySymbol,
      amount: entry.amount,
      creditLimit: customer.creditLimit,
      currentBalance: customer.balance,
      attemptedBalance: evaluation.newBalance,
    });
  }
  const credit = await tx.customerCredit.create({ data: { ...entry, cashSessionId } });
  const updatedCustomer = await tx.customer.update({
    where: { id: customer.id },
    data: { balance: { increment: evaluation.balanceChange } },
  });
  return {
    credit,
    newBalance: updatedCustomer.balance,
    balanceChange: evaluation.balanceChange,
  };
}
