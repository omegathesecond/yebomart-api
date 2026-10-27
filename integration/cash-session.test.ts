import { race } from "./lockedRace";
import { randomUUID } from "crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { CashSessionService as tills } from "../src/services/cashSession.service";

const shops: string[] = [];
let shopId: string;
beforeEach(async () => {
  const shop = await prisma.shop.create({
    data: {
      name: "Till concurrency",
      ownerName: "Test",
      ownerYeboidSub: randomUUID(),
      ownerPhone: randomUUID(),
    },
  });
  shopId = shop.id;
  shops.push(shopId);
});
afterAll(async () => {
  for (const id of shops) {
    await prisma.sale.deleteMany({ where: { shopId: id } });
    await prisma.shop.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

function winner<T>(results: PromiseSettledResult<T>[]) {
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failed = results.filter(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult[];
  expect(failed).toHaveLength(1);
  expect(failed[0].reason).toMatchObject({ code: "CONFLICT" });
  return (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<T>
  ).value;
}

describe("Postgres till transitions", () => {
  it("allows exactly one simultaneous open, guarded even for direct DB writes", async () => {
    const opened = winner(
      await race(Prisma.sql`LOCK TABLE "CashSession" IN SHARE MODE`, [
        () => tills.open({ shopId, openingFloat: 100 }),
        () => tills.open({ shopId, openingFloat: 200 }),
      ]),
    );
    expect(
      await prisma.cashSession.count({ where: { shopId, status: "OPEN" } }),
    ).toBe(1);
    expect(opened.userId).toBeNull();
    await expect(
      prisma.cashSession.create({ data: { shopId, openingFloat: 0 } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("persists only the winning reconciliation and rejects repeated closes unchanged", async () => {
    const session = await tills.open({ shopId, openingFloat: 100 });
    await prisma.sale.create({
      data: {
        shopId,
        cashSessionId: session.id,
        subtotal: 40,
        totalAmount: 40,
        amountPaid: 40,
        paymentMethod: "CASH",
        createdAt: new Date(session.openedAt.getTime() + 1),
      },
    });
    const closed = winner(
      await race(
        Prisma.sql`SELECT id FROM "CashSession" WHERE id = ${session.id} FOR UPDATE`,
        [111, 222].map(
          (countedCash) => () =>
            tills.close({
              shopId,
              sessionId: session.id,
              countedCash,
              notes: `count ${countedCash}`,
            }),
        ),
      ),
    );
    expect(closed).toMatchObject({
      status: "CLOSED",
      expectedCash: 140,
      variance: closed.countedCash - 140,
      notes: `count ${closed.countedCash}`,
    });
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(
      await prisma.cashSession.findUnique({
        where: { id: session.id },
        include: { user: { select: { id: true, name: true } } },
      }),
    ).toEqual(closed);
    await expect(
      tills.close({
        shopId,
        sessionId: session.id,
        countedCash: 999,
        notes: "overwrite",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await prisma.cashSession.findUnique({
        where: { id: session.id },
        include: { user: { select: { id: true, name: true } } },
      }),
    ).toEqual(closed);
    const reopened = await tills.open({ shopId, openingFloat: 5 });
    expect(reopened.id).not.toBe(session.id);
    expect(reopened.status).toBe("OPEN");
  });

  it("keeps shops independent and preserves staff attribution and shop isolation", async () => {
    const other = await prisma.shop.create({
      data: {
        name: "Other till",
        ownerName: "Test",
        ownerYeboidSub: randomUUID(),
        ownerPhone: randomUUID(),
      },
    });
    shops.push(other.id);
    const staff = await prisma.user.create({
      data: { shopId, name: "Cashier", phone: randomUUID(), role: "CASHIER" },
    });
    const opened = await race(
      Prisma.sql`LOCK TABLE "CashSession" IN SHARE MODE`,
      [
        () => tills.open({ shopId, userId: staff.id, openingFloat: 10 }),
        () => tills.open({ shopId: other.id, openingFloat: 20 }),
      ],
    );
    expect(opened.every((r) => r.status === "fulfilled")).toBe(true);
    const session = await tills.getCurrent(shopId);
    expect(session!.userId).toBe(staff.id);
    await expect(
      tills.close({ shopId: other.id, sessionId: session!.id, countedCash: 0 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const closed = await Promise.all(
      [shopId, other.id].map(async (id) => {
        const current = await tills.getCurrent(id);
        return tills.close({
          shopId: id,
          sessionId: current!.id,
          countedCash: current!.openingFloat,
        });
      }),
    );
    expect(closed.map((s) => s.variance)).toEqual([0, 0]);
  });
});
