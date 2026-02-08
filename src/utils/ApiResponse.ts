import { Response } from 'express';

export interface IApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: any;
  metadata?: {
    total?: number;
    page?: number;
    limit?: number;
    hasNext?: boolean;
    hasPrev?: boolean;
  };
}

export class ApiResponse {
  static success<T>(
    res: Response,
    data?: T,
    message?: string,
    statusCode: number = 200,
    metadata?: IApiResponse['metadata']
  ): Response {
    const response: IApiResponse<T> = {
      success: true,
      data,
      message,
      metadata,
    };
    return res.status(statusCode).json(response);
  }

  static error(
    res: Response,
    message: string,
    statusCode: number = 500,
    error?: any
  ): Response {
    const response: IApiResponse = {
      success: false,
      message,
      error: process.env.NODE_ENV === 'development' ? error : undefined,
    };
    return res.status(statusCode).json(response);
  }

  static created<T>(res: Response, data?: T, message?: string): Response {
    return ApiResponse.success(res, data, message, 201);
  }

  static noContent(res: Response): Response {
    return res.status(204).send();
  }

  static badRequest(res: Response, message: string, error?: any): Response {
    return ApiResponse.error(res, message, 400, error);
  }

  static unauthorized(res: Response, message: string = 'Unauthorized'): Response {
    return ApiResponse.error(res, message, 401);
  }

  static forbidden(res: Response, message: string = 'Forbidden'): Response {
    return ApiResponse.error(res, message, 403);
  }

  static notFound(res: Response, message: string = 'Resource not found'): Response {
    return ApiResponse.error(res, message, 404);
  }

  static conflict(res: Response, message: string): Response {
    return ApiResponse.error(res, message, 409);
  }

  static tooManyRequests(res: Response, message: string = 'Too many requests'): Response {
    return ApiResponse.error(res, message, 429);
  }

  static serverError(res: Response, message: string = 'Internal server error', error?: any): Response {
    return ApiResponse.error(res, message, 500, error);
  }
}
