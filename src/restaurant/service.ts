import { randomBytes, randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@config/prisma";
import { ProductService } from "@services/product.service";
import { SaleService } from "@services/sale.service";
import { computeTax } from "@utils/tax";
import {
  assert,
  digest,
  money,
  parts,
  validateSlot,
  transition,
  seal,
  type Hours,
  type TicketLine,
} from "./domain";
import { recommendedModules, resolveWorkspace } from "./capabilities";
import {
  merchantCredential,
  checkMerchantKey,
  YeboPayClient,
} from "./merchant-payments";

export async function context(shopId: string, role: string, userId?: string) {
  const [shop, workspace, restaurant, staff] = await Promise.all([
    prisma.shop.findUniqueOrThrow({ where: { id: shopId } }),
    prisma.businessWorkspace.findUnique({ where: { shopId } }),
    prisma.restaurantProfile.findUnique({ where: { shopId } }),
    userId
      ? prisma.user.findFirst({ where: { id: userId, shopId, isActive: true } })
      : null,
  ]);
  const modules = workspace
    ? workspace.modules
    : recommendedModules(shop.businessType);
  const kitchen = staff?.restaurantDuty === "KITCHEN";
  return {
    shop,
    modules,
    restaurant,
    kitchen,
    role,
    navigation: resolveWorkspace(modules, role, kitchen),
  };
}
export function safeProfile(p: any) {
  if (!p) return null;
  const { paymentCredential, ...rest } = p;
  return { ...rest, paymentsConnected: !!paymentCredential };
}
export async function profile(shopId: string) {
  const row = await prisma.restaurantProfile.findUnique({
    where: { shopId },
    include: { shop: true },
  });
  assert(row, "Set up your restaurant first.", 409);
  return row;
}
export async function menu(p: Awaited<ReturnType<typeof profile>>) {
  const products = await prisma.product.findMany({
    where: { id: { in: p.menuProductIds }, shopId: p.shopId, isActive: true },
  });
  return p.menuProductIds.flatMap((id) => {
    const v = products.find((x) => x.id === id);
    if (!v) return [];
    return [
      {
        id: v.id,
        name: v.name,
        description: v.description,
        category: v.category,
        price: v.sellPrice,
        available:
          !p.unavailableProductIds.includes(id) &&
          (!v.trackStock || v.quantity > 0),
        imageUrl: v.imageUrl,
      },
    ];
  });
}
export async function publicMenu(slug: string) {
  const p = await prisma.restaurantProfile.findUnique({
    where: { slug },
    include: { shop: true },
  });
  assert(
    p && p.published && p.shop.status === "ACTIVE",
    "This restaurant website is not available.",
    404,
  );
  return {
    name: p.shop.name,
    slug: p.slug,
    description: p.description,
    phone: p.publicPhone,
    address: p.shop.address,
    logoUrl: p.shop.logoUrl,
    currency: p.shop.currency,
    currencySymbol: p.shop.currencySymbol,
    timezone: p.shop.timezone,
    hours: p.hours,
    acceptingOrders: p.acceptingOrders,
    leadMinutes: p.leadMinutes,
    allowAssistant: p.allowAssistant,
    allowCash: p.allowCash,
    allowOnline: p.allowOnline && !!p.paymentCredential,
    tables: p.tables,
    taxRate: p.shop.taxRate,
    taxInclusive: p.shop.taxInclusive,
    items: await menu(p),
  };
}
export async function availableSlots(
  slug: string,
  day: string,
  now = new Date(),
) {
  const pub = await publicMenu(slug);
  const p = await prisma.restaurantProfile.findUniqueOrThrow({
    where: { slug },
  });
  const start = new Date(day + "T00:00:00Z");
  assert(Number.isFinite(start.getTime()), "Choose a date.");
  const rows = await prisma.restaurantTicket.findMany({
    where: {
      shopId: p.shopId,
      status: { not: "CANCELLED" },
      requestedFor: {
        gte: new Date(start.getTime() - 86400000),
        lt: new Date(start.getTime() + 2 * 86400000),
      },
    },
    select: { requestedFor: true },
  });
  const slots = [];
  for (
    let t = start.getTime() - 86400000;
    t < start.getTime() + 2 * 86400000;
    t += 60000
  ) {
    const date = new Date(t);
    if (parts(date, pub.timezone).date !== day) continue;
    try {
      validateSlot(date, p, pub.timezone, now);
    } catch {
      continue;
    }
    const used = rows.filter((r) => r.requestedFor.getTime() === t).length;
    if (used < p.slotCapacity)
      slots.push({
        at: date.toISOString(),
        label: parts(date, pub.timezone).label,
        remaining: p.slotCapacity - used,
      });
  }
  return slots;
}
export interface OrderInput {
  requestKey: string;
  accessToken: string;
  expectedTotalMinor: number;
  customerName: string;
  customerPhone: string;
  notifyWhatsApp: boolean;
  mode: "PICKUP" | "DINE_IN";
  tableName?: string;
  requestedFor: string;
  paymentMethod: "CASH" | "ONLINE";
  items: Array<{ productId: string; quantity: number; notes?: string }>;
}
export async function createTicket(slug: string, input: OrderInput) {
  const p = await profileBySlug(slug);
  const requestHash = digest(JSON.stringify(input));
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "shopId" FROM "RestaurantProfile" WHERE "shopId"=${p.shopId} FOR UPDATE`;
    const existing = await tx.restaurantTicket.findUnique({
      where: {
        shopId_requestKey: { shopId: p.shopId, requestKey: input.requestKey },
      },
    });
    if (existing) {
      assert(
        existing.requestHash === requestHash,
        "This request number was already used for a different order.",
        409,
      );
      return ticketPublic(existing);
    }
    const live = await tx.restaurantProfile.findUniqueOrThrow({
      where: { shopId: p.shopId },
    });
    assert(
      live.published && live.acceptingOrders && p.shop.status === "ACTIVE",
      "The restaurant is not taking orders right now.",
      409,
    );
    assert(
      input.paymentMethod === "CASH"
        ? live.allowCash
        : live.allowOnline && !!live.paymentCredential,
      "This payment option is not available.",
      409,
    );
    const at = new Date(input.requestedFor);
    validateSlot(at, live, p.shop.timezone);
    if (input.mode === "DINE_IN")
      assert(
        input.tableName && live.tables.includes(input.tableName),
        "Choose a valid table.",
      );
    const count = await tx.restaurantTicket.count({
      where: {
        shopId: p.shopId,
        requestedFor: at,
        status: { not: "CANCELLED" },
      },
    });
    assert(
      count < live.slotCapacity,
      "That slot just filled up. Choose another time.",
      409,
    );
    const ids = input.items.map((i) => i.productId);
    assert(
      new Set(ids).size === ids.length,
      "Combine repeated items in your basket.",
    );
    assert(
      ids.every(
        (id) =>
          live.menuProductIds.includes(id) &&
          !live.unavailableProductIds.includes(id),
      ),
      "An item is no longer available. Review your basket.",
      409,
    );
    const products = await tx.product.findMany({
      where: { shopId: p.shopId, id: { in: ids }, isActive: true },
    });
    assert(
      products.length === ids.length,
      "An item is no longer available.",
      409,
    );
    const lines: TicketLine[] = input.items.map((i) => {
      const product = products.find((v) => v.id === i.productId)!;
      assert(
        !product.trackStock || product.quantity >= i.quantity,
        product.name + " is out of stock.",
        409,
      );
      return {
        productId: product.id,
        name: product.name,
        quantity: i.quantity,
        unitPrice: product.sellPrice,
        notes: i.notes ?? "",
      };
    });
    const subtotal =
      lines.reduce((n, i) => n + money(i.unitPrice) * i.quantity, 0) / 100;
    const { total } = computeTax(subtotal, 0, p.shop);
    assert(
      money(total) === input.expectedTotalMinor,
      "The menu price has changed. Refresh the menu and review your total.",
      409,
    );
    assert(
      input.paymentMethod !== "ONLINE" || money(total) > 0,
      "For a free order, choose payment at the counter.",
    );
    const ticket = await tx.restaurantTicket.create({
      data: {
        shopId: p.shopId,
        requestKey: input.requestKey,
        requestHash,
        accessHash: digest(input.accessToken),
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        notifyWhatsApp: input.notifyWhatsApp,
        mode: input.mode,
        tableName: input.mode === "DINE_IN" ? input.tableName : null,
        requestedFor: at,
        items: lines as any,
        totalMinor: money(total),
        currency: p.shop.currency,
        taxRate: p.shop.taxRate,
        taxInclusive: p.shop.taxInclusive,
        paymentMethod: input.paymentMethod,
      },
    });
    return ticketPublic(ticket);
  });
}
async function profileBySlug(slug: string) {
  const p = await prisma.restaurantProfile.findUnique({
    where: { slug },
    include: { shop: true },
  });
  assert(p, "Restaurant not found.", 404);
  return p;
}
export function ticketPublic(t: any) {
  return {
    id: t.id,
    number: t.id.slice(0, 8).toUpperCase(),
    status: t.status,
    items: t.items,
    totalMinor: t.totalMinor,
    currency: t.currency,
    paymentMethod: t.paymentMethod,
    paymentStatus: t.paymentStatus,
    checkoutState: t.checkoutState,
    requestedFor: t.requestedFor,
    mode: t.mode,
    tableName: t.tableName,
    failure: t.failure,
    createdAt: t.createdAt,
  };
}
export async function getPublicTicket(id: string, token: string) {
  const t = await prisma.restaurantTicket.findUnique({ where: { id } });
  assert(
    t && t.accessHash === digest(token),
    "Order access could not be verified.",
    404,
  );
  return t;
}
export async function checkout(id: string, token: string) {
  const t = await getPublicTicket(id, token);
  assert(
    t.paymentMethod === "ONLINE" && t.status !== "CANCELLED",
    "This order does not accept an online payment.",
    409,
  );
  if (t.checkoutId && t.checkoutUrl) return { url: t.checkoutUrl };
  assert(
    t.checkoutState === "NONE",
    "The previous payment request is still being checked. Do not pay again; contact the restaurant.",
    409,
  );
  const p = await profile(t.shopId);
  assert(p.allowOnline, "Online payments have been paused.", 409);
  const origin = process.env.RESTAURANT_PUBLIC_ORIGIN;
  assert(origin, "The public website address is not configured.", 503);
  const key = merchantCredential(p);
  const claimed = await prisma.restaurantTicket.updateMany({
    where: { id, checkoutState: "NONE" },
    data: { checkoutState: "CREATING" },
  });
  assert(claimed.count === 1, "Payment is already being prepared.", 409);
  try {
    const result = await YeboPayClient.createCheckout(
      {
        amount: t.totalMinor / 100,
        currency: t.currency,
        successUrl: origin + "/r/" + p.slug + "/order/" + t.id,
        cancelUrl: origin + "/r/" + p.slug + "/order/" + t.id,
        description: p.shop.name + " order " + t.id.slice(0, 8),
        metadata: {
          flow: "yebomart-restaurant",
          restaurantOrderId: t.id,
          shopId: t.shopId,
        },
        idempotencyKey: "restaurant-" + t.id,
      },
      key,
    );
    assert(
      result.id && result.hosted_url,
      "YeboPay did not return a checkout link.",
      502,
    );
    await prisma.restaurantTicket.update({
      where: { id },
      data: {
        checkoutId: result.id,
        checkoutUrl: result.hosted_url,
        checkoutState: "READY",
      },
    });
    return { url: result.hosted_url };
  } catch (e) {
    await prisma.restaurantTicket.update({
      where: { id },
      data: {
        checkoutState: "UNKNOWN",
        failure:
          "Payment creation could not be confirmed. The restaurant must reconcile this attempt before another payment.",
      },
    });
    throw e;
  }
}
export async function reconcilePayment(id: string) {
  const t = await prisma.restaurantTicket.findUniqueOrThrow({ where: { id } });
  if (!t.checkoutId || t.paymentStatus === "PAID") return t;
  const p = await profile(t.shopId),
    remote = await YeboPayClient.getCheckout(
      t.checkoutId,
      merchantCredential(p),
    );
  assert(
    remote.id === t.checkoutId &&
      money(Number(remote.amount)) === t.totalMinor &&
      remote.currency === t.currency,
    "YeboPay payment details do not match this order.",
    502,
  );
  if (remote.status === "COMPLETED") {
    assert(
      remote.charge_id,
      "YeboPay has not confirmed the payment reference.",
      502,
    );
    return prisma.restaurantTicket.update({
      where: { id },
      data: {
        paymentStatus: "PAID",
        chargeId: remote.charge_id,
        failure: null,
      },
    });
  }
  return t;
}
export async function changeStatus(
  shopId: string,
  id: string,
  to: string,
  userId?: string,
) {
  const found = await prisma.restaurantTicket.findFirst({
    where: { id, shopId },
  });
  assert(found, "Order not found.", 404);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "RestaurantTicket" WHERE id=${id} FOR UPDATE`;
    const t = await tx.restaurantTicket.findFirstOrThrow({
      where: { id, shopId },
    });
    if (t.status === to) return ticketPublic(t);
    transition(t.status, to);
    if (to === "CANCELLED")
      assert(
        t.paymentStatus !== "PAID" && t.checkoutState === "NONE",
        "A payment attempt exists. Reconcile and refund through YeboPay before cancelling this order.",
        409,
      );
    if (to === "ACCEPTED" && t.paymentMethod === "ONLINE")
      assert(
        t.paymentStatus === "PAID",
        "Confirm the online payment before accepting this order.",
        409,
      );
    const data: any = { status: to };
    if (to === "ACCEPTED") data.acceptedAt = new Date();
    if (to === "READY") data.readyAt = new Date();
    if (to === "COMPLETED") {
      assert(
        t.paymentStatus === "PAID",
        "Record the cash payment or confirm YeboPay before completing.",
        409,
      );
      assert(t.saleId, "The sale still needs reconciliation.", 409);
      data.completedAt = new Date();
    }
    const result = await tx.restaurantTicket.update({ where: { id }, data });
    if (t.notifyWhatsApp && ["ACCEPTED", "READY", "COMPLETED"].includes(to))
      await tx.restaurantDelivery.upsert({
        where: { key: "ticket:" + id + ":" + to },
        create: {
          shopId,
          ticketId: id,
          key: "ticket:" + id + ":" + to,
          channel: "WHATSAPP",
          recipient: t.customerPhone,
          content:
            "Order " +
            id.slice(0, 8).toUpperCase() +
            " is " +
            to.toLowerCase() +
            ". " +
            (to === "READY"
              ? "Please collect at your chosen restaurant."
              : "Check your order page for details."),
        },
        update: {},
      });
    return ticketPublic(result);
  });
}
export async function recordSale(
  shopId: string,
  id: string,
  userId?: string,
  cashReceived?: number,
) {
  let t = await prisma.restaurantTicket.findFirst({ where: { id, shopId } });
  assert(t, "Order not found.", 404);
  assert(t.status !== "CANCELLED", "This order was cancelled.", 409);
  if (t.paymentMethod === "ONLINE") t = await reconcilePayment(id);
  else
    assert(
      typeof cashReceived === "number" && money(cashReceived) >= t.totalMinor,
      "Enter the amount of cash actually received.",
    );
  if (t.paymentMethod === "ONLINE")
    assert(
      t.paymentStatus === "PAID",
      "YeboPay has not confirmed this payment.",
      409,
    );
  const lines = t.items as unknown as TicketLine[];
  // SaleService remains the one stock/accounting writer. Its localId constraint
  // also recovers a crash after the sale committed but before the ticket update.
  const sale = await SaleService.create({
    shopId,
    userId,
    items: lines.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    paymentMethod: t.paymentMethod === "ONLINE" ? "CARD" : "CASH",
    amountPaid:
      t.paymentMethod === "ONLINE" ? t.totalMinor / 100 : cashReceived!,
    localId: "restaurant:" + t.id,
    quote: {
      prices: Object.fromEntries(lines.map((i) => [i.productId, i.unitPrice])),
      taxRate: t.taxRate,
      taxInclusive: t.taxInclusive,
    },
  });
  await prisma.restaurantTicket.update({
    where: { id },
    data: { saleId: sale.id, paymentStatus: "PAID", failure: null },
  });
  return ticketPublic({ ...t, saleId: sale.id, paymentStatus: "PAID" });
}
export async function confirmImport(
  shopId: string,
  id: string,
  items: Array<{
    name: string;
    price: number;
    cost: number | null;
    category: string;
    description: string;
  }>,
) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "RestaurantImport" WHERE id=${id} AND "shopId"=${shopId} FOR UPDATE`;
      const draft = await tx.restaurantImport.findFirst({
        where: { id, shopId },
      });
      assert(draft, "Menu draft not found.", 404);
      const confirmationHash = digest(JSON.stringify(items));
      if (draft.confirmedAt) {
        assert(
          draft.confirmationHash === confirmationHash,
          "This draft was already imported with different edits.",
          409,
        );
        return { productIds: draft.productIds };
      }
      await tx.$queryRaw`SELECT "shopId" FROM "RestaurantProfile" WHERE "shopId"=${shopId} FOR UPDATE`;
      const ids: string[] = [];
      for (const item of items) {
        const p = await ProductService.create(
          {
            shopId,
            name: item.name,
            sellPrice: item.price,
            costPrice: item.cost ?? 0,
            trackStock: false,
            category: item.category,
            description: item.description,
            attributes: {
              costStatus: item.cost === null ? "unknown" : "entered",
            },
            localId: "restaurant-import:" + id + ":" + ids.length,
          },
          tx,
        );
        ids.push(p.id);
      }
      const p = await tx.restaurantProfile.findUniqueOrThrow({
        where: { shopId },
      });
      await tx.restaurantProfile.update({
        where: { shopId },
        data: { menuProductIds: [...p.menuProductIds, ...ids] },
      });
      await tx.restaurantImport.update({
        where: { id },
        data: { confirmedAt: new Date(), productIds: ids, confirmationHash },
      });
      return { productIds: ids };
    },
    { timeout: 30000 },
  );
}
export async function connectPayments(shopId: string, key: string) {
  await checkMerchantKey(key);
  await prisma.restaurantProfile.update({
    where: { shopId },
    data: { paymentCredential: seal(key, shopId) },
  });
}
