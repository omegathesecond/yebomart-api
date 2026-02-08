import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import routes from '@routes/index';
import { errorHandler, notFoundHandler } from '@middleware/error.middleware';
import { standardLimiter } from '@middleware/rateLimit.middleware';
import { getHealthReport, getReadinessStatus, getLivenessStatus } from '@services/health.service';

const app: Application = express();

// CORS configuration
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://yebomart.com',
  'https://www.yebomart.com',
  'https://app.yebomart.com',
  'https://admin.yebomart.com',
  'https://yebomart.pages.dev',
  'https://yebomart-app.pages.dev',
  'https://yebomart-admin.pages.dev',
];

// Security middleware
app.use(helmet());
app.use(compression());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Total-Count'],
  })
);

// Logging
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting (applied to all API routes)
app.use('/api', standardLimiter);

// Health check endpoints
app.get('/health', async (req: Request, res: Response) => {
  const report = await getHealthReport();
  const statusCode = report.status === 'healthy' ? 200 : report.status === 'degraded' ? 200 : 503;
  res.status(statusCode).json(report);
});

app.get('/health/ready', async (req: Request, res: Response) => {
  const { ready, reason } = await getReadinessStatus();
  res.status(ready ? 200 : 503).json({ ready, reason });
});

app.get('/health/live', async (req: Request, res: Response) => {
  const { alive } = getLivenessStatus();
  res.status(alive ? 200 : 503).json({ alive });
});

// API routes
app.use('/api', routes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
