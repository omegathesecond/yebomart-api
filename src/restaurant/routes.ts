import { Router, Request, Response, NextFunction } from "express";
import Joi from "joi";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { prisma } from "@config/prisma";
import {
  authMiddleware,
  managerAuth,
  ownerAuth,
  AuthRequest,
} from "@middleware/auth.middleware";
import {
  requireEntitlement,
  settlePendingCharge,
} from "@middleware/billing.middleware";
import { CREDIT_COSTS } from "@config/creditPacks";
import { consumeAllowance } from "@services/entitlement.service";
import { ReportService } from "@services/report.service";
import { ProductService } from "@services/product.service";
import { ApiResponse } from "@utils/ApiResponse";
import * as service from "./service";
import { assert, RestaurantError, validateHours } from "./domain";
import { MODULES } from "./capabilities";
import { restaurantAI } from "./ai.client";
import { restaurantReport } from "./reports";

export const restaurantRoutes = Router();
export const workspaceRoutes = Router();
export const publicRestaurantRoutes = Router();
export const publicOrderRoutes = Router();
export const handle =
  (fn: (req: AuthRequest, res: Response) => Promise<unknown>) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof RestaurantError) {
        ApiResponse.error(res, e.message, e.status);
        return;
      }
      if (e instanceof multer.MulterError) {
        ApiResponse.badRequest(
          res,
          "Use one JPG, PNG or WebP menu photo smaller than 6 MB.",
        );
        return;
      }
      if ((e as any)?.code === "P2002") {
        ApiResponse.conflict(
          res,
          "This website name or request is already in use.",
        );
        return;
      }
      console.error(
        "[restaurant]",
        e instanceof Error ? e.message : "Request failed",
      );
      ApiResponse.serverError(
        res,
        "This request could not be completed. Please try again or contact support.",
      );
    }
  };
