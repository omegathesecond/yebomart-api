import { Response } from 'express';
import Joi from 'joi';
import { prisma } from '@config/prisma';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';
import { YeboLinkClient } from '@services/yebolink.client';
import { evaluateCredit } from '@services/customerCredit.service';

/**
 * Thrown INSIDE the addCredit transaction when the locked re-read shows the
 * entry would breach the credit limit. Carries the authoritative (locked)
 * figures so the caller can build the 422 + machine-readable meta. Throwing
 * (rather than returning) ensures the surrounding $transaction rolls back the
 * row lock and any partial write.
 */
class CreditLimitExceededError extends Error {
  constructor(
    public readonly meta: {
      creditLimit: number;
      currentBalance: number;
      attemptedBalance: number;
    },
  ) {
    super('CREDIT_LIMIT_EXCEEDED');
    this.name = 'CreditLimitExceededError';
  }
}

/** Thrown if the customer row vanished between the existence check and the lock. */
class CustomerGoneError extends Error {
  constructor() {
    super('Customer not found');
    this.name = 'CustomerGoneError';
  }
}

export const createCustomerSchema = Joi.object({
  name: Joi.string().required().trim().min(2).max(100),
  phone: Joi.string().optional().trim(),
  email: Joi.string().optional().email(),
  address: Joi.string().optional().max(500),
  creditLimit: Joi.number().optional().min(0).default(0),
});

export const addCreditSchema = Joi.object({
  type: Joi.string().required().valid('PURCHASE', 'PAYMENT', 'ADJUSTMENT', 'REFUND'),
  // ADJUSTMENT carries its own sign (a negative amount reduces the balance), so
  // it's the only type allowed to be negative. It must be non-zero — a zero
  // adjustment is a no-op. Everything else is a non-negative magnitude.
  amount: Joi.when('type', {
    is: 'ADJUSTMENT',
    then: Joi.number().required().invalid(0),
    otherwise: Joi.number().required().min(0),
  }),
  note: Joi.string().optional().max(500),
  saleId: Joi.string().optional(),
  // Set true to push an entry through even if it breaches the credit limit.
  // Honoured only for shop OWNERs (see addCredit) — cashiers/managers cannot
  // self-approve over-limit credit.
  override: Joi.boolean().optional().default(false),
});

export const sendStatementSchema = Joi.object({
  // reminder=true sends a short "please settle" nudge; default sends the full
  // statement (balance + recent ledger entries).
  reminder: Joi.boolean().optional().default(false),
});

const CREDIT_TYPE_LABEL: Record<string, string> = {
  PURCHASE: 'Purchase',
  PAYMENT: 'Payment',
  ADJUSTMENT: 'Adjustment',
  REFUND: 'Refund',
};

