import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { ApiResponse } from '@utils/ApiResponse';

export const validateRequest = (schema: Joi.Schema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: detail.message,
      }));
      ApiResponse.badRequest(res, 'Validation failed', errors);
      return;
    }

    req.body = value;
    next();
  };
};

export const validateQuery = (schema: Joi.Schema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.query, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: detail.message,
      }));
      ApiResponse.badRequest(res, 'Validation failed', errors);
      return;
    }

    req.query = value;
    next();
  };
};

export const validateParams = (schema: Joi.Schema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.params, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: detail.message,
      }));
      ApiResponse.badRequest(res, 'Validation failed', errors);
      return;
    }

    req.params = value;
    next();
  };
};
