import { randomUUID } from "crypto";
import { Storage } from "@google-cloud/storage";
export interface PhotoFile {
  buffer: Buffer;
  mimetype: string;
}
const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
export function photoStorageOrigin() {
  const bucket = process.env.PUBLIC_PHOTO_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket))
    throw new Error("Public photo storage is not configured.");
  return "https://storage.googleapis.com/" + bucket;
}
export async function storeProductImage(file: PhotoFile, shopId: string) {
  const origin = photoStorageOrigin(),
    extension = extensions[file.mimetype],
    bytes = file.buffer;
  if (!extension || !bytes.length || bytes.length > 6 * 1024 * 1024)
    throw new Error("Choose one JPG, PNG or WebP photo smaller than 6 MB.");
  const valid =
    file.mimetype === "image/jpeg"
      ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : file.mimetype === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.subarray(0, 4).toString() === "RIFF" &&
          bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw new Error("This file is not a supported photo.");
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(shopId))
    throw new Error("A verified business is required for photo uploads.");
  const key = "products/" + shopId + "/" + randomUUID() + "." + extension;
  // Application Default Credentials: only this runtime's dedicated photo bucket.
  await new Storage({ retryOptions: { totalTimeout: 20, maxRetries: 1 } })
    .bucket(process.env.PUBLIC_PHOTO_BUCKET!)
    .file(key)
    .save(bytes, {
      resumable: false,
      validation: "crc32c",
      metadata: {
        contentType: file.mimetype,
        cacheControl: "public, max-age=31536000, immutable",
      },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  return { key, url: origin + "/" + key };
}
