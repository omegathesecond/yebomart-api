import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/config/prisma";
import { PurchaseOrderController } from "../src/controllers/purchaseOrder.controller";
import { race as lockedRace } from "./lockedRace";

let shopId: string, supplierId: string, poId: string;
const shops: string[] = [];
beforeEach(async () => {
  const shop = await prisma.shop.create({
    data: {
      name: "Supplier payment concurrency",
      ownerYeboidSub: randomUUID(),
      ownerPhone: randomUUID(),
      ownerName: "Test owner",
    },
  });
  shopId = shop.id;
  shops.push(shopId);
  const supplier = await prisma.supplier.create({
    data: { shopId, name: "Supplier", balance: 100 },
  });
  supplierId = supplier.id;
  const product = await prisma.product.create({
    data: { shopId, name: "Stock", costPrice: 10, sellPrice: 15, quantity: 10 },
  });
  const po = await prisma.purchaseOrder.create({
    data: {
      shopId,
      supplierId,
      status: "PARTIAL",
      subtotal: 200,
      totalAmount: 200,
      amountReceived: 100,
      items: {
        create: {
          productId: product.id,
          productName: "Stock",
          quantity: 20,
          receivedQty: 10,
          unitCost: 10,
          totalCost: 200,
        },
      },
    },
  });
  poId = po.id;
  await prisma.supplierLedger.create({
    data: { shopId, supplierId, poId, type: "BILL", amount: 100 },
  });
});
afterAll(async () => {
  for (const id of shops) await prisma.shop.delete({ where: { id } });
  await prisma.$disconnect();
});
async function request(
  method: "recordPayment" | "receive" | "getPayments",
  body: any = {},
  activeShop = shopId,
  userId?: string,
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
  await PurchaseOrderController[method](
    {
      user: {
        id: userId ?? activeShop,
        shopId: activeShop,
        type: userId ? "user" : "shop",
        role: "OWNER",
      },
      params: { id: poId },
      body: method === 'recordPayment' ? { fundingSource: 'OUTSIDE_TILL', submissionKey: randomUUID(), ...body } : body,
    } as any,
    res,
  );
  return res;
}
async function race(ops: (() => Promise<any>)[]) {
  const results = await lockedRace(
    Prisma.sql`SELECT id FROM "PurchaseOrder" WHERE id = ${poId} FOR UPDATE`,
    ops,
  );
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
async function consistent(received: number, paid: number, payments: number) {
  const po = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: poId },
  });
  const supplier = await prisma.supplier.findUniqueOrThrow({
    where: { id: supplierId },
  });
  const entries = await prisma.supplierLedger.findMany({ where: { poId } });
  expect(po.amountReceived).toBe(received);
  expect(po.amountPaid).toBe(paid);
  expect(entries.filter((e) => e.type === "PAYMENT")).toHaveLength(payments);
  expect(supplier.balance).toBe(received - paid);
  expect(
    entries.reduce(
      (sum, e) => sum + (e.type === "PAYMENT" ? -e.amount : e.amount),
      0,
    ),
  ).toBe(supplier.balance);
}
describe("Postgres supplier payable serialization", () => {
  it("rejects one of two overlapping 80 payments against 100 without drift", async () => {
    const results = await race([
      () => request("recordPayment", { amount: 80 }),
      () => request("recordPayment", { amount: 80 }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(results.find((r) => r.statusCode === 400).body.message).toContain(
      "exceeds",
    );
    expect(results.find((r) => r.statusCode === 200).body.data.balanceDue).toBe(
      20,
    );
    await consistent(100, 80, 1);
  });
  it("settles two valid partial payments and preserves history and sequential rejection", async () => {
    const results = await race([
      () => request("recordPayment", { amount: 40, note: "First" }),
      () => request("recordPayment", { amount: 60, note: "Second" }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results.some((r) => r.body.data.balanceDue === 0)).toBe(true);
    await consistent(100, 100, 2);
    const history = await request("getPayments");
    expect(history.body.data).toHaveLength(3);
    expect(
      history.body.data
        .filter((e: any) => e.type === "PAYMENT")
        .map((e: any) => e.note)
        .sort(),
    ).toEqual(["First", "Second"]);
    expect((await request("recordPayment", { amount: 1 })).statusCode).toBe(
      400,
    );
    await consistent(100, 100, 2);
  });
  it("serializes a payment and receipt without deadlock or lost payable updates", async () => {
    const results = await race([
      () => request("recordPayment", { amount: 80 }),
      () => request("receive"),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    await consistent(200, 80, 1);
    expect(
      (await request("recordPayment", { amount: 120 })).body.data.balanceDue,
    ).toBe(0);
    await consistent(200, 200, 2);
  });
  it("rejects foreign-shop payment and receipt without writes", async () => {
    expect(
      (await request("recordPayment", { amount: 80 }, randomUUID())).statusCode,
    ).toBe(404);
    expect((await request("receive", {}, randomUUID())).statusCode).toBe(404);
    await consistent(100, 0, 0);
  });
  it("rolls back PAYMENT and supplier decrement if the final PO update fails", async () => {
    // A real PostgreSQL trigger fails after the ledger and supplier writes.
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION fail_supplier_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${poId}' AND NEW."amountPaid" > OLD."amountPaid" THEN RAISE EXCEPTION 'test PO update failure'; END IF; RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER fail_supplier_payment BEFORE UPDATE ON "PurchaseOrder" FOR EACH ROW EXECUTE FUNCTION fail_supplier_payment()',
    );
    try {
      const result = await request("recordPayment", { amount: 80 });
      expect(result.statusCode).toBe(500);
      await consistent(100, 0, 0);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER fail_supplier_payment ON "PurchaseOrder"',
      );
      await prisma.$executeRawUnsafe("DROP FUNCTION fail_supplier_payment()");
    }
  });
});
