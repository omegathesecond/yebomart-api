import { YeboPayClient } from "@services/yebopay.client";
import { assert, unseal } from "./domain";
export const merchantCredential = (profile: {
  shopId: string;
  paymentCredential: string | null;
}) => {
  assert(
    profile.paymentCredential,
    "Connect the restaurant’s YeboPay checkout key before enabling online payment.",
    409,
  );
  return unseal(profile.paymentCredential, profile.shopId);
};
export async function checkMerchantKey(key: string) {
  // A scoped lookup verifies key + checkout-read access without creating a payment.
  const base = process.env.YEBOPAY_BASE_URL ?? "https://api.yebopay.app";
  const response = await fetch(
    base + "/v1/checkouts/00000000-0000-0000-0000-000000000000",
    { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(10000) },
  );
  assert(
    response.status === 404,
    "YeboPay could not validate this key. It needs checkout write and checkout read access for your restaurant.",
    422,
  );
}
export { YeboPayClient };
