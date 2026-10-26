import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/config/prisma";
import { SaleService } from "../src/services/sale.service";
import { ReturnController } from "../src/controllers/return.controller";
import { CustomerController } from "../src/controllers/customer.controller";
import { creditBalanceChange } from "../src/services/customerCredit.service";
import { race } from "./lockedRace";
vi.mock("../src/services/shop.service", () => ({
  ShopService: { incrementUsage: vi.fn() },
}));
let shopId: string,
  customerId: string,
  userId: string,
  productId: string,
  saleId: string;
const shops: string[] = [];
function response() {
  return {
    statusCode: 200,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
  };
}
async function call(method: any, body: any, id?: string) {
  const res = response();
  await method(
    {
      user: { shopId, id: userId, role: "OWNER", type: "user" },
      params: { id },
      body,
    } as any,
    res,
  );
  return res;
}
async function create(quantity = 2, extra = {}) {
  return call(ReturnController.create, {
    saleId,
    type: "STORE_CREDIT",
    reason: "Returned goods",
    items: [
      {
        productId,
        productName: "Item",
        quantity,
        unitPrice: 999,
        restockable: true,
      },
    ],
    ...extra,
  });
}
async function pending(quantity = 2) {
  const r = await create(quantity);
  expect(r.statusCode).toBe(201);
  return r.body.data.id as string;
}
const complete = (id: string) =>
  call(ReturnController.process, { action: "complete" }, id);
const pay = (amount: number) =>
  call(
    CustomerController.addCredit,
    { type: "PAYMENT", amount, saleId },
    customerId,
  );
