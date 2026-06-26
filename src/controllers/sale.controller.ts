import { Response } from 'express';
import Joi from 'joi';
import { SaleService } from '@services/sale.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';
import { YeboLinkClient } from '@services/yebolink.client';

export const createSaleSchema = Joi.object({
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().required().integer().min(1),
      discount: Joi.number().optional().min(0).default(0),
    })
  ).required().min(1),
  paymentMethod: Joi.string().required().valid('CASH', 'MOMO', 'EMALI', 'CARD', 'MIXED', 'CREDIT'),
  amountPaid: Joi.number().required().min(0),
  discount: Joi.number().optional().min(0).default(0),
  // Optional link to a Customer (Sale.customerId). Enables POS to attach a buyer
  // so the sale shows up in that customer's purchase history / lifetime value.
  customerId: Joi.string().optional().allow(null),
  localId: Joi.string().optional(),
  offlineAt: Joi.date().optional(),
});

export const listSalesSchema = Joi.object({
  page: Joi.number().optional().integer().min(1).default(1),
  limit: Joi.number().optional().integer().min(1).max(100).default(20),
  status: Joi.string().optional().valid('PENDING', 'COMPLETED', 'VOIDED', 'REFUNDED'),
  paymentMethod: Joi.string().optional().valid('CASH', 'MOMO', 'EMALI', 'CARD', 'MIXED', 'CREDIT'),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  userId: Joi.string().optional(),
});

export const voidSaleSchema = Joi.object({
  reason: Joi.string().required().min(5).max(500),
});

/**
 * SMS receipt request. Identify the sale by saleId (preferred) OR receiptNumber,
 * and supply the customer phone to text it to. The phone is normalized
 * (whitespace/dashes/parens stripped) and validated as a plausible E.164-ish
 * number before it reaches YeboLink, which requires E.164.
 */
export const smsReceiptSchema = Joi.object({
  saleId: Joi.string().optional(),
  receiptNumber: Joi.string().optional(),
  phone: Joi.string()
    .required()
    .custom((value: string, helpers) => {
      const cleaned = String(value).replace(/[\s\-()]/g, '');
      // Optional leading +, then 7–15 digits (E.164 caps at 15).
      if (!/^\+?[1-9]\d{6,14}$/.test(cleaned)) {
        return helpers.error('any.invalid');
      }
      return cleaned;
    }, 'phone normalization')
    .messages({ 'any.invalid': 'A valid phone number is required' }),
}).or('saleId', 'receiptNumber');

