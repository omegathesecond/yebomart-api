import { prisma } from '@config/prisma';
import { ExpenseCategory, ExpenseFundingSource } from '@prisma/client';
import { CashSessionService } from './cashSession.service';

export class ExpensePayoutRejectedError extends Error {
  readonly code = 'EXPENSE_PAYOUT_NOT_RECORDED';
}

interface ExpenseInput {
  category: ExpenseCategory;
  amount: number;
  description?: string;
  date: Date | string;
  receiptUrl?: string;
  fundingSource: ExpenseFundingSource;
  cashSessionId?: string;
  submissionKey: string;
}

/** One expense row is both the profit expense and the drawer payout, never two postings. */
export async function recordExpense(shopId: string, input: ExpenseInput) {
  if (!['OUTSIDE_TILL', 'TILL_CASH'].includes(input.fundingSource) || !input.submissionKey ||
      !Number.isFinite(input.amount) || input.amount <= 0 ||
      (input.fundingSource === 'TILL_CASH' ? !input.cashSessionId : !!input.cashSessionId)) {
    throw new Error('Choose a funding source, positive amount and retry key; till cash requires a till session');
  }
  return prisma.$transaction(async tx => {
    // Serialize duplicate requests even for outside-till payments. Key is shop-scoped;
    // the unique index remains the database authority. Acquire before the till lock.
    await CashSessionService.lockPayoutSubmission(tx, shopId, input.submissionKey);
    const prior = await tx.expense.findFirst({ where: { shopId, submissionKey: input.submissionKey } });
    if (prior) {
      if (prior.category !== input.category || prior.amount !== input.amount ||
          (prior.description ?? '') !== (input.description ?? '') ||
          new Date(prior.date).getTime() !== new Date(input.date).getTime() ||
          (prior.receiptUrl ?? '') !== (input.receiptUrl ?? '') ||
          prior.fundingSource !== input.fundingSource ||
          (prior.cashSessionId ?? null) !== (input.cashSessionId ?? null)) {
        throw new Error('Retry key belongs to a different expense; retry the unchanged entry');
      }
      return prior; // Includes retries after close, without touching another till.
    }
    if (input.fundingSource === 'TILL_CASH') {
      await CashSessionService.lockPayoutTill(tx, shopId, input.cashSessionId!, new ExpensePayoutRejectedError('Till is closed or unavailable; expense payout was not recorded. Open a till in this shop before paying an expense from it.'));
    }
    return tx.expense.create({ data: { ...input, date: new Date(input.date), shopId } });
  });
}