function read(schema: Joi.Schema, data: unknown): any {
  const result = schema.validate(data, { abortEarly: true, convert: false });
  assert(!result.error, result.error?.details[0]?.message ?? "Check the form.");
  return result.value;
}
const text = (max: number) => Joi.string().trim().max(max);
const phone = Joi.string().pattern(/^\+[1-9]\d{6,14}$/);
const identifier = Joi.string().max(100).required();
const token = (req: Request) => {
  const t = req.header("X-Order-Token");
  assert(
    t && /^[0-9a-f]{64}$/.test(t),
    "Open this order in the browser where it was placed.",
    401,
  );
  return t;
};
const limiter = rateLimit({
  windowMs: 15 * 60000,
  limit: 40,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please wait before trying again.",
  },
});
const aiLimiter = rateLimit({
  windowMs: 15 * 60000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Please wait before asking another menu question.",
  },
});
workspaceRoutes.use(authMiddleware);
workspaceRoutes.get(
  "/",
  handle(async (req, res) => {
    const c = await service.context(
      req.user!.shopId,
      req.user!.role,
      req.user!.type === "user" ? req.user!.id : undefined,
    );
    ApiResponse.success(res, {
      modules: c.modules,
      choices: MODULES,
      role: c.role,
      kitchen: c.kitchen,
      navigation: c.navigation,
      businessType: c.shop.businessType,
      restaurantConfigured: !!c.restaurant,
    });
  }),
);
workspaceRoutes.put(
  "/",
  ownerAuth,
  handle(async (req, res) => {
    const data = read(
      Joi.object({
        modules: Joi.array()
          .items(Joi.string().valid(...MODULES))
          .unique()
          .min(1)
          .required(),
      }),
      req.body,
    );
    await prisma.businessWorkspace.upsert({
      where: { shopId: req.user!.shopId },
      create: { shopId: req.user!.shopId, ...data },
      update: data,
    });
    ApiResponse.success(res, { saved: true });
  }),
);
workspaceRoutes.get(
  "/overview",
  handle(async (req, res) => {
    const c = await service.context(
      req.user!.shopId,
      req.user!.role,
      req.user!.type === "user" ? req.user!.id : undefined,
    );
    const operational =
      c.modules.includes("restaurant") && c.restaurant
        ? await prisma.restaurantTicket.groupBy({
            by: ["status"],
            where: {
              shopId: c.shop.id,
              status: { notIn: ["COMPLETED", "CANCELLED"] },
            },
            _count: true,
          })
        : null;
    let financial = null;
    if (!c.kitchen && c.role !== "CASHIER" && c.modules.includes("reports")) {
      const report = await ReportService.getDailyReport(c.shop.id);
      const unknownCost = await prisma.product.count({
        where: {
          shopId: c.shop.id,
          isActive: true,
          attributes: { path: ["costStatus"], equals: "unknown" },
        },
      });
      financial = {
        ...report.summary,
        stock: c.modules.includes("stock") ? report.stock : null,
        profitComplete: report.summary.profitComplete && unknownCost === 0,
      };
    }
    ApiResponse.success(res, {
      name: c.shop.name,
      currency: c.shop.currency,
      kitchen: c.kitchen,
      role: c.role,
      financial,
      operational,
      website: c.restaurant
        ? {
            published: c.restaurant.published,
            acceptingOrders: c.restaurant.acceptingOrders,
            slug: c.restaurant.slug,
          }
        : null,
      navigation: c.navigation,
    });
  }),
);
restaurantRoutes.use(authMiddleware);
restaurantRoutes.get(
  "/",
  managerAuth,
  handle(async (req, res) => {
    const p = await prisma.restaurantProfile.findUnique({
      where: { shopId: req.user!.shopId },
    });
    ApiResponse.success(
      res,
      p
        ? {
            ...service.safeProfile(p),
            items: await service.menu(await service.profile(p.shopId)),
          }
        : null,
    );
  }),
);
const profileSchema = Joi.object({
  slug: Joi.string()
    .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .min(3)
    .max(60)
    .required(),
  description: text(1500).allow("").required(),
  publicPhone: phone.required(),
  published: Joi.boolean().required(),
  acceptingOrders: Joi.boolean().required(),
  hours: Joi.array()
    .items(
      Joi.object({
        day: Joi.number().integer().min(0).max(6).required(),
        open: text(5).required(),
        close: text(5).required(),
      }),
    )
    .min(1)
    .max(21)
    .required(),
  leadMinutes: Joi.number().integer().min(0).max(1440).required(),
  slotMinutes: Joi.number().valid(5, 10, 15, 20, 30, 60).required(),
  slotCapacity: Joi.number().integer().min(1).max(500).required(),
  tables: Joi.array().items(text(40).required()).unique().max(100).required(),
  menuProductIds: Joi.array().items(identifier).unique().max(100).required(),
  unavailableProductIds: Joi.array()
    .items(identifier)
    .unique()
    .max(100)
    .required(),
  allowCash: Joi.boolean().required(),
  allowOnline: Joi.boolean().required(),
  allowAssistant: Joi.boolean().required(),
});
restaurantRoutes.put(
  "/",
  managerAuth,
  handle(async (req, res) => {
    const data = read(profileSchema, req.body),
      shopId = req.user!.shopId;
    validateHours(data.hours);
    const current = await prisma.restaurantProfile.findUnique({
      where: { shopId },
    });
    assert(
      !current?.published || current.slug === data.slug,
      "Unpublish the website before changing its address.",
      409,
    );
    assert(
      data.unavailableProductIds.every((id: string) =>
        data.menuProductIds.includes(id),
      ),
      "An unavailable item must belong to your menu.",
    );
    const count = await prisma.product.count({
      where: { shopId, id: { in: data.menuProductIds }, isActive: true },
    });
    assert(
      count === data.menuProductIds.length,
      "Choose active products from this business.",
    );
    assert(
      !data.allowOnline || current?.paymentCredential,
      "Connect your restaurant’s YeboPay key first.",
    );
    assert(
      data.allowCash || data.allowOnline,
      "Choose at least one payment option.",
    );
    assert(
      !data.published || count > 0,
      "Add and review your menu before publishing.",
    );
    assert(
      !data.acceptingOrders || data.published,
      "Publish the website before opening orders.",
    );
    const p = await prisma.restaurantProfile.upsert({
      where: { shopId },
      create: { shopId, ...data },
      update: data,
    });
    ApiResponse.success(res, service.safeProfile(p));
  }),
);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) =>
    cb(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)),
}).single("photo");
restaurantRoutes.post(
  "/import",
  managerAuth,
  (req, res, next) =>
    upload(req, res, (e) =>
      e
        ? handle(async () => {
            throw e;
          })(req, res, next)
        : next(),
    ),
  requireEntitlement(
    "AI_QUESTION",
    CREDIT_COSTS.AI_QUESTION,
    "Menu photo import",
  ),
  handle(async (req, res) => {
    const p = await service.profile(req.user!.shopId);
    assert(
      req.file,
      "Choose one clear JPG, PNG or WebP menu photo, up to 6 MB.",
    );
    const result = await restaurantAI("menu-photo", {
      image: req.file.buffer.toString("base64"),
      mime_type: req.file.mimetype,
      currency: p.shop.currency,
    });
    const draft = read(
      Joi.object({
        items: Joi.array()
          .items(
            Joi.object({
              name: text(120).required(),
              price: Joi.number().min(0).max(1000000).allow(null).required(),
              category: text(80).allow("").required(),
              description: text(1000).allow("").required(),
              source: text(1000).required(),
              issues: Joi.array().items(text(500)).max(10).required(),
            }),
          )
          .min(1)
          .max(100)
          .required(),
        warnings: Joi.array().items(text(1000)).max(20).required(),
        model: Joi.string(),
        usage: Joi.any(),
      }),
      { ...result.draft, model: result.model, usage: result.usage },
    );
    const saved = await prisma.restaurantImport.create({
      data: { shopId: p.shopId, draft, productIds: [] },
    });
    await settlePendingCharge(req);
    ApiResponse.success(res, saved);
  }),
);
restaurantRoutes.post(
  "/import/:id/confirm",
  managerAuth,
  handle(async (req, res) => {
    const data = read(
      Joi.object({
        items: Joi.array()
          .items(
            Joi.object({
              name: text(120).required(),
              price: Joi.number().precision(2).min(0).max(1000000).required(),
              cost: Joi.number()
                .precision(2)
                .min(0)
                .max(1000000)
                .allow(null)
                .required(),
              category: text(80).allow("").required(),
              description: text(1000).allow("").required(),
            }),
          )
          .min(1)
          .max(100)
          .required(),
      }),
      req.body,
    );
    ApiResponse.success(
      res,
      await service.confirmImport(req.user!.shopId, req.params.id, data.items),
    );
  }),
);
restaurantRoutes.patch(
  "/menu/:id",
  managerAuth,
  handle(async (req, res) => {
    const data = read(
      Joi.object({
        available: Joi.boolean().required(),
        price: Joi.number().precision(2).min(0).max(1000000).required(),
      }),
      req.body,
    );
    const p = await service.profile(req.user!.shopId);
    assert(
      p.menuProductIds.includes(req.params.id),
      "Menu item not found.",
      404,
    );
    await ProductService.update(req.params.id, p.shopId, {
      sellPrice: data.price,
    });
    await prisma.$executeRaw`UPDATE "RestaurantProfile" SET "unavailableProductIds" = CASE WHEN ${data.available} THEN array_remove("unavailableProductIds",${req.params.id}) ELSE ARRAY(SELECT DISTINCT unnest("unavailableProductIds" || ARRAY[${req.params.id}]::text[])) END WHERE "shopId"=${p.shopId}`;
    ApiResponse.success(res, { saved: true });
  }),
);
restaurantRoutes.post(
  "/payments",
  ownerAuth,
  handle(async (req, res) => {
    const data = read(
      Joi.object({ key: Joi.string().min(20).max(500).required() }),
      req.body,
    );
    await service.connectPayments(req.user!.shopId, data.key);
    ApiResponse.success(res, { connected: true });
  }),
);
restaurantRoutes.get(
  "/orders",
  handle(async (req, res) => {
    const c = await service.context(
      req.user!.shopId,
      req.user!.role,
      req.user!.type === "user" ? req.user!.id : undefined,
    );
    const rows = await prisma.restaurantTicket.findMany({
      where: {
        shopId: c.shop.id,
        ...(req.query.history === "true"
          ? { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } }
          : { status: { notIn: ["COMPLETED", "CANCELLED"] } }),
      },
      orderBy: { requestedFor: "asc" },
      take: 200,
    });
    ApiResponse.success(
      res,
      rows.map((t) =>
        c.kitchen
          ? {
              id: t.id,
              number: t.id.slice(0, 8).toUpperCase(),
              status: t.status,
              items: (t.items as any[]).map(
                ({ productId, name, quantity, notes }) => ({
                  productId,
                  name,
                  quantity,
                  notes,
                }),
              ),
              requestedFor: t.requestedFor,
              mode: t.mode,
              tableName: t.tableName,
            }
          : {
              ...service.ticketPublic(t),
              customerName: t.customerName,
              customerPhone: t.customerPhone,
              saleId: t.saleId,
            },
      ),
    );
  }),
);
restaurantRoutes.post(
  "/orders/:id/status",
  handle(async (req, res) => {
    const data = read(
      Joi.object({
        status: Joi.string()
          .valid("ACCEPTED", "PREPARING", "READY", "COMPLETED", "CANCELLED")
          .required(),
      }),
      req.body,
    );
    const c = await service.context(
      req.user!.shopId,
      req.user!.role,
      req.user!.type === "user" ? req.user!.id : undefined,
    );
    assert(
      !c.kitchen || ["PREPARING", "READY"].includes(data.status),
      "A counter colleague must accept, cancel or hand over orders.",
      403,
    );
    ApiResponse.success(
      res,
      await service.changeStatus(c.shop.id, req.params.id, data.status),
    );
  }),
);
restaurantRoutes.post(
  "/orders/:id/payment",
  handle(async (req, res) => {
    const data = read(
      Joi.object({
        cashReceived: Joi.number().precision(2).min(0).max(10000000),
      }),
      req.body,
    );
    ApiResponse.success(
      res,
      await service.recordSale(
        req.user!.shopId,
        req.params.id,
        req.user!.type === "user" ? req.user!.id : undefined,
        data.cashReceived,
      ),
    );
  }),
);
restaurantRoutes.get(
  "/team",
  managerAuth,
  handle(async (req, res) =>
    ApiResponse.success(
      res,
      await prisma.user.findMany({
        where: { shopId: req.user!.shopId, isActive: true },
        select: { id: true, name: true, role: true, restaurantDuty: true },
      }),
    ),
  ),
);
restaurantRoutes.put(
  "/team/:id/duty",
  managerAuth,
  handle(async (req, res) => {
    const data = read(
      Joi.object({ duty: Joi.string().valid("KITCHEN", "COUNTER").required() }),
      req.body,
    );
    const count = await prisma.user.updateMany({
      where: {
        id: req.params.id,
        shopId: req.user!.shopId,
        isActive: true,
        role: "CASHIER",
      },
      data: { restaurantDuty: data.duty },
    });
    assert(
      count.count === 1,
      "Choose an active cashier account. Managers keep their management access.",
      404,
    );
    ApiResponse.success(res, { saved: true });
  }),
);
restaurantRoutes.get(
  "/reports",
  managerAuth,
  handle(async (req, res) => {
    const days = Number(req.query.days ?? 1);
    assert([1, 7, 30].includes(days), "Choose 1, 7 or 30 days.");
    ApiResponse.success(res, await restaurantReport(req.user!.shopId, days));
  }),
);
restaurantRoutes.get(
  "/subscriptions",
  managerAuth,
  handle(async (req, res) => {
    const shopId = req.user!.shopId;
    const [subscriptions, deliveries] = await Promise.all([
      prisma.restaurantReportSubscription.findMany({ where: { shopId } }),
      prisma.restaurantDelivery.findMany({
        where: { shopId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    ApiResponse.success(res, { subscriptions, deliveries });
  }),
);
restaurantRoutes.put(
  "/subscriptions",
  managerAuth,
  handle(async (req, res) => {
    const data = read(
      Joi.object({
        kind: Joi.string().valid("DAILY", "WEEKLY", "INSIGHTS").required(),
        channel: Joi.string().valid("WHATSAPP", "EMAIL").required(),
        recipient: text(254).required(),
        localHour: Joi.number().integer().min(0).max(23).required(),
        enabled: Joi.boolean().required(),
        consent: Joi.boolean().valid(true).required(),
      }),
      req.body,
    );
    read(
      data.channel === "WHATSAPP"
        ? phone
        : Joi.string().email({ tlds: { allow: false } }),
      data.recipient,
    );
    const { consent, ...values } = data;
    const shopId = req.user!.shopId;
    await service.profile(shopId);
    ApiResponse.success(
      res,
      await prisma.restaurantReportSubscription.upsert({
        where: {
          shopId_kind_channel: {
            shopId,
            kind: data.kind,
            channel: data.channel,
          },
        },
        create: { shopId, ...values, consentAt: new Date() },
        update: { ...values, consentAt: new Date() },
      }),
    );
  }),
);
publicRestaurantRoutes.get(
  "/:slug",
  handle(async (req, res) =>
    ApiResponse.success(res, await service.publicMenu(req.params.slug)),
  ),
);
publicRestaurantRoutes.get(
  "/:slug/slots",
  handle(async (req, res) => {
    const day = read(
      Joi.string()
        .pattern(/^\d{4}-\d{2}-\d{2}$/)
        .required(),
      req.query.date,
    );
    ApiResponse.success(
      res,
      await service.availableSlots(req.params.slug, day),
    );
  }),
);
const orderSchema = Joi.object({
  requestKey: Joi.string().guid().required(),
  accessToken: Joi.string()
    .pattern(/^[0-9a-f]{64}$/)
    .required(),
  expectedTotalMinor: Joi.number().integer().min(0).max(100000000).required(),
  customerName: text(120).min(2).required(),
  customerPhone: phone.required(),
  notifyWhatsApp: Joi.boolean().required(),
  mode: Joi.string().valid("PICKUP", "DINE_IN").required(),
  tableName: text(40),
  requestedFor: Joi.string().isoDate().required(),
  paymentMethod: Joi.string().valid("CASH", "ONLINE").required(),
  items: Joi.array()
    .items(
      Joi.object({
        productId: identifier,
        quantity: Joi.number().integer().min(1).max(20).required(),
        notes: text(300).allow(""),
      }),
    )
    .min(1)
    .max(30)
    .required(),
});
publicRestaurantRoutes.post(
  "/:slug/orders",
  limiter,
  handle(async (req, res) =>
    ApiResponse.created(
      res,
      await service.createTicket(req.params.slug, read(orderSchema, req.body)),
    ),
  ),
);
publicRestaurantRoutes.post(
  "/:slug/ask",
  aiLimiter,
  handle(async (req, res) => {
    const data = read(
        Joi.object({ question: text(1000).min(3).required() }),
        req.body,
      ),
      pub = await service.publicMenu(req.params.slug);
    assert(
      pub.allowAssistant,
      "The restaurant has not enabled its menu assistant.",
      409,
    );
    const p = await prisma.restaurantProfile.findUniqueOrThrow({
      where: { slug: req.params.slug },
    });
    assert(
      await consumeAllowance(p.shopId, "AI_QUESTION"),
      "The menu assistant has reached its allowance. Please contact the restaurant.",
      402,
    );
    const result = await restaurantAI("menu-answer", {
      question: data.question,
      restaurant: pub.name,
      currency: pub.currency,
      menu: pub.items,
    });
    ApiResponse.success(res, result);
  }),
);
publicOrderRoutes.get(
  "/:id",
  handle(async (req, res) =>
    ApiResponse.success(
      res,
      service.ticketPublic(
        await service.getPublicTicket(req.params.id, token(req)),
      ),
    ),
  ),
);
publicOrderRoutes.post(
  "/:id/checkout",
  limiter,
  handle(async (req, res) =>
    ApiResponse.success(res, await service.checkout(req.params.id, token(req))),
  ),
);
publicOrderRoutes.post(
  "/:id/confirm-payment",
  limiter,
  handle(async (req, res) => {
    const t = await service.getPublicTicket(req.params.id, token(req));
    assert(
      t.paymentMethod === "ONLINE",
      "This order is payable at the counter.",
    );
    const checked = await service.reconcilePayment(t.id);
    ApiResponse.success(
      res,
      checked.paymentStatus === "PAID"
        ? await service.recordSale(t.shopId, t.id)
        : service.ticketPublic(checked),
    );
  }),
);
