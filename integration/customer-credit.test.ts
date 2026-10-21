import { Prisma } from "@prisma/client";
import { race as lockedRace } from "./lockedRace";
import { randomUUID } from "crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/config/prisma";
import { SaleService } from "../src/services/sale.service";
import { CustomerController } from "../src/controllers/customer.controller";
import { CreditLimitExceededError } from "../src/services/customerCredit.service";

vi.mock("../src/services/shop.service", () => ({
  ShopService: { incrementUsage: vi.fn().mockResolvedValue(undefined) },
}));

let shopId: string, customerId: string, userId: string;
const shops: string[] = [];
// Allocate distinct receipts for the two-sale race so receipt uniqueness/retry
// cannot accidentally serialize credit checks and hide the original bug.
// All balances, ledger, stock, sales and transactions still use real Postgres.
let receiptSequence: number | null = null;
prisma.$use(async (params, next) => {
  if (
    receiptSequence !== null &&
    params.model === "Sale" &&
    params.action === "count"
  ) {
    return receiptSequence++;
  }
  return next(params);
});
beforeEach(async () => {
  const shop = await prisma.shop.create({
    data: {
      name: "Credit concurrency test",
      ownerYeboidSub: randomUUID(),
      ownerName: "Test owner",
      ownerPhone: randomUUID(),
    },
  });
  shopId = shop.id;
  shops.push(shopId);
  const user = await prisma.user.create({
    data: { shopId, name: "Test", phone: randomUUID(), role: "OWNER" },
  });
  userId = user.id;
  const customer = await prisma.customer.create({
    data: { shopId, name: "Test customer", balance: 80, creditLimit: 100 },
  });
  customerId = customer.id;
  await prisma.customerCredit.create({
    data: { shopId, customerId, type: "PURCHASE", amount: 80, userId },
  });
});
afterAll(async () => {
  for (const id of shops) {
    await prisma.saleItem.deleteMany({ where: { sale: { shopId: id } } });
    await prisma.stockLog.deleteMany({ where: { shopId: id } });
    await prisma.sale.deleteMany({ where: { shopId: id } });
    await prisma.shop.delete({ where: { id } });
  }
  await prisma.$disconnect();
});
async function product() {
  return prisma.product.create({
    data: {
      shopId,
      name: "Test stock",
      costPrice: 5,
      sellPrice: 15,
      quantity: 10,
    },
  });
}
async function sale(productId: string) {
  try {
    return await SaleService.create({
      shopId,
      userId,
      customerId,
      paymentMethod: "CREDIT",
      amountPaid: 0,
      items: [{ productId, quantity: 1 }],
    });
  } catch (error) {
    return error;
  }
}
async function manual(
  type = "PURCHASE",
  amount = 15,
  override = false,
  role = "CASHIER",
) {
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
  };
  await CustomerController.addCredit(
    {
      user: { id: userId, shopId, role },
      params: { id: customerId },
      body: { type, amount, override },
    } as any,
    res,
  );
  return res;
}

// Both requests must reach the locked customer row before either proceeds.
async function race(operations: (() => Promise<any>)[]) {
  const results = await lockedRace(
    Prisma.sql`SELECT id FROM "Customer" WHERE id = ${customerId} FOR UPDATE`,
    operations,
  );
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
async function consistent(expected: number) {
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId },
  });
  const entries = await prisma.customerCredit.findMany({
    where: { customerId },
  });
  const total = entries.reduce(
    (sum, entry) =>
      sum +
      (["PAYMENT", "REFUND"].includes(entry.type)
        ? -entry.amount
        : entry.amount),
    0,
  );
  expect(customer.balance).toBe(expected);
  expect(total).toBe(expected);
}
describe("Postgres credit serialization across real request paths", () => {
  it("two sales: losing sale rolls back stock, sale, items, stock log and ledger", async () => {
    const a = await product(),
      b = await product();
    receiptSequence = 0;
    let results: any[];
    try {
      results = await race([() => sale(a.id), () => sale(b.id)]);
    } finally {
      receiptSequence = null;
    }
    expect(
      results.filter((result) => result instanceof CreditLimitExceededError),
    ).toHaveLength(1);
    expect(await prisma.sale.count({ where: { shopId } })).toBe(1);
    expect(await prisma.saleItem.count({ where: { sale: { shopId } } })).toBe(
      1,
    );
    expect(await prisma.stockLog.count({ where: { shopId } })).toBe(1);
    const stock = await prisma.product.findMany({ where: { shopId } });
    expect(stock.map((p) => p.quantity).sort((a, b) => a - b)).toEqual([9, 10]);
    expect(await prisma.customerCredit.count({ where: { customerId } })).toBe(
      2,
    );
    await consistent(95);
  });
  it.each(["PURCHASE", "ADJUSTMENT"])(
    "two manual %s entries return one public 422",
    async (type) => {
      const results = await race([() => manual(type), () => manual(type)]);
      expect(results.map((result) => result.statusCode).sort()).toEqual([
        200, 422,
      ]);
      const failure = results.find((result) => result.statusCode === 422);
      expect(failure.body.code).toBe("CREDIT_LIMIT_EXCEEDED");
      await consistent(95);
    },
  );
  it("sale versus manual debt share the same lock", async () => {
    const p = await product();
    const results = await race([() => sale(p.id), () => manual()]);
    expect(
      results.filter(
        (result) =>
          result instanceof CreditLimitExceededError ||
          result.statusCode === 422,
      ),
    ).toHaveLength(1);
    await consistent(95);
  });
  it("explicit owner override works, cashier override cannot bypass the limit", async () => {
    const results = await race([
      () => manual("PURCHASE", 15, true, "OWNER"),
      () => manual("ADJUSTMENT", 15, true, "OWNER"),
    ]);
    expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
    await consistent(110);
    expect((await manual("PURCHASE", 1, true)).statusCode).toBe(422);
    expect((await manual("PURCHASE", 1, false, "OWNER")).statusCode).toBe(422);
    expect((await manual("PAYMENT", 10)).statusCode).toBe(200);
    expect((await manual("REFUND", 5)).statusCode).toBe(200);
    expect((await manual("ADJUSTMENT", -5)).statusCode).toBe(200);
    await consistent(90);
  });
  it("zero limit remains unlimited under concurrent sale and manual writes", async () => {
    await prisma.customer.update({
      where: { id: customerId },
      data: { creditLimit: 0 },
    });
    const p = await product();
    const results = await race([
      () => sale(p.id),
      () => manual("ADJUSTMENT", 15),
    ]);
    expect(results[0]).not.toBeInstanceOf(Error);
    expect(results[1].statusCode).toBe(200);
    await consistent(110);
  });
});
