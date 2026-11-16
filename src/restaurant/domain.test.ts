import { describe, it, expect } from "vitest";
import {
  validateSlot,
  validateHours,
  transition,
  seal,
  unseal,
} from "./domain";
import { resolveWorkspace } from "./capabilities";
describe("restaurant rules", () => {
  it("uses venue opening hours, slot boundaries and lead time", () => {
    const cfg = {
      leadMinutes: 20,
      slotMinutes: 15,
      hours: [{ day: 1, open: "09:00", close: "18:00" }],
    };
    const now = new Date("2026-11-16T07:00:00Z");
    expect(() =>
      validateSlot(
        new Date("2026-11-16T07:30:00Z"),
        cfg,
        "Africa/Mbabane",
        now,
      ),
    ).not.toThrow();
    for (const at of [
      "2026-11-16T07:15:00Z",
      "2026-11-16T07:31:00Z",
      "2026-11-16T16:00:00Z",
      "2026-11-17T08:00:00Z",
    ])
      expect(() =>
        validateSlot(new Date(at), cfg, "Africa/Mbabane", now),
      ).toThrow();
  });
  it("rejects overlapping or backwards hours", () => {
    expect(() =>
      validateHours([{ day: 1, open: "09:00", close: "08:00" }]),
    ).toThrow();
    expect(() =>
      validateHours([
        { day: 1, open: "09:00", close: "12:00" },
        { day: 1, open: "11:00", close: "14:00" },
      ]),
    ).toThrow();
  });
  it("does not skip acceptance, preparation or collection", () => {
    expect(() => transition("NEW", "COMPLETED")).toThrow();
    expect(() => transition("COMPLETED", "CANCELLED")).toThrow();
    expect(() => transition("PREPARING", "READY")).not.toThrow();
  });
  it("binds encrypted credentials to one shop and fails when storage is not configured", () => {
    process.env.RESTAURANT_CREDENTIAL_KEY = "b".repeat(64);
    const encrypted = seal("merchant-private", "one");
    expect(encrypted).not.toContain("merchant-private");
    expect(unseal(encrypted, "one")).toBe("merchant-private");
    expect(() => unseal(encrypted, "two")).toThrow();
    delete process.env.RESTAURANT_CREDENTIAL_KEY;
    expect(() => seal("x", "one")).toThrow();
  });
  it("shows only enabled role-appropriate navigation", () => {
    const cashier = resolveWorkspace(
      ["sell", "restaurant", "reports"],
      "CASHIER",
      false,
    );
    expect(cashier.some((n) => n.href === "/restaurant/orders")).toBe(true);
    expect(
      cashier.some(
        (n) => n.href === "/reports" || n.href === "/restaurant/setup",
      ),
    ).toBe(false);
    expect(
      resolveWorkspace(["restaurant"], "CASHIER", true).map((n) => n.href),
    ).toEqual(["/", "/restaurant/orders"]);
    expect(
      resolveWorkspace(["sell"], "OWNER", false).some(
        (n) => n.href === "/restaurant/setup",
      ),
    ).toBe(false);
  });
});
