import { Response } from 'express';
import Joi from 'joi';
import { LicenseService } from '@services/license.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

export const validateLicenseSchema = Joi.object({
  licenseKey: Joi.string().required(),
});

export class LicenseController {
  /**
   * Get license status
   */
  static async getStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const status = await LicenseService.getStatus(req.user.shopId);
      ApiResponse.success(res, status);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Validate and apply a license key
   */
  static async validate(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      // Only owners can apply license keys
      if (req.user.role !== 'OWNER') {
        ApiResponse.forbidden(res, 'Only owners can apply license keys');
        return;
      }

      const { licenseKey } = req.body;
      const result = await LicenseService.validateAndApply(req.user.shopId, licenseKey);
      ApiResponse.success(res, result, 'License applied successfully');
    } catch (error: any) {
      if (error.message.includes('Invalid')) {
        ApiResponse.badRequest(res, error.message);
      } else if (error.message.includes('expired')) {
        ApiResponse.badRequest(res, error.message);
      } else if (error.message.includes('not valid')) {
        ApiResponse.badRequest(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Start a trial (only for new shops)
   */
  static async startTrial(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      // Check if already has a license
      const status = await LicenseService.getStatus(req.user.shopId);
      if (status.tier !== 'LITE') {
        ApiResponse.badRequest(res, 'Shop already has an active license');
        return;
      }

      const result = await LicenseService.createTrialLicense(req.user.shopId);
      ApiResponse.success(res, result, 'Trial started! You have 30 days of PRO features.');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