/** Format an amount with the shop's currency symbol, e.g. "E1,250.00". */
function money(symbol: string, amount: number): string {
  return `${symbol}${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function shortDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

interface StatementCredit {
  type: string;
  amount: number;
  createdAt: Date;
}

/**
 * Build the customer-facing WhatsApp/SMS message. Balance is "positive = they
 * owe us" (see Customer.balance). Kept concise — it may be delivered as an SMS.
 */
function buildStatementMessage(
  reminder: boolean,
  customerName: string,
  shopName: string,
  currencySymbol: string,
  balance: number,
  recent: StatementCredit[],
): string {
  const firstName = customerName.split(' ')[0] || customerName;
  const lines: string[] = [];

  if (reminder) {
    if (balance > 0) {
      lines.push(
        `Hi ${firstName}, a friendly reminder from ${shopName}: your outstanding balance is ${money(currencySymbol, balance)}. Please settle when you can. Thank you!`,
      );
    } else if (balance < 0) {
      lines.push(
        `Hi ${firstName}, your account at ${shopName} is in credit by ${money(currencySymbol, -balance)}. Nothing owed — thank you!`,
      );
    } else {
      lines.push(`Hi ${firstName}, your account at ${shopName} is fully settled. Thank you!`);
    }
    return lines.join('\n');
  }

  // Full statement.
  lines.push(`Hi ${firstName}, here is your account statement with ${shopName}.`);
  if (balance > 0) {
    lines.push(`Balance owing: ${money(currencySymbol, balance)}`);
  } else if (balance < 0) {
    lines.push(`Balance: ${money(currencySymbol, -balance)} in credit`);
  } else {
    lines.push('Balance: fully settled');
  }

  if (recent.length > 0) {
    lines.push('');
    lines.push('Recent activity:');
    recent.forEach((c) => {
      const label = CREDIT_TYPE_LABEL[c.type] ?? c.type;
      lines.push(`• ${shortDate(c.createdAt)} ${label} ${money(currencySymbol, c.amount)}`);
    });
  }

  if (balance > 0) {
    lines.push('');
    lines.push('Please settle your outstanding balance. Thank you!');
  }

  return lines.join('\n');
}

export class CustomerController {
  /**
   * Create customer
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const customer = await prisma.customer.create({
        data: {
          shopId: req.user.shopId,
          ...req.body,
        },
      });

      ApiResponse.created(res, customer, 'Customer created');
    } catch (error: any) {
      if (error.code === 'P2002') {
        ApiResponse.conflict(res, 'Customer with this phone already exists');
      } else {
        ApiResponse.badRequest(res, error.message);
      }
    }
  }

  /**
   * List customers
   */
  static async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { search, hasBalance } = req.query;

      const where: any = { shopId: req.user.shopId, isActive: true };
      if (search) {
        where.OR = [
          { name: { contains: search as string, mode: 'insensitive' } },
          { phone: { contains: search as string } },
        ];
      }
      if (hasBalance === 'true') {
        where.balance = { gt: 0 };
      }

      const customers = await prisma.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        include: {
          _count: { select: { sales: true, credits: true } },
        },
      });

      // Calculate total owed
      const totalOwed = customers.reduce((sum, c) => sum + (c.balance > 0 ? c.balance : 0), 0);

      ApiResponse.success(res, { customers, totalOwed });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get customer details
   */
  static async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const customer = await prisma.customer.findFirst({
        where: { id: req.params.id, shopId: req.user.shopId },
        include: {
          credits: {
            orderBy: { createdAt: 'desc' },
            take: 50,
          },
          sales: {
            orderBy: { createdAt: 'desc' },
            take: 20,
            include: { items: true },
          },
        },
      });

      if (!customer) {
        ApiResponse.notFound(res, 'Customer not found');
        return;
      }

      ApiResponse.success(res, customer);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Add credit entry (payment or purchase)
   */
  static async addCredit(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;
      const { type, amount, note, saleId, override } = req.body;
      const { shopId } = req.user;
      const isOwner = req.user.role === 'OWNER';

      // Existence check + currency symbol for the error message. The
      // authoritative balance/limit used for the limit decision is re-read
      // INSIDE the transaction under a row lock (below) — the value here is NOT
      // trusted for enforcement, only for scoping and message formatting.
      const customer = await prisma.customer.findFirst({
        where: { id, shopId },
        include: { shop: { select: { currencySymbol: true } } },
      });

      if (!customer) {
        ApiResponse.notFound(res, 'Customer not found');
        return;
      }

      // The credit-limit check and the balance write MUST be atomic, or two
      // concurrent over-limit entries can each pass the check against the same
      // stale balance and then both increment, silently breaching the limit
      // (TOCTOU). We re-read the balance/limit INSIDE the transaction holding a
      // `SELECT … FOR UPDATE` row lock: the second concurrent request blocks on
      // the lock until the first commits, then re-evaluates against the
      // already-incremented balance and is correctly rejected.
      let result;
      try {
        result = await prisma.$transaction(async (tx) => {
          // Acquire the row lock. We don't read from this statement's result —
          // existence was already confirmed above and we re-read the fresh
          // balance via the ORM below; this purely serialises concurrent
          // writers on this customer.
          await tx.$queryRaw`SELECT 1 FROM "Customer" WHERE id = ${id} AND "shopId" = ${shopId} FOR UPDATE`;

          // Authoritative, post-lock read of the values the limit decision
          // hinges on. Under the lock this reflects any concurrent entry that
          // committed before us.
          const locked = await tx.customer.findFirst({
            where: { id, shopId },
            select: { balance: true, creditLimit: true },
          });
          if (!locked) {
            throw new CustomerGoneError();
          }

          const { balanceChange, newBalance, exceedsLimit } = evaluateCredit({
            type,
            amount,
            currentBalance: locked.balance,
            creditLimit: locked.creditLimit,
          });

          // Reject entries that would push the customer over their credit
          // limit, unless a shop OWNER explicitly overrides. Throw so the whole
          // transaction (lock + any write) rolls back; handled just below.
          if (exceedsLimit && !(override === true && isOwner)) {
            throw new CreditLimitExceededError({
              creditLimit: locked.creditLimit,
              currentBalance: locked.balance,
              attemptedBalance: newBalance,
            });
          }

          const credit = await tx.customerCredit.create({
            data: {
              shopId,
              customerId: id,
              type,
              amount,
              note,
              saleId,
              userId: req.user!.id,
            },
          });
          const updatedCustomer = await tx.customer.update({
            where: { id },
            data: { balance: { increment: balanceChange } },
          });

          return { credit, newBalance: updatedCustomer.balance, balanceChange };
        });
      } catch (txError) {
        // Over-limit is a loud, specific 422 (no silent fallback). Built here
        // where `customer` (for currency/name) and `isOwner` are in scope.
        if (txError instanceof CreditLimitExceededError) {
          const symbol = customer.shop?.currencySymbol ?? '';
          const label = CREDIT_TYPE_LABEL[type] ?? type;
          const base =
            `Credit limit exceeded: this ${label} of ${money(symbol, amount)} would raise ` +
            `${customer.name}'s balance to ${money(symbol, txError.meta.attemptedBalance)}, over their ` +
            `${money(symbol, txError.meta.creditLimit)} limit.`;
          const hint = isOwner
            ? ' Re-submit with override=true to force it through.'
            : ' An owner must approve to override.';
          // Machine-readable signal rides the PUBLIC code/meta channel (not the
          // dev-only `error` arg) so the POS can detect over-limit /
          // needs-override in production without parsing the human message.
          ApiResponse.error(res, base + hint, 422, undefined, {
            code: 'CREDIT_LIMIT_EXCEEDED',
            meta: {
              requiresOverride: true,
              creditLimit: txError.meta.creditLimit,
              currentBalance: txError.meta.currentBalance,
              attemptedBalance: txError.meta.attemptedBalance,
            },
          });
          return;
        }
        if (txError instanceof CustomerGoneError) {
          ApiResponse.notFound(res, 'Customer not found');
          return;
        }
        throw txError;
      }

      ApiResponse.success(res, result, 'Credit entry added');
    } catch (error: any) {
      ApiResponse.badRequest(res, error.message);
    }
  }

  /**
   * Update customer
   */
  static async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const customer = await prisma.customer.updateMany({
        where: { id: req.params.id, shopId: req.user.shopId },
        data: req.body,
      });

      if (customer.count === 0) {
        ApiResponse.notFound(res, 'Customer not found');
        return;
      }

      ApiResponse.success(res, null, 'Customer updated');
    } catch (error: any) {
      ApiResponse.badRequest(res, error.message);
    }
  }

  /**
   * Send the customer their account statement (or a short payment reminder) via
   * WhatsApp, falling back to SMS, through YeboLink. On-demand collection tool
   * for shops running book accounts. Manager-gated at the route level.
   *
   * No silent fallback (CLAUDE.md): if YeboLink can't deliver on EITHER channel
   * the error propagates as a 5xx so the POS shows a real failure — we never
   * report "sent" for a message that wasn't.
   */
  static async sendStatement(req: AuthRequest, res: Response): Promise<void> {
    if (!req.user) {
      ApiResponse.unauthorized(res, 'Unauthorized');
      return;
    }

    const { id } = req.params;
    const reminder: boolean = req.body?.reminder === true;

    let customer;
    try {
      customer = await prisma.customer.findFirst({
        where: { id, shopId: req.user.shopId },
        include: {
          shop: { select: { name: true, currencySymbol: true } },
          credits: { orderBy: { createdAt: 'desc' }, take: 5 },
        },
      });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message);
      return;
    }

    if (!customer) {
      ApiResponse.notFound(res, 'Customer not found');
      return;
    }

    const phone = customer.phone?.trim();
    if (!phone) {
      ApiResponse.badRequest(res, 'Customer has no phone number on file');
      return;
    }

    const message = buildStatementMessage(
      reminder,
      customer.name,
      customer.shop.name,
      customer.shop.currencySymbol,
      customer.balance,
      customer.credits,
    );

    try {
      const result = await YeboLinkClient.sendTextWithFallback(phone, message);
      ApiResponse.success(
        res,
        { channel: result.channel, messageId: result.messageId, balance: customer.balance },
        `${reminder ? 'Reminder' : 'Statement'} sent via ${result.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}`,
      );
    } catch (error: any) {
      // YeboLink failed on both WhatsApp and SMS — surface loudly (no fallback).
      ApiResponse.serverError(res, `Failed to send ${reminder ? 'reminder' : 'statement'}: ${error?.message ?? 'YeboLink error'}`);
    }
  }
}
