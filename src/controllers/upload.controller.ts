import { Response } from "express";
import { AuthRequest } from "@middleware/auth.middleware";
import { ApiResponse } from "@utils/ApiResponse";
import { storeProductImage } from "@services/image-storage.service";
export async function uploadImage(req: AuthRequest, res: Response) {
  if (!req.file) return ApiResponse.badRequest(res, "No file uploaded");
  try {
    return ApiResponse.success(
      res,
      await storeProductImage(req.file, req.user?.shopId ?? ""),
    );
  } catch (error) {
    console.error(
      "Image upload failed:",
      error instanceof Error ? error.message : "Storage error",
    );
    return ApiResponse.serverError(
      res,
      error instanceof Error ? error.message : "Failed to upload image",
    );
  }
}
