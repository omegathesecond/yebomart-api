import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "crypto";

export class RestaurantError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(
  value: unknown,
  message: string,
  status = 400,
): asserts value {
  if (!value) throw new RestaurantError(status, message);
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const money = (value: number) => Math.round(value * 100);
export interface Hours {
  day: number;
  open: string;
  close: string;
}
export interface TicketLine {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  notes: string;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
export function parts(date: Date, timezone: string) {
  const f =
    formatters.get(timezone) ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
  formatters.set(timezone, f);
  const p = Object.fromEntries(
    f.formatToParts(date).map((v) => [v.type, v.value]),
  );
  return {
    date: p.year + "-" + p.month + "-" + p.day,
    minute: Number(p.hour) * 60 + Number(p.minute),
    day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
    label: p.hour + ":" + p.minute,
  };
}
export function isOpen(date: Date, timezone: string, hours: Hours[]) {
  const p = parts(date, timezone);
  return hours.some(
    (h) =>
      h.day === p.day &&
      p.minute >= toMinute(h.open) &&
      p.minute < toMinute(h.close),
  );
}
export function toMinute(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
export function validateHours(hours: Hours[]) {
  assert(
    hours.length > 0 && hours.length <= 21,
    "Add at least one opening period.",
  );
  for (const h of hours) {
    assert(
      Number.isInteger(h.day) &&
        h.day >= 0 &&
        h.day <= 6 &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(h.open) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(h.close),
      "Check the opening days and times.",
    );
    assert(
      toMinute(h.open) < toMinute(h.close),
      "Each opening period must end after it starts. Split overnight hours into two days.",
    );
  }
  hours.forEach((a, i) =>
    hours
      .slice(i + 1)
      .forEach((b) =>
        assert(
          a.day !== b.day ||
            toMinute(a.close) <= toMinute(b.open) ||
            toMinute(b.close) <= toMinute(a.open),
          "Opening periods overlap.",
        ),
      ),
  );
}
export function validateSlot(
  date: Date,
  cfg: { leadMinutes: number; slotMinutes: number; hours: unknown },
  timezone: string,
  now = new Date(),
) {
  assert(Number.isFinite(date.getTime()), "Choose a collection time.");
  assert(
    date.getTime() >= now.getTime() + cfg.leadMinutes * 60000,
    "That time is too soon. Choose a later slot.",
  );
  assert(
    date.getTime() <= now.getTime() + 14 * 86400000,
    "Pre-orders can be placed up to 14 days ahead.",
  );
  assert(
    isOpen(date, timezone, cfg.hours as Hours[]),
    "The restaurant is closed at that time.",
  );
  assert(
    parts(date, timezone).minute % cfg.slotMinutes === 0 &&
      date.getUTCSeconds() === 0 &&
      date.getUTCMilliseconds() === 0,
    "Choose an available collection slot.",
  );
}
export function transition(from: string, to: string) {
  const allowed: Record<string, string[]> = {
    NEW: ["ACCEPTED", "CANCELLED"],
    ACCEPTED: ["PREPARING", "CANCELLED"],
    PREPARING: ["READY"],
    READY: ["COMPLETED"],
  };
  assert(
    allowed[from]?.includes(to),
    "This order cannot move from " +
      from.toLowerCase() +
      " to " +
      to.toLowerCase() +
      ".",
    409,
  );
}
function credentialKey() {
  const hex = process.env.RESTAURANT_CREDENTIAL_KEY;
  assert(
    hex && /^[0-9a-f]{64}$/i.test(hex),
    "Secure payment connection storage is not configured.",
    503,
  );
  return Buffer.from(hex, "hex");
}
export function seal(value: string, shopId: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", credentialKey(), iv);
  cipher.setAAD(Buffer.from(shopId));
  return [
    iv.toString("hex"),
    Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString(
      "hex",
    ),
    cipher.getAuthTag().toString("hex"),
  ].join(".");
}
export function unseal(value: string, shopId: string) {
  const [iv, content, tag] = value.split(".");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    credentialKey(),
    Buffer.from(iv, "hex"),
  );
  decipher.setAAD(Buffer.from(shopId));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(content, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
