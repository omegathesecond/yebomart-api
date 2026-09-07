import { Request, Response } from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { ApiResponse } from '@utils/ApiResponse';

// Cloudflare R2 configuration
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'yebomart-images';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || `https://pub-${R2_ACCOUNT_ID}.r2.dev`;

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || '',
    secretAccessKey: R2_SECRET_ACCESS_KEY || '',
  },
});

export async function uploadImage(req: Request, res: Response) {
  try {
    if (!req.file) {
      return ApiResponse.badRequest(res, 'No file uploaded');
    }

    // R2 must be configured — never fall back to a base64 data-URL.
    // A silent fallback would dress a misconfiguration as success and get
    // persisted as the product's imageUrl, bloating rows with multi-MB
    // payloads and hiding a broken prod/dev deploy (see CLAUDE.md "no silent
    // fallbacks"). Fail loud with a 5xx instead.
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
      console.error(
        'Image upload failed: R2 storage is not configured (missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)'
      );
      return ApiResponse.serverError(res, 'Image storage (R2) is not configured');
    }

    const file = req.file;
    const fileExtension = file.originalname.split('.').pop() || 'jpg';
    const fileName = `products/${uuidv4()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
    });

    await s3Client.send(command);

    const publicUrl = `${R2_PUBLIC_URL}/${fileName}`;

    return ApiResponse.success(res, { url: publicUrl, key: fileName });
  } catch (error) {
    // Propagate the failure loudly — an s3Client.send() that throws must
    // surface as a 5xx, never be swallowed into a fake-success response.
    console.error('Image upload failed:', error);
    return ApiResponse.serverError(res, 'Failed to upload image', error);
  }
}
