import { randomUUID, randomBytes } from "crypto";
import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { prisma } from "../src/config/prisma";
import * as restaurant from "../src/restaurant/service";
import { enforceWorkspace } from "../src/restaurant/access";
import { restaurantReport } from "../src/restaurant/reports";
import { seal } from "../src/restaurant/domain";
import { YeboPayClient } from "../src/services/yebopay.client";
vi.mock("../src/services/shop.service", () => ({
  ShopService: { incrementUsage: vi.fn() },
}));
vi.mock("@yebo/mcp-server", () => ({
  JwksValidator: class {
    async verify() {
      throw new Error("Not a YeboID test token");
    }
  },
  extractBearerToken: (header?: string) =>
    header?.startsWith("Bearer ") ? header.slice(7) : null,
}));
let shopId: string, productId: string, slug: string, at: string;
const shops: string[] = [];
beforeEach(async () => {
  vi.restoreAllMocks();
  process.env.RESTAURANT_CREDENTIAL_KEY = "c".repeat(64);
  process.env.RESTAURANT_PUBLIC_ORIGIN = "https://app.yebomart.com";
  const shop = await prisma.shop.create({
    data: {
      name: "Isolated restaurant test",
      businessType: "restaurant",
      ownerName: "Test",
      ownerPhone: randomUUID(),
      ownerYeboidSub: randomUUID(),
      taxRate: 15,
      taxInclusive: false,
    },
  });
  shopId = shop.id;
  shops.push(shopId);
  productId = (
    await prisma.product.create({
      data: {
        shopId,
        name: "Meal",
        sellPrice: 40,
        costPrice: 15,
        trackStock: false,
        quantity: 0,
      },
    })
  ).id;
  slug = "test-" + randomUUID();
  await prisma.restaurantProfile.create({
    data: {
      shopId,
      slug,
      description: "Test only",
      publicPhone: "+26876000001",
      published: true,
      acceptingOrders: true,
      hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        day,
        open: "00:00",
        close: "23:59",
      })),
      leadMinutes: 0,
      slotMinutes: 15,
      slotCapacity: 20,
      tables: ["Table 1"],
      menuProductIds: [productId],
      unavailableProductIds: [],
    },
  });
  const n = new Date(Date.now() + 3600000);
  n.setUTCMinutes(Math.ceil(n.getUTCMinutes() / 15) * 15, 0, 0);
  at = n.toISOString();
});
afterAll(async () => {
  for (const id of shops) {
    await prisma.restaurantDelivery.deleteMany({ where: { shopId: id } });
    await prisma.stockLog.deleteMany({ where: { shopId: id } });
    await prisma.sale.deleteMany({ where: { shopId: id } });
    await prisma.shop.delete({ where: { id } });
  }
  await prisma.$disconnect();
});
function input(overrides: any = {}) {
  return {
    requestKey: randomUUID(),
    accessToken: randomBytes(32).toString("hex"),
    expectedTotalMinor: 4600,
    customerName: "Test Guest",
    customerPhone: "+26876000001",
    notifyWhatsApp: false,
    mode: "PICKUP" as const,
    requestedFor: at,
    paymentMethod: "CASH" as const,
    items: [{ productId, quantity: 1 }],
    ...overrides,
  };
}
it("atomically replays an order, freezes prices and writes exactly one existing-ledger sale", async () => {
  const body = input();
  const [a, b] = await Promise.all([
    restaurant.createTicket(slug, body),
    restaurant.createTicket(slug, body),
  ]);
  expect(a.id).toBe(b.id);
  expect(a.totalMinor).toBe(4600);
  await prisma.product.update({
    where: { id: productId },
    data: { sellPrice: 100 },
  });
  await restaurant.changeStatus(shopId, a.id, "ACCEPTED");
  await restaurant.changeStatus(shopId, a.id, "PREPARING");
  await restaurant.changeStatus(shopId, a.id, "READY");
  await expect(
    restaurant.changeStatus(shopId, a.id, "COMPLETED"),
  ).rejects.toThrow("payment");
  await restaurant.recordSale(shopId, a.id, undefined, 50);
  await restaurant.recordSale(shopId, a.id, undefined, 50);
  expect(await prisma.sale.count({ where: { shopId } })).toBe(1);
  expect(await prisma.sale.findFirst({ where: { shopId } })).toMatchObject({
    totalAmount: 46,
    change: 4,
  });
  expect(
    await prisma.product.findUnique({ where: { id: productId } }),
  ).toMatchObject({ quantity: 0 });
  await restaurant.changeStatus(shopId, a.id, "COMPLETED");
  expect(await restaurantReport(shopId)).toMatchObject({
    completed: 1,
    collectedMinor: 4600,
    unpaidMinor: 0,
  });
});
it("rejects stale totals, unavailable items, foreign products and changed idempotency payloads", async () => {
  await expect(
    restaurant.createTicket(slug, input({ expectedTotalMinor: 4000 })),
  ).rejects.toThrow("price");
  const body = input();
  const ticket = await restaurant.createTicket(slug, body);
  await expect(
    restaurant.createTicket(slug, { ...body, customerName: "Other" }),
  ).rejects.toThrow("different");
  await expect(
    restaurant.getPublicTicket(ticket.id, randomBytes(32).toString("hex")),
  ).rejects.toThrow("verified");
  await expect(
    restaurant.changeStatus("another-shop", ticket.id, "ACCEPTED"),
  ).rejects.toThrow("not found");
  await prisma.restaurantProfile.update({
    where: { shopId },
    data: { unavailableProductIds: [productId] },
  });
  await expect(restaurant.createTicket(slug, input())).rejects.toThrow(
    "available",
  );
  await expect(
    restaurant.createTicket(
      slug,
      input({ items: [{ productId: "foreign", quantity: 1 }] }),
    ),
  ).rejects.toThrow();
});
it("serializes competing orders for the last slot", async () => {
  await prisma.restaurantProfile.update({
    where: { shopId },
    data: { slotCapacity: 1 },
  });
  const results = await Promise.allSettled([
    restaurant.createTicket(slug, input()),
    restaurant.createTicket(slug, input()),
  ]);
  expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  expect(await prisma.restaurantTicket.count({ where: { shopId } })).toBe(1);
});
it("holds uncertain checkout creation and never blindly retries the provider", async () => {
  await prisma.restaurantProfile.update({
    where: { shopId },
    data: {
      allowOnline: true,
      paymentCredential: seal("restaurant-own-key", shopId),
    },
  });
  const body = input({ paymentMethod: "ONLINE" });
  const ticket = await restaurant.createTicket(slug, body);
  const provider = vi
    .spyOn(YeboPayClient, "createCheckout")
    .mockRejectedValue(new Error("connection lost"));
  await expect(
    restaurant.checkout(ticket.id, body.accessToken),
  ).rejects.toThrow("connection lost");
  await expect(
    restaurant.checkout(ticket.id, body.accessToken),
  ).rejects.toThrow("previous payment");
  expect(provider).toHaveBeenCalledTimes(1);
  expect(provider.mock.calls[0][1]).toBe("restaurant-own-key");
  expect(
    await prisma.restaurantTicket.findUnique({ where: { id: ticket.id } }),
  ).toMatchObject({ checkoutState: "UNKNOWN", paymentStatus: "UNPAID" });
});
it("requires the exact provider-confirmed amount, currency and charge before recording payment", async () => {
  await prisma.restaurantProfile.update({
    where: { shopId },
    data: {
      allowOnline: true,
      paymentCredential: seal("restaurant-own-key", shopId),
    },
  });
  const ticket = await restaurant.createTicket(
    slug,
    input({ paymentMethod: "ONLINE" }),
  );
  await prisma.restaurantTicket.update({
    where: { id: ticket.id },
    data: { checkoutId: randomUUID(), checkoutState: "READY" },
  });
  const saved = await prisma.restaurantTicket.findUniqueOrThrow({
    where: { id: ticket.id },
  });
  const remote = {
    id: saved.checkoutId!,
    status: "COMPLETED" as const,
    hosted_url: null,
    expires_at: new Date().toISOString(),
    payment_method: "CARD",
    processor: "test",
    amount: "45",
    currency: "SZL",
    charge_id: randomUUID(),
  };
  const provider = vi
    .spyOn(YeboPayClient, "getCheckout")
    .mockResolvedValue(remote);
  await expect(restaurant.recordSale(shopId, ticket.id)).rejects.toThrow(
    "match",
  );
  expect(await prisma.sale.count({ where: { shopId } })).toBe(0);
  provider.mockResolvedValue({ ...remote, amount: "46" });
  await restaurant.recordSale(shopId, ticket.id);
  expect(await prisma.sale.count({ where: { shopId } })).toBe(1);
  expect(provider.mock.calls[0][1]).toBe("restaurant-own-key");
});
it("imports reviewed menu products once and requires identical confirmation on replay", async () => {
  const draft = await prisma.restaurantImport.create({
    data: { shopId, draft: { items: [] }, productIds: [] },
  });
  const items = [
    { name: "Soup", price: 25, cost: null, category: "Lunch", description: "" },
  ];
  const first = await restaurant.confirmImport(shopId, draft.id, items);
  expect(await restaurant.confirmImport(shopId, draft.id, items)).toEqual(
    first,
  );
  await expect(
    restaurant.confirmImport(shopId, draft.id, [{ ...items[0], price: 30 }]),
  ).rejects.toThrow("different");
  expect(
    await prisma.product.findUnique({ where: { id: first.productIds[0] } }),
  ).toMatchObject({ trackStock: false, attributes: { costStatus: "unknown" } });
});
it("enforces current kitchen duty and disabled modules on direct API requests", async () => {
  const staff = await prisma.user.create({
    data: {
      shopId,
      name: "Chef",
      phone: randomUUID(),
      pin: "test-only",
      role: "CASHIER",
      restaurantDuty: "KITCHEN",
    },
  });
  const user = { shopId, id: staff.id, type: "user", role: "CASHIER" };
  const req = (originalUrl: string, method = "GET") =>
    ({ originalUrl, method }) as any;
  await expect(
    enforceWorkspace(req("/api/reports/daily"), user),
  ).rejects.toThrow("kitchen");
  await expect(
    enforceWorkspace(req("/api/restaurant/orders/a/payment", "POST"), user),
  ).rejects.toThrow("kitchen");
  await expect(
    enforceWorkspace(req("/api/restaurant/orders"), user),
  ).resolves.toBeUndefined();
  await prisma.user.update({
    where: { id: staff.id },
    data: { restaurantDuty: "COUNTER" },
  });
  await expect(
    enforceWorkspace(req("/api/reports/daily"), user),
  ).rejects.toThrow("manager");
  await prisma.businessWorkspace.create({
    data: { shopId, modules: ["restaurant"] },
  });
  await expect(
    enforceWorkspace(req("/api/stock"), { ...user, role: "MANAGER" }),
  ).rejects.toThrow("not enabled");
});

