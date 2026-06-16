import { Response } from 'express';
import Joi from 'joi';
import { prisma } from '@config/prisma';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';
import { YeboLinkClient } from '@services/yebolink.client';
import { evaluateCredit } from '@services/customerCredit.service';

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

      const customer = await prisma.customer.findFirst({
        where: { id, shopId: req.user.shopId },
        include: { shop: { select: { currencySymbol: true } } },
      });

      if (!customer) {
        ApiResponse.notFound(res, 'Customer not found');
        return;
      }

      // Compute the signed balance change and check it against the credit limit.
      const { balanceChange, newBalance, exceedsLimit } = evaluateCredit({
        type,
        amount,
        currentBalance: customer.balance,
        creditLimit: customer.creditLimit,
      });

      // Reject entries that would push the customer over their credit limit,
      // unless a shop OWNER explicitly overrides. Surface a loud, specific error
      // so the cashier knows exactly why it was blocked (no silent fallback).
      if (exceedsLimit) {
        const isOwner = req.user.role === 'OWNER';
        if (!(override === true && isOwner)) {
          const symbol = customer.shop?.currencySymbol ?? '';
          const label = CREDIT_TYPE_LABEL[type] ?? type;
          const base =
            `Credit limit exceeded: this ${label} of ${money(symbol, amount)} would raise ` +
            `${customer.name}'s balance to ${money(symbol, newBalance)}, over their ` +
            `${money(symbol, customer.creditLimit)} limit.`;
          const hint = isOwner
            ? ' Re-submit with override=true to force it through.'
            : ' An owner must approve to override.';
          ApiResponse.error(res, base + hint, 422, {
            code: 'CREDIT_LIMIT_EXCEEDED',
            creditLimit: customer.creditLimit,
            currentBalance: customer.balance,
            attemptedBalance: newBalance,
            requiresOverride: true,
          });
          return;
        }
      }

      const [credit, updatedCustomer] = await prisma.$transaction([
        prisma.customerCredit.create({
          data: {
            shopId: req.user.shopId,
            customerId: id,
            type,
            amount,
            note,
            saleId,
            userId: req.user.id,
          },
        }),
        prisma.customer.update({
          where: { id },
          data: { balance: { increment: balanceChange } },
        }),
      ]);

      ApiResponse.success(
        res,
        { credit, newBalance: updatedCustomer.balance, balanceChange },
        'Credit entry added',
      );
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
