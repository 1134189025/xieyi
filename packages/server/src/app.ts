import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.ts';
import { prisma } from './db.ts';
import { errorHandler } from './middleware/error-handler.ts';
import authRoutes from './routes/auth.routes.ts';
import orderRoutes from './routes/order.routes.ts';
import workerRoutes from './routes/worker.routes.ts';
import adminRoutes from './routes/admin.routes.ts';
import { getPixGenerationQueueMetrics } from './queues/pix-generation.queue.ts';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  const orderLimiter = rateLimit({
    windowMs: 60_000,
    max: config.createOrderRateLimitPerMin,
    message: { error: 'Too many requests, please try again later' },
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/ready', async (_req, res) => {
    const checks = {
      database: 'unknown',
      queue: 'unknown',
    };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    try {
      await getPixGenerationQueueMetrics();
      checks.queue = 'ok';
    } catch {
      checks.queue = 'error';
    }

    const ready = Object.values(checks).every((status) => status === 'ok');
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'error',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/orders', orderLimiter, orderRoutes);
  app.use('/api/worker', workerRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(errorHandler);

  return app;
}
