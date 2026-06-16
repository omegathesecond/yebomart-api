import { CreditType } from '@prisma/client';

/**
 * Customer-credit money rules.
 *
 * Two invariants live here (extracted from the controller so they can be unit
 * tested without a DB):
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
