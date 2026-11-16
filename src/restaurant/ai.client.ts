import { assert } from "./domain";
export async function restaurantAI(path: string, payload: unknown) {
  const key = process.env.YEBOAI_API_KEY,
    base = process.env.YEBOAI_BASE_URL;
  assert(
    key && base,
    "The YeboAI connection is not configured. Nothing was imported.",
    503,
  );
  const res = await fetch(base + "/api/v1/restaurant/" + path, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(55000),
  });
  assert(
    res.ok,
    "YeboAI could not complete this request. Try again; your live menu is unchanged.",
    502,
  );
  return res.json() as Promise<any>;
}