it("serves the actual setup and public order HTTP contracts, including a first menu with no products", async () => {
  const express = (await import("express")).default;
  const { restaurantRoutes, publicRestaurantRoutes } = await import(
    "../src/restaurant/routes"
  );
  const { JWTUtil } = await import("../src/utils/jwt");
  const app = express();
  app.use(express.json());
  app.use("/api/restaurant", restaurantRoutes);
  app.use("/api/restaurants", publicRestaurantRoutes);
  const manager = await prisma.user.create({
    data: { shopId, name: "Manager", phone: randomUUID(), role: "MANAGER" },
  });
  const token = JWTUtil.generateAccessToken({
    id: manager.id,
    shopId,
    role: "MANAGER",
    type: "user",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  try {
    await prisma.restaurantProfile.delete({ where: { shopId } });
    const initial = await fetch(base + "/api/restaurant", {
      headers: { Authorization: "Bearer " + token },
    });
    expect(await initial.json()).toMatchObject({ success: true, data: null });
    const config = {
      slug,
      description: "HTTP test only",
      publicPhone: "+26878422613",
      published: false,
      acceptingOrders: false,
      hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        day,
        open: "00:00",
        close: "23:59",
      })),
      leadMinutes: 0,
      slotMinutes: 15,
      slotCapacity: 20,
      tables: [],
      menuProductIds: [],
      unavailableProductIds: [],
      allowCash: true,
      allowOnline: false,
      allowAssistant: false,
    };
    const put = (body: any) =>
      fetch(base + "/api/restaurant", {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const setup = await put(config);
    const setupBody = await setup.json();
    expect(setup.status, JSON.stringify(setupBody)).toBe(200);
    expect(setupBody).toMatchObject({
      success: true,
      data: { slug, menuProductIds: [] },
    });
    expect(setup.status).toBe(200);
    expect((await put({ ...config, published: true })).status).toBe(400);
    expect(
      (
        await put({
          ...config,
          published: true,
          acceptingOrders: true,
          menuProductIds: [productId],
        })
      ).status,
    ).toBe(200);
    const menu = await fetch(base + "/api/restaurants/" + slug);
    expect(await menu.json()).toMatchObject({
      success: true,
      data: { items: [{ id: productId, price: 40 }] },
    });
    const order = await fetch(base + "/api/restaurants/" + slug + "/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input()),
    });
    expect(order.status).toBe(201);
    await prisma.product.update({
      where: { id: productId },
      data: { trackStock: true, quantity: 0 },
    });
    const availability = await fetch(
      base + "/api/restaurant/menu/" + productId,
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ available: true, price: 40 }),
      },
    );
    expect(availability.status).toBe(409);
    expect(await availability.json()).toMatchObject({
      success: false,
      message: expect.stringContaining("Receive stock"),
    });

    expect(await order.json()).toMatchObject({
      success: true,
      data: { totalMinor: 4600, status: "NEW", paymentStatus: "UNPAID" },
    });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