/** Format an amount with the shop's currency symbol, e.g. "E1,250.00". */
function money(symbol: string, amount: number): string {
  return `${symbol}${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function receiptDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const PAYMENT_LABEL: Record<string, string> = {
  CASH: 'Cash',
  MOMO: 'MoMo',
  EMALI: 'eMali',
  CARD: 'Card',
  MIXED: 'Mixed',
  CREDIT: 'Credit (pay later)',
};

interface SmsReceiptItem {
  productName: string;
  quantity: number;
  totalPrice: number;
}

/**
 * Build a concise SMS receipt. Kept short on purpose (it's an SMS): shop name,
 * receipt #, date, a capped list of line items, the total, and how it was paid.
 * Currency comes from the shop's configured symbol so it's locale-correct
 * (SZL → "E", etc.).
 */
function buildSmsReceiptMessage(
  shopName: string,
  currencySymbol: string,
  sale: {
    id: string;
    receiptNumber: string | null;
    createdAt: Date;
    totalAmount: number;
    paymentMethod: string;
    items: SmsReceiptItem[];
  },
): string {
  const lines: string[] = [];
  lines.push(shopName);
  lines.push(`Receipt ${sale.receiptNumber ?? sale.id.slice(-8).toUpperCase()}`);
  lines.push(receiptDate(sale.createdAt));

  const MAX_ITEMS = 6;
  sale.items.slice(0, MAX_ITEMS).forEach((it) => {
    lines.push(`${it.quantity}x ${it.productName} ${money(currencySymbol, it.totalPrice)}`);
  });
  if (sale.items.length > MAX_ITEMS) {
    lines.push(`…and ${sale.items.length - MAX_ITEMS} more item(s)`);
  }

  lines.push(`Total: ${money(currencySymbol, sale.totalAmount)}`);
  lines.push(`Paid: ${PAYMENT_LABEL[sale.paymentMethod] ?? sale.paymentMethod}`);
  lines.push('Thank you!');
  return lines.join('\n');
}

export class SaleController {
  /**
   * Create a new sale
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const sale = await SaleService.create({
        ...req.body,
        shopId: req.user.shopId,
        userId: req.user.type === 'user' ? req.user.id : undefined,
      });

      ApiResponse.created(res, sale, 'Sale completed successfully');
    } catch (error: any) {
      if (error.message.includes('Insufficient')) {
        ApiResponse.badRequest(res, error.message);
      } else if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * List sales
   */
  static async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      // Parse dates if provided
      const params: any = { ...req.query, shopId: req.user.shopId };
      if (params.startDate) {
        params.startDate = new Date(params.startDate);
      }
      if (params.endDate) {
        params.endDate = new Date(params.endDate);
      }

      const result = await SaleService.list(params);

      ApiResponse.success(res, result.sales, undefined, 200, {
        total: result.total,
        page: result.page,
        limit: result.limit,
        hasNext: result.hasNext,
        hasPrev: result.hasPrev,
      });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get sale by ID
   */
  static async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;
      const sale = await SaleService.getById(id, req.user.shopId);
      ApiResponse.success(res, sale);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Void a sale
   */
  static async voidSale(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      // Check permission
      if (req.user.type === 'user') {
        // Would need to check user permissions here
        // For now, only owner and managers can void
        if (req.user.role === 'CASHIER') {
          ApiResponse.forbidden(res, 'You do not have permission to void sales');
          return;
        }
      }

      const { id } = req.params;
      const { reason } = req.body;

      // StockLog.userId is a real User FK; only staff tokens carry a User id.
      // A shop-owner token's `id` is the Shop id, so leave userId null for it.
      const userId = req.user.type === 'user' ? req.user.id : undefined;

      const sale = await SaleService.voidSale(
        id,
        req.user.shopId,
        userId,
        reason
      );

      ApiResponse.success(res, sale, 'Sale voided successfully');
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.badRequest(res, error.message, error);
      }
    }
  }

  /**
   * Get daily summary
   */
  static async getDailySummary(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const date = req.query.date ? new Date(req.query.date as string) : undefined;
      const summary = await SaleService.getDailySummary(req.user.shopId, date);
      ApiResponse.success(res, summary);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Search sale by receipt number
   */
  static async searchByReceipt(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { receiptNumber } = req.query;
      if (!receiptNumber) {
        ApiResponse.badRequest(res, 'Receipt number is required');
        return;
      }

      const sale = await SaleService.getByReceiptNumber(
        receiptNumber as string,
        req.user.shopId
      );
      ApiResponse.success(res, sale);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Email receipt to customer — routes through YeboPay, which creates a
   * PAID-on-creation invoice (the sale already happened), renders a PDF, and
   * delivers via YeboLink. Same external contract as before:
   *   body: { email, customerName?, saleId? }
   * but the line items + totals are now loaded from the Sale row in DB
   * (authoritative) instead of trusted from the request body.
   */
  static async emailReceipt(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { email, customerName, saleId, receiptNumber } = req.body;

      if (!email) {
        ApiResponse.badRequest(res, 'email is required');
        return;
      }
      // Accept saleId OR receiptNumber to identify the sale. saleId is preferred.
      if (!saleId && !receiptNumber) {
        ApiResponse.badRequest(res, 'Either saleId or receiptNumber is required to identify the sale');
        return;
      }

      const { prisma } = await import('@config/prisma');
      const sale = await prisma.sale.findFirst({
        where: saleId
          ? { id: saleId, shopId: req.user.shopId }
          : { receiptNumber: receiptNumber as string, shopId: req.user.shopId },
        include: {
          items: true,
          shop: { select: { name: true, countryCode: true, ownerYeboidSub: true } },
        },
      });

      if (!sale) {
        ApiResponse.notFound(res, 'Sale not found for this shop');
        return;
      }

      const { YeboPayClient } = await import('@services/yebopay.client');

      // Owner's REAL YeboID sub — yebopay attributes the invoice to it so
      // the shop's wallet + invoice ledger unifies under one identity.
      const yeboidSub = sale.shop.ownerYeboidSub;

      // Map sale items → invoice line items (currency comes from the shop's country).
      const { getCurrencyForCountry } = await import('@utils/currencies');
      const currency = getCurrencyForCountry(sale.shop.countryCode);
      const invoiceCurrency = currency.directBillable ? currency.code : 'USD';
      const fxRate = currency.directBillable ? 1 : currency.rate;

      const lineItems = sale.items.map((item: typeof sale.items[number]) => ({
        description: item.productName,
        quantity: item.quantity,
        unitPrice: Math.round((item.unitPrice / fxRate) * 100) / 100,
      }));

      // Create the invoice as PAID — the customer has already paid the shop.
      const invoice = await YeboPayClient.createInvoice({
        yeboidSub,
        currency: invoiceCurrency,
        dueDate: sale.createdAt.toISOString(),  // already paid; due date = sale date
        lineItems,
        toEmail: email,
        toName: typeof customerName === 'string' ? customerName : undefined,
        description: `Receipt from ${sale.shop.name} — sale ${sale.receiptNumber ?? sale.id}`,
        status: 'PAID',
        paidAt: sale.createdAt.toISOString(),
        amountPaid: Math.round((sale.totalAmount / fxRate) * 100) / 100,
        metadata: {
          flow: 'yebomart-pos-receipt',
          saleId: sale.id,
          shopId: sale.shopId,
          paymentMethod: sale.paymentMethod,
        },
      });

      const sent = await YeboPayClient.sendInvoice(invoice.id);

      ApiResponse.success(
        res,
        {
          success: true,
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          pdfUrl: sent.pdf_url,
        },
        'Receipt emailed successfully'
      );
    } catch (error: any) {
      ApiResponse.serverError(res, error?.message ?? 'Failed to send receipt', error);
    }
  }

  /**
   * Text a concise receipt to a customer via the YeboLink SMS gateway. The
   * counterpart to emailReceipt for the (common) case where the customer has a
   * phone but no email. Identify the sale by saleId or receiptNumber; line
   * items + totals are loaded from the Sale row (authoritative), not the body.
   *   body: { saleId? , receiptNumber? , phone }   (validated by smsReceiptSchema)
   *
   * No silent fallback (CLAUDE.md): if YeboLink can't deliver the SMS the error
   * propagates as a 5xx so the POS shows a real failure — we never report
   * "sent" for a message that wasn't.
   */
  static async smsReceipt(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { saleId, receiptNumber, phone } = req.body as {
        saleId?: string;
        receiptNumber?: string;
        phone: string;
      };

      const { prisma } = await import('@config/prisma');
      const sale = await prisma.sale.findFirst({
        where: saleId
          ? { id: saleId, shopId: req.user.shopId }
          : { receiptNumber: receiptNumber as string, shopId: req.user.shopId },
        include: {
          items: true,
          shop: { select: { name: true, currencySymbol: true } },
        },
      });

      if (!sale) {
        ApiResponse.notFound(res, 'Sale not found for this shop');
        return;
      }

      const message = buildSmsReceiptMessage(sale.shop.name, sale.shop.currencySymbol, {
        id: sale.id,
        receiptNumber: sale.receiptNumber,
        createdAt: sale.createdAt,
        totalAmount: sale.totalAmount,
        paymentMethod: sale.paymentMethod,
        items: sale.items.map((item: SmsReceiptItem) => ({
          productName: item.productName,
          quantity: item.quantity,
          totalPrice: item.totalPrice,
        })),
      });

      const result = await YeboLinkClient.sendSMS(phone, message);

      ApiResponse.success(
        res,
        { success: true, messageId: result.messageId, status: result.status },
        'Receipt sent via SMS',
      );
    } catch (error: any) {
      // YeboLink send failed (or env misconfigured) — surface loudly, no fallback.
      ApiResponse.serverError(res, `Failed to send SMS receipt: ${error?.message ?? 'YeboLink error'}`, error);
    }
  }
}
