import { prisma } from "@config/prisma";
import { recordSale, reconcilePayment } from "./service";
export async function reconcileRestaurantPayments() {
  const rows = await prisma.restaurantTicket.findMany({
    where: {
      paymentMethod: "ONLINE",
      status: { not: "CANCELLED" },
      OR: [
        { paymentStatus: "UNPAID", checkoutId: { not: null } },
        { paymentStatus: "PAID", saleId: null },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  let reconciled = 0,
    failed = 0;
  for (const t of rows)
    try {
      const checked = await reconcilePayment(t.id);
      if (checked.paymentStatus === "PAID") {
        await recordSale(t.shopId, t.id);
        reconciled++;
      }
    } catch {
      await prisma.restaurantTicket.update({
        where: { id: t.id },
        data: {
          failure:
            "Payment or sale confirmation failed. Check YeboPay and reconcile this order before handover.",
        },
      });
      failed++;
    }
  await prisma.restaurantTicket.updateMany({
    where: {
      checkoutState: "CREATING",
      updatedAt: { lt: new Date(Date.now() - 5 * 60000) },
    },
    data: {
      checkoutState: "UNKNOWN",
      failure:
        "Payment creation was interrupted. Check YeboPay before any further payment.",
    },
  });
  return { reconciled, failed };
}
