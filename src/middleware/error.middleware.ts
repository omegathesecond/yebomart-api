import { Request, Response, NextFunction } from 'express';
import { ApiResponse } from '@utils/ApiResponse';

export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public isOperational: boolean = true
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  error: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  console.error('Error:', error);

  if (error instanceof AppError) {
    ApiResponse.error(res, error.message, error.statusCode, error);
    return;
  }

  ApiResponse.serverError(res, error.message, error);
};

export const notFoundHandler = (req: Request, res: Response): void => {
  ApiResponse.notFound(res, `Route ${req.originalUrl} not found`);
};
