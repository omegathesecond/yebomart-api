export const MODULES = [
  "sell",
  "catalogue",
  "stock",
  "customers",
  "suppliers",
  "expenses",
  "reports",
  "team",
  "restaurant",
] as const;
export type Module = (typeof MODULES)[number];
export const navigation = [
  {
    id: "home",
    name: "Overview",
    href: "/",
    group: "Today",
    roles: ["OWNER", "MANAGER", "CASHIER"],
  },
  {
    id: "sell",
    name: "Till",
    href: "/pos",
    group: "Today",
    roles: ["OWNER", "MANAGER", "CASHIER"],
  },
  {
    id: "sell",
    name: "Cash-up",
    href: "/cash-up",
    group: "Today",
    roles: ["OWNER", "MANAGER", "CASHIER"],
  },
  {
    id: "restaurant",
    name: "Orders & kitchen",
    href: "/restaurant/orders",
    group: "Today",
    roles: ["OWNER", "MANAGER", "CASHIER"],
  },
  {
    id: "restaurant",
    name: "Menu & website",
    href: "/restaurant/setup",
    group: "Business",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "catalogue",
    name: "Products",
    href: "/products",
    group: "Business",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "stock",
    name: "Stock",
    href: "/stock",
    group: "Business",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "sell",
    name: "Sales & receipts",
    href: "/sales",
    group: "Business",
    roles: ["OWNER", "MANAGER", "CASHIER"],
  },
  {
    id: "sell",
    name: "Returns",
    href: "/returns",
    group: "Business",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "customers",
    name: "Customers",
    href: "/customers",
    group: "Business",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "suppliers",
    name: "Suppliers",
    href: "/suppliers",
    group: "Business",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "suppliers",
    name: "Purchase orders",
    href: "/purchase-orders",
    group: "Business",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "expenses",
    name: "Expenses",
    href: "/expenses",
    group: "Business",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "reports",
    name: "Reports",
    href: "/reports",
    group: "Business",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "team",
    name: "Team",
    href: "/staff",
    group: "Business",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "restaurant",
    name: "Report subscriptions",
    href: "/restaurant/reports",
    group: "Manage",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "manage",
    name: "Workspace settings",
    href: "/workspace",
    group: "Manage",
    roles: ["OWNER"],
  },
  {
    id: "manage",
    name: "Billing",
    href: "/billing",
    group: "Manage",
    roles: ["OWNER", "MANAGER"],
  },
  {
    id: "manage",
    name: "Settings",
    href: "/settings",
    group: "Manage",
    roles: ["OWNER", "MANAGER", "CASHIER"],
  },
  {
    id: "manage",
    name: "Audit log",
    href: "/audit-log",
    group: "Manage",
    roles: ["OWNER"],
  },
  {
    id: "assistant",
    name: "Business assistant",
    href: "/assistant",
    group: "Manage",
    roles: ["OWNER", "MANAGER"],
  },
];
export function recommendedModules(businessType: string): Module[] {
  const base: Module[] = ["sell", "catalogue", "customers", "reports"];
  if (
    ["restaurant", "cafe", "takeaway", "food", "bakery", "fast_food"].includes(
      businessType,
    )
  )
    return [...base, "restaurant", "stock", "suppliers", "expenses", "team"];
  if (["salon", "beauty", "spa", "barber"].includes(businessType))
    return [...base, "expenses", "team"];
  return [...base, "stock", "suppliers", "expenses", "team"];
}
export function resolveWorkspace(
  modules: string[],
  role: string,
  kitchen: boolean,
) {
  return navigation.filter(
    (n) =>
      n.roles.includes(role) &&
      (["home", "manage", "assistant"].includes(n.id) ||
        modules.includes(n.id)) &&
      (!kitchen || n.href === "/" || n.href === "/restaurant/orders"),
  );
}
