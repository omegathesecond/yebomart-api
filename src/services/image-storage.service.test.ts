import { afterEach, beforeEach, expect, it, vi } from "vitest";
const save = vi.hoisted(() => vi.fn());
vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket(name: string) {
      return {
        file: (key: string) => ({
          save: (...args: any[]) => save(name, key, ...args),
        }),
      };
    }
  },
}));
import { storeProductImage } from "./image-storage.service";
const png = {
  mimetype: "image/png",
  buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
};
beforeEach(() => {
  vi.stubEnv("PUBLIC_PHOTO_BUCKET", "yebomart-test-photos");
  save.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
it("writes only verified business image bytes and returns the exact public object URL", async () => {
  const receipt = await storeProductImage(png, "shop_1");
  expect(receipt.key).toMatch(/^products\/shop_1\/[a-f0-9-]+\.png$/);
  expect(receipt.url).toBe(
    "https://storage.googleapis.com/yebomart-test-photos/" + receipt.key,
  );
  expect(save.mock.calls[0][3]).toMatchObject({
    resumable: false,
    validation: "crc32c",
    preconditionOpts: { ifGenerationMatch: 0 },
  });
});
it("rejects disguised files, oversized images and invalid business keys before any write", async () => {
  await expect(
    storeProductImage({ ...png, buffer: Buffer.from("not PNG") }, "shop_1"),
  ).rejects.toThrow("not a supported photo");
  await expect(
    storeProductImage(
      { ...png, buffer: Buffer.alloc(6 * 1024 * 1024 + 1) },
      "shop_1",
    ),
  ).rejects.toThrow("smaller than");
  await expect(storeProductImage(png, "../private")).rejects.toThrow(
    "verified business",
  );
  expect(save).not.toHaveBeenCalled();
});
it("propagates storage failures instead of returning a successful URL", async () => {
  save.mockRejectedValue(new Error("Storage unavailable"));
  await expect(storeProductImage(png, "shop_1")).rejects.toThrow(
    "Storage unavailable",
  );
});
