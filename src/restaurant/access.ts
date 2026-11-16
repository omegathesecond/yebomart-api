import { Request } from "express";
import { prisma } from "@config/prisma";
import { recommendedModules } from "./capabilities";
import { RestaurantError } from "./domain";
// This is also enforced for direct API calls; hiding a navigation item is not authorization.
export async function enforceWorkspace(
  req: Request,
  user: { shopId: string; id: string; type: string; role: string },
) {
  const path = req.originalUrl.split("?")[0];
  const [workspace, shop, staff] = await Promise.all([
    prisma.businessWorkspace.findUnique({ where: { shopId: user.shopId } }),
    prisma.shop.findUnique({
      where: { id: user.shopId },
      select: { businessType: true },
    }),
    user.type === "user"
      ? prisma.user.findFirst({
          where: { id: user.id, shopId: user.shopId, isActive: true },
          select: { restaurantDuty: true },
        })
      : null,
  ]);
  const kitchen = staff?.restaurantDuty === "KITCHEN";
  if (kitchen) {
    if (
      path === "/api/workspace" ||
      path === "/api/workspace/overview" ||
      path === "/api/auth/me" ||
      path === "/api/auth/logout" ||
      (req.method === "GET" && path === "/api/restaurant/orders") ||
      (req.method === "POST" &&
        /^\/api\/restaurant\/orders\/[^/]+\/status$/.test(path))
    )
      return;
    throw new RestaurantError(
      403,
      "This account is assigned to the kitchen. Ask your manager to change its duties.",
    );
  }
  const modules =
    workspace?.modules ?? recommendedModules(shop?.businessType ?? "general");
  const root = path.split("/")[2];
  const moduleByRoot: Record<string, string> = {
    restaurant: "restaurant",
    stock: "stock",
    customers: "customers",
    suppliers: "suppliers",
    "purchase-orders": "suppliers",
    expenses: "expenses",
    reports: "reports",
    users: "team",
    staff: "team",
    sales: "sell",
    returns: "sell",
    "cash-sessions": "sell",
  };
  const module = moduleByRoot[root];
  if (module && !modules.includes(module))
    throw new RestaurantError(
      403,
      "This activity is not enabled for this business. The owner can change workspace settings.",
    );
  if (
    root === "products" &&
    !modules.includes("catalogue") &&
    !modules.includes("sell") &&
    !modules.includes("restaurant")
  )
    throw new RestaurantError(
      403,
      "Products are not enabled for this business.",
    );
  if (
    user.role === "CASHIER" &&
    [
      "reports",
      "users",
      "staff",
      "expenses",
      "customers",
      "suppliers",
      "purchase-orders",
      "audit",
      "ai",
    ].includes(root)
  )
    throw new RestaurantError(
      403,
      "Ask a manager to open this part of the business.",
    );
}
