import { CREDIT_COSTS } from "@config/creditPacks";
import { prisma } from "@config/prisma";
import { YeboLinkClient } from "@services/yebolink.client";
import { consumeAllowance } from "@services/entitlement.service";
import { BillingService } from "@services/billing.service";
import { assert, parts, type TicketLine } from "./domain";
import { profile } from "./service";

export async function restaurantReport(
  shopId: string,
  days = 1,
  now = new Date(),
) {
  const p = await profile(shopId),
    since = new Date(now.getTime() - days * 86400000);
  const tickets = await prisma.restaurantTicket.findMany({
    where: { shopId, createdAt: { gte: since, lte: now } },
    orderBy: { createdAt: "desc" },
  });
  const paid = tickets.filter((t) => t.paymentStatus === "PAID"),
    completed = tickets.filter((t) => t.status === "COMPLETED");
  const top = new Map<string, { name: string; quantity: number }>();
  completed.forEach((t) =>
    (t.items as unknown as TicketLine[]).forEach((i) => {
      const v = top.get(i.productId) ?? { name: i.name, quantity: 0 };
      v.quantity += i.quantity;
      top.set(i.productId, v);
    }),
  );
  const timed = completed.filter((t) => t.acceptedAt && t.readyAt);
  return {
    business: p.shop.name,
    currency: p.shop.currency,
    from: since.toISOString(),
    to: now.toISOString(),
    periodLabel: "Last " + (days === 1 ? "24 hours" : days + " days"),
    orders: tickets.length,
    completed: completed.length,
    cancelled: tickets.filter((t) => t.status === "CANCELLED").length,
    open: tickets.filter((t) => !["COMPLETED", "CANCELLED"].includes(t.status))
      .length,
    collectedMinor: paid.reduce((n, t) => n + t.totalMinor, 0),
    unpaidMinor: tickets
      .filter((t) => t.status !== "CANCELLED" && t.paymentStatus !== "PAID")
      .reduce((n, t) => n + t.totalMinor, 0),
    averagePrepMinutes: timed.length
      ? Math.round(
          timed.reduce(
            (n, t) =>
              n + (t.readyAt!.getTime() - t.acceptedAt!.getTime()) / 60000,
            0,
          ) / timed.length,
        )
      : null,
    topItems: [...top.values()]
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5),
    unavailableItems: p.unavailableProductIds.length,
    needsReconciliation: tickets.filter(
      (t) =>
        t.checkoutState === "UNKNOWN" ||
        (t.paymentStatus === "PAID" && !t.saleId),
    ).length,
  };
}
function reportText(
  r: Awaited<ReturnType<typeof restaurantReport>>,
  kind: string,
) {
  return [
    r.business + " — " + kind.toLowerCase() + " report",
    r.periodLabel + " ending " + r.to.slice(0, 16) + " UTC",
    "Orders: " +
      r.orders +
      " | Completed: " +
      r.completed +
      " | Cancelled: " +
      r.cancelled,
    "Payments recorded: " +
      r.currency +
      " " +
      (r.collectedMinor / 100).toFixed(2),
    "Unpaid open orders: " +
      r.currency +
      " " +
      (r.unpaidMinor / 100).toFixed(2),
    "Average accepted-to-ready time: " +
      (r.averagePrepMinutes === null
        ? "not enough completed orders"
        : r.averagePrepMinutes + " minutes"),
    ...r.topItems.map((i) => i.name + ": " + i.quantity + " completed"),
    r.needsReconciliation
      ? "Action: " +
        r.needsReconciliation +
        " payment/sale records need reconciliation."
      : "",
    r.unavailableItems
      ? "Action: review " + r.unavailableItems + " items marked unavailable."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
export async function queueReports(now = new Date()) {
  const subscriptions = await prisma.restaurantReportSubscription.findMany({
    where: { enabled: true },
    include: { restaurant: { include: { shop: true } } },
  });
  for (const s of subscriptions) {
    const local = parts(now, s.restaurant.shop.timezone);
    if (
      Math.floor(local.minute / 60) < s.localHour ||
      (s.kind === "WEEKLY" && local.day !== 1)
    )
      continue;
    const key = "report:" + s.id + ":" + local.date;
    if (await prisma.restaurantDelivery.findUnique({ where: { key } }))
      continue;
    const report = await restaurantReport(
      s.shopId,
      s.kind === "WEEKLY" ? 7 : 1,
      now,
    );
    await prisma.restaurantDelivery.upsert({
      where: { key },
      create: {
        key,
        shopId: s.shopId,
        channel: s.channel,
        recipient: s.recipient,
        content: reportText(report, s.kind),
        meteredAction: s.kind === "DAILY" ? "DAILY_REPORT" : "WHATSAPP",
      },
      update: {},
    });
  }
}
export async function runDeliveries() {
  const rows = await prisma.restaurantDelivery.findMany({
    where: { status: "PENDING" },
    take: 50,
    orderBy: { createdAt: "asc" },
  });
  const result = { accepted: 0, blocked: 0, unknown: 0 };
  for (const d of rows) {
    const claim = await prisma.restaurantDelivery.updateMany({
      where: { id: d.id, status: "PENDING" },
      data: { status: "SENDING" },
    });
    if (!claim.count) continue;
    let sending = false;
    try {
      if (d.key.startsWith("report:")) {
        const subscription =
          await prisma.restaurantReportSubscription.findUnique({
            where: { id: d.key.split(":")[1] },
          });
        if (!subscription?.enabled) {
          await prisma.restaurantDelivery.update({
            where: { id: d.id },
            data: {
              status: "CANCELLED",
              error: "The report subscription was turned off.",
            },
          });
          continue;
        }
      }
      if (d.channel === "WHATSAPP") {
        const entitled = await consumeAllowance(
          d.shopId,
          d.meteredAction === "DAILY_REPORT" ? "DAILY_REPORT" : "WHATSAPP",
        );
        if (!entitled) {
          await prisma.restaurantDelivery.update({
            where: { id: d.id },
            data: {
              status: "BLOCKED",
              error:
                "The current plan has no remaining WhatsApp allowance. Choose a plan or use the order/report page.",
            },
          });
          result.blocked++;
          continue;
        }
      } else {
        const balance = await BillingService.getShopBalance(d.shopId);
        if (balance.available < CREDIT_COSTS.EMAIL) {
          await prisma.restaurantDelivery.update({
            where: { id: d.id },
            data: {
              status: "BLOCKED",
              error:
                "Email requires 1 credit. Top up before enabling more email reports.",
            },
          });
          result.blocked++;
          continue;
        }
      }
      sending = true;
      const receipt =
        d.channel === "WHATSAPP"
          ? await YeboLinkClient.sendWhatsApp(d.recipient, d.content)
          : await YeboLinkClient.sendEmail(
              d.recipient,
              "Your YeboMart restaurant report",
              "<pre>" +
                d.content.replace(
                  /[&<>]/g,
                  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!,
                ) +
                "</pre>",
            );
      assert(
        receipt.messageId,
        "YeboLink accepted no verifiable message reference.",
        502,
      );
      await prisma.restaurantDelivery.update({
        where: { id: d.id },
        data: { status: "ACCEPTED", messageId: receipt.messageId, error: null },
      });
      if (d.channel === "EMAIL") {
        try {
          await BillingService.chargeShopCredits({
            shopId: d.shopId,
            amount: CREDIT_COSTS.EMAIL,
            description: "Restaurant report email",
            idempotencyKey: "restaurant-delivery:" + d.id,
          });
        } catch {
          await prisma.restaurantDelivery.update({
            where: { id: d.id },
            data: {
              error:
                "Provider accepted the email; usage billing needs reconciliation. Do not resend.",
            },
          });
        }
      }
      result.accepted++;
    } catch {
      await prisma.restaurantDelivery.update({
        where: { id: d.id },
        data: {
          status: sending ? "UNKNOWN" : "FAILED",
          error: sending
            ? "Message acceptance could not be confirmed. Do not resend automatically. Check the YeboLink receipt before retrying."
            : "Message could not start. Check the messaging connection and allowance.",
        },
      });
      result.unknown++;
    }
  }
  // A process interrupted after a send began is ambiguous, never safe to retry blindly.
  await prisma.restaurantDelivery.updateMany({
    where: {
      status: "SENDING",
      updatedAt: { lt: new Date(Date.now() - 5 * 60000) },
    },
    data: {
      status: "UNKNOWN",
      error:
        "The send was interrupted; check its provider receipt before any resend.",
    },
  });
  return result;
}