async function consistent(balance: number) {
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId },
  });
  const ledger = await prisma.customerCredit.findMany({
    where: { customerId },
  });
  expect(customer.balance).toBe(balance);
  expect(
    ledger.reduce((n, e) => n + creditBalanceChange(e.type, e.amount), 0),
  ).toBe(balance);
  return ledger;
}
beforeEach(async () => {
  const shop = await prisma.shop.create({
    data: {
      name: "Return test",
      ownerYeboidSub: randomUUID(),
      ownerPhone: randomUUID(),
      ownerName: "Test",
    },
  });
  shopId = shop.id;
  shops.push(shopId);
  userId = (
    await prisma.user.create({
      data: { shopId, name: "Owner", phone: randomUUID(), role: "OWNER" },
    })
  ).id;
  customerId = (
    await prisma.customer.create({ data: { shopId, name: "Debtor" } })
  ).id;
  productId = (
    await prisma.product.create({
      data: { shopId, name: "Item", sellPrice: 20, costPrice: 5, quantity: 10 },
    })
  ).id;
  saleId = (
    await SaleService.create({
      shopId,
      userId,
      customerId,
      paymentMethod: "CREDIT",
      amountPaid: 0,
      items: [{ productId, quantity: 5 }],
    })
  ).id;
});
afterAll(async () => {
  for (const shopId of shops) {
    await prisma.customerCredit.deleteMany({ where: { shopId } });
    await prisma.return.deleteMany({ where: { shopId } });
    await prisma.stockLog.deleteMany({ where: { shopId } });
    await prisma.saleItem.deleteMany({ where: { sale: { shopId } } });
    await prisma.sale.deleteMany({ where: { shopId } });
    await prisma.shop.delete({ where: { id: shopId } });
  }
  await prisma.$disconnect();
});
describe("Credit return settlement on real PostgreSQL", () => {
  it("partial then remaining full return reverse exactly the original debt", async () => {
    const first = await pending();
    expect((await complete(first)).statusCode).toBe(200);
    const ledger = await consistent(60);
    expect(ledger.find((e) => e.returnId === first)).toMatchObject({
      amount: -40,
      type: "ADJUSTMENT",
      saleId,
      customerId,
    });
    expect((await complete(await pending(3))).statusCode).toBe(200);
    await consistent(0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .quantity,
    ).toBe(10);
  });
  it.each([30, 100])(
    "retains %s repayment and any resulting account credit",
    async (amount) => {
      expect((await pay(amount)).statusCode).toBe(200);
      const payment = await prisma.customerCredit.findFirstOrThrow({
        where: { customerId, type: "PAYMENT" },
      });
      expect((await complete(await pending(5))).statusCode).toBe(200);
      await consistent(-amount);
      expect(
        await prisma.customerCredit.findUnique({ where: { id: payment.id } }),
      ).toEqual(payment);
    },
  );
  it("serializes a sale-linked repayment and return without losing either", async () => {
    const id = await pending();
    const results = await race(
      Prisma.sql`SELECT id FROM "Customer" WHERE id = ${customerId} FOR UPDATE`,
      [() => complete(id), () => pay(70)],
    );
    expect(
      results.map((r) =>
        r.status === "fulfilled" ? r.value.statusCode : r.reason,
      ),
    ).toEqual([200, 200]);
    await consistent(-10);
  });
  it("competing completions create one reversal only", async () => {
    const id = await pending();
    const results = await race(
      Prisma.sql`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`,
      [() => complete(id), () => complete(id)],
    );
    expect(
      results
        .map((r) => (r.status === "fulfilled" ? r.value.statusCode : r.reason))
        .sort(),
    ).toEqual([200, 400]);
    expect(await prisma.customerCredit.count({ where: { returnId: id } })).toBe(
      1,
    );
    await consistent(60);
  });
  it("rejects foreign recipients and unsupported refund/exchange choices", async () => {
    const other = await prisma.customer.create({
      data: { shopId, name: "Other" },
    });
    expect((await create(2, { customerId: other.id })).statusCode).toBe(400);
    for (const type of ["REFUND", "EXCHANGE"])
      expect((await create(2, { type })).statusCode).toBe(400);
    expect(await prisma.return.count({ where: { shopId } })).toBe(0);
    await consistent(100);
  });
  it("rejects a customer from another shop", async () => {
    const shop = await prisma.shop.create({
      data: {
        name: "Foreign",
        ownerYeboidSub: randomUUID(),
        ownerPhone: randomUUID(),
        ownerName: "Test",
      },
    });
    shops.push(shop.id);
    const foreign = await prisma.customer.create({
      data: { shopId: shop.id, name: "Foreign" },
    });
    expect((await create(2, { customerId: foreign.id })).statusCode).toBe(400);
    await consistent(100);
  });
  it("completes two distinct reserved returns once each under contention", async () => {
    const a = await pending(2),
      b = await pending(3);
    const results = await race(
      Prisma.sql`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`,
      [() => complete(a), () => complete(b)],
    );
    expect(
      results.map((r) =>
        r.status === "fulfilled" ? r.value.statusCode : r.reason,
      ),
    ).toEqual([200, 200]);
    await consistent(0);
    expect(
      await prisma.customerCredit.count({
        where: { saleId, type: "ADJUSTMENT" },
      }),
    ).toBe(2);
  });
  it("rejects ambiguous corrected history and ledger/balance drift", async () => {
    const id = await pending();
    await call(
      CustomerController.addCredit,
      { type: "ADJUSTMENT", amount: -1, saleId },
      customerId,
    );
    expect((await complete(id)).statusCode).toBe(400);
    await consistent(99);
    await prisma.customerCredit.deleteMany({
      where: { customerId, type: "ADJUSTMENT" },
    });
    expect((await complete(id)).statusCode).toBe(400);
  });
  it("rolls back reversal, balance, stock and status when the final update fails", async () => {
    const id = await pending();
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION reject_return_${shopId.replace(
        /[^a-z0-9]/g,
        "",
      )}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${id}' THEN RAISE EXCEPTION 'forced return rollback'; END IF; RETURN NEW; END $$`,
    );
    const fn = `reject_return_${shopId.replace(/[^a-z0-9]/g, "")}`;
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE UPDATE ON "Return" FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      expect((await complete(id)).statusCode).toBe(500);
      await consistent(100);
      expect(
        await prisma.customerCredit.count({ where: { returnId: id } }),
      ).toBe(0);
      expect(
        (await prisma.return.findUniqueOrThrow({ where: { id } })).status,
      ).toBe("PENDING");
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
          .quantity,
      ).toBe(5);
      expect(await prisma.stockLog.count({ where: { reference: id } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "Return"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
  });
});
