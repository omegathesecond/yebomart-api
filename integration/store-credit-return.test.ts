import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/config/prisma";
import { ReturnController } from "../src/controllers/return.controller";
import { applyCustomerCredit } from "../src/services/customerCredit.service";
import { race } from "./lockedRace";

let shopId: string, customerId: string, productId: string, saleId: string;
const shops: string[] = [];
beforeEach(async () => {
  const shop = await prisma.shop.create({
    data: {
      name: "Return credit",
      ownerYeboidSub: randomUUID(),
      ownerPhone: randomUUID(),
      ownerName: "Owner",
    },
  });
  shopId = shop.id;
  shops.push(shopId);
  customerId = (
    await prisma.customer.create({ data: { shopId, name: "Recipient" } })
  ).id;
  productId = (
    await prisma.product.create({
      data: { shopId, name: "Item", sellPrice: 10, costPrice: 5, quantity: 0 },
    })
  ).id;
  // Discounted subtotal 30, order discount 3, VAT 4.05 = actual charged 31.05.
  saleId = (
    await prisma.sale.create({
      data: {
        shopId,
        subtotal: 30,
        discount: 3,
        tax: 4.05,
        totalAmount: 31.05,
        amountPaid: 31.05,
        paymentMethod: "CASH",
        items: {
          create: {
            productId,
            productName: "Item",
            quantity: 3,
            unitPrice: 12,
            discount: 6,
            totalPrice: 30,
            costPrice: 5,
          },
        },
      },
    })
  ).id;
});
afterAll(async () => {
  for (const id of shops) {
    await prisma.return.deleteMany({ where: { shopId: id } });
    await prisma.customerCredit.deleteMany({ where: { shopId: id } });
    await prisma.sale.deleteMany({ where: { shopId: id } });
  }
  for (const id of shops) await prisma.shop.delete({ where: { id } });
  await prisma.$disconnect();
});
async function request(
  method: "create" | "process" | "getById",
  body: any,
  id = "",
  activeShop = shopId,
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
  await ReturnController[method](
    {
      user: { id: activeShop, shopId: activeShop, type: "shop", role: "OWNER" },
      params: { id },
      body,
    } as any,
    res,
  );
  return res;
}
function payload(quantity = 3, extra = {}) {
  return {
    saleId,
    customerId,
    reason: "Returned goods",
    type: "STORE_CREDIT",
    items: [
      {
        productId,
        productName: "Forged name",
        quantity,
        unitPrice: 999,
        restockable: true,
      },
    ],
    ...extra,
  };
}
async function create(quantity = 3) {
  const res = await request("create", payload(quantity));
  expect(res.statusCode).toBe(201);
  return res.body.data;
}
async function complete(id: string) {
  return request("process", { action: "complete" }, id);
}
async function assertCredit(id: string, amount: number) {
  const rows = await prisma.customerCredit.findMany({
    where: { returnId: id },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ type: "REFUND", amount, customerId, shopId });
  const detail = await request("getById", {}, id);
  expect(detail.body.data.creditReversal.id).toBe(rows[0].id);
  expect(detail.body.data.customer.name).toBe("Recipient");
}
describe("completed store-credit returns (real PostgreSQL)", () => {
  it("credits the full paid entitlement once, including VAT and discounts, with auditable details", async () => {
    const ret = await create();
    expect(ret.refundAmount).toBe(31.05);
    expect(await prisma.customerCredit.count({ where: { customerId } })).toBe(
      0,
    );
    expect((await complete(ret.id)).statusCode).toBe(200);
    expect((await complete(ret.id)).statusCode).toBe(400);
    await assertCredit(ret.id, 31.05);
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } }))
        .balance,
    ).toBe(-31.05);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .quantity,
    ).toBe(3);
  });
  it("partial and final returns exhaust precisely the original paid value", async () => {
    const first = await create(1);
    expect(first.refundAmount).toBe(10.35);
    expect((await complete(first.id)).statusCode).toBe(200);
    const last = await create(2);
    expect(last.refundAmount).toBe(20.7);
    expect((await complete(last.id)).statusCode).toBe(200);
    await assertCredit(first.id, 10.35);
    await assertCredit(last.id, 20.7);
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } }))
        .balance,
    ).toBeCloseTo(-31.05);
    expect((await request("create", payload(1))).statusCode).toBe(400);
  });
  it("allocates rounded VAT/discount value across products and shares reservations with cash refunds", async () => {
    const second = await prisma.product.create({
      data: { shopId, name: "Second", sellPrice: 5, costPrice: 1 },
    });
    await prisma.saleItem.create({
      data: {
        saleId,
        productId: second.id,
        productName: "Second",
        quantity: 1,
        unitPrice: 5,
        totalPrice: 5,
        costPrice: 1,
      },
    });
    await prisma.sale.update({
      where: { id: saleId },
      data: { totalAmount: 33.33, amountPaid: 33.33 },
    });
    const first = await create(1);
    expect(first.refundAmount).toBe(9.52);
    expect((await complete(first.id)).statusCode).toBe(200);
    const refund = await request("create", payload(2, { type: "REFUND" }));
    expect(refund.statusCode).toBe(201);
    expect(refund.body.data.refundAmount).toBe(19.05);
    expect((await request("process", { action: "approve" }, refund.body.data.id)).statusCode).toBe(200);
    expect((await request("process", {
      action: "complete",
      settlement: { method: "CARD", confirmed: true, reference: "external-refund-success" },
    }, refund.body.data.id)).statusCode).toBe(200);
    expect((await request("create", payload(1))).statusCode).toBe(400);
    const last = await request(
      "create",
      payload(1, {
        items: [
          {
            productId: second.id,
            productName: "Second",
            quantity: 1,
            unitPrice: 999,
          },
        ],
      }),
    );
    expect(last.statusCode).toBe(201);
    expect(last.body.data.refundAmount).toBe(4.76);
    expect((await complete(last.body.data.id)).statusCode).toBe(200);
    expect(
      first.refundAmount +
        refund.body.data.refundAmount +
        last.body.data.refundAmount,
    ).toBeCloseTo(33.33);
  });
  it("rolls back persisted ledger, balance and restocking if final status write fails", async () => {
    const ret = await create();
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION fail_return_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${ret.id}' AND NEW.status = 'COMPLETED' THEN RAISE EXCEPTION 'injected completion failure'; END IF; RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER fail_return_status BEFORE UPDATE ON "Return" FOR EACH ROW EXECUTE FUNCTION fail_return_status()',
    );
    try {
      expect((await complete(ret.id)).statusCode).toBe(500);
      expect(
        (await prisma.return.findUniqueOrThrow({ where: { id: ret.id } }))
          .status,
      ).toBe("PENDING");
      expect(
        (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } }))
          .balance,
      ).toBe(0);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
          .quantity,
      ).toBe(0);
      expect(
        await prisma.stockLog.count({ where: { reference: ret.id } }),
      ).toBe(0);
      expect(
        await prisma.customerCredit.count({ where: { returnId: ret.id } }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER fail_return_status ON "Return"',
      );
      await prisma.$executeRawUnsafe("DROP FUNCTION fail_return_status()");
    }
  });
  it("rejects missing, foreign and moved recipients at creation/completion", async () => {
    expect(
      (await request("create", payload(1, { customerId: undefined })))
        .statusCode,
    ).toBe(400);
    const foreignShop = await prisma.shop.create({
      data: {
        name: "Other",
        ownerYeboidSub: randomUUID(),
        ownerPhone: randomUUID(),
        ownerName: "Owner",
      },
    });
    shops.push(foreignShop.id);
    const foreign = await prisma.customer.create({
      data: { shopId: foreignShop.id, name: "Foreign" },
    });
    expect(
      (await request("create", payload(1, { customerId: foreign.id })))
        .statusCode,
    ).toBe(400);
    const ret = await create(1);
    await prisma.customer.update({
      where: { id: customerId },
      data: { shopId: foreignShop.id },
    });
    expect((await complete(ret.id)).statusCode).toBe(400);
    expect(
      await prisma.customerCredit.count({ where: { returnId: ret.id } }),
    ).toBe(0);
  });
  it("rejects receiptless, unpaid, CREDIT, and combined exchange benefits", async () => {
    expect(
      (await request("create", payload(1, { saleId: undefined }))).statusCode,
    ).toBe(400);
    expect(
      (
        await request(
          "create",
          payload(1, {
            exchangeItems: [
              { productId, productName: "Item", quantity: 1, unitPrice: 10 },
            ],
          }),
        )
      ).statusCode,
    ).toBe(400);
    await prisma.sale.update({
      where: { id: saleId },
      data: { amountPaid: 0 },
    });
    expect((await request("create", payload(1))).statusCode).toBe(400);
    await prisma.sale.update({
      where: { id: saleId },
      data: { amountPaid: 31.05, paymentMethod: "CREDIT" },
    });
    expect((await request("create", payload(1))).statusCode).toBe(400);
  });
  it("revalidates paid receipt and persisted entitlement before completion", async () => {
    const ret = await create(1);
    await prisma.sale.update({
      where: { id: saleId },
      data: { paymentMethod: "CREDIT" },
    });
    expect((await complete(ret.id)).statusCode).toBe(400);
    await prisma.sale.update({
      where: { id: saleId },
      data: { paymentMethod: "CASH" },
    });
    await prisma.return.update({
      where: { id: ret.id },
      data: { refundAmount: 0 },
    });
    expect((await complete(ret.id)).statusCode).toBe(400);
    expect(
      await prisma.customerCredit.count({ where: { returnId: ret.id } }),
    ).toBe(0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .quantity,
    ).toBe(0);
  });
  it("competing completions have one ledger/stock winner and the unique return link prevents duplicate entries", async () => {
    const ret = await create();
    const results = await race(
      Prisma.sql`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`,
      [() => complete(ret.id), () => complete(ret.id)],
    );
    const codes = results.map((r) => {
      if (r.status === "rejected") throw r.reason;
      return r.value.statusCode;
    });
    expect(codes.sort()).toEqual([200, 400]);
    await assertCredit(ret.id, 31.05);
    await expect(
      prisma.$transaction((tx) =>
        applyCustomerCredit(
          tx,
          {
            shopId,
            customerId,
            type: "REFUND",
            amount: 31.05,
            returnId: ret.id,
          },
          { currencySymbol: "" },
        ),
      ),
    ).rejects.toThrow();
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .quantity,
    ).toBe(3);
  });
  it("serializes completion with another ledger writer without losing either effect", async () => {
    const ret = await create();
    const results = await race(
      Prisma.sql`SELECT id FROM "Customer" WHERE id = ${customerId} FOR UPDATE`,
      [
        () => complete(ret.id),
        () =>
          prisma.$transaction((tx) =>
            applyCustomerCredit(
              tx,
              { shopId, customerId, type: "PURCHASE", amount: 50 },
              { currencySymbol: "" },
            ),
          ),
      ],
    );
    for (const r of results) {
      if (r.status === "rejected") throw r.reason;
    }
    expect((results[0] as any).value.statusCode).toBe(200);
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } }))
        .balance,
    ).toBeCloseTo(18.95);
    expect(await prisma.customerCredit.count({ where: { customerId } })).toBe(
      2,
    );
  });
  it("rolls back completion on injected ledger failure, then can complete normally", async () => {
    const ret = await create();
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION fail_return_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."returnId" = '${ret.id}' THEN RAISE EXCEPTION 'injected ledger failure'; END IF; RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER fail_return_credit BEFORE INSERT ON "CustomerCredit" FOR EACH ROW EXECUTE FUNCTION fail_return_credit()',
    );
    try {
      expect((await complete(ret.id)).statusCode).toBe(500);
      expect(
        await prisma.return.findUniqueOrThrow({
          where: { id: ret.id },
          include: { items: true },
        }),
      ).toMatchObject({
        status: "PENDING",
        processedAt: null,
        items: [expect.objectContaining({ restocked: false })],
      });
      expect(
        (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } }))
          .balance,
      ).toBe(0);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
          .quantity,
      ).toBe(0);
      expect(
        await prisma.stockLog.count({ where: { reference: ret.id } }),
      ).toBe(0);
      expect(
        await prisma.customerCredit.count({ where: { returnId: ret.id } }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER fail_return_credit ON "CustomerCredit"',
      );
      await prisma.$executeRawUnsafe("DROP FUNCTION fail_return_credit()");
    }
    expect((await complete(ret.id)).statusCode).toBe(200);
    await assertCredit(ret.id, 31.05);
  });
});
