import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import routes from '@routes/index';
import { errorHandler, notFoundHandler } from '@middleware/error.middleware';
import { standardLimiter } from '@middleware/rateLimit.middleware';
import { ApiResponse } from '@utils/ApiResponse';
import { getHealthReport, getReadinessStatus, getLivenessStatus } from '@services/health.service';

const app: Application = express();

// Cloud Run terminates public connections and appends the connecting client's
// address to X-Forwarded-For. Trust only that final ingress hop, never arbitrary
// caller-supplied prefixes (trust proxy=true would allow rate-limit bypass).
// Outside Cloud Run, connections are direct and forwarded headers stay untrusted.
app.set('trust proxy', process.env.K_SERVICE ? 1 : false);

// CORS configuration
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://yebomart.com',
  'https://www.yebomart.com',
  'https://app.yebomart.com',
  'https://admin.yebomart.com',
  'https://yebomart.pages.dev',
  // The landing's own Pages hostname. It reads GET /api/billing/plans, so
  // without this the pricing section breaks on the fallback URL.
  'https://yebomart-landing.pages.dev',
  'https://yebomart-app.pages.dev',
  'https://yebomart-admin.pages.dev',
];

// Security middleware
app.use(helmet());
app.use(compression());

const corsMiddleware = cors({
  // The gate below validates the origin before reflecting it.
  origin: true,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Total-Count'],
});
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    // An untrusted caller is a policy rejection, not a server failure. Keep
    // the rejection visible without logging caller-controlled header content.
    console.warn('CORS origin rejected');
    ApiResponse.forbidden(res, 'Not allowed by CORS');
    return;
  }
  corsMiddleware(req, res, next);
});

// Logging
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Body parsing — JSON for everything. No raw-body carve-outs (yebopay owns
// payment-processor webhooks).
// Keep the exact bytes of the request body around for signature verification.
// YeboPay signs the RAW JSON it sent; re-serializing a parsed object changes
// key order and whitespace and would fail every HMAC check.
app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
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
