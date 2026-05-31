import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.ts';
import { prisma } from './db.ts';
import { errorHandler } from './middleware/error-handler.ts';
import { setupWebSocket } from './ws/index.ts';
import { seedAdmin } from './services/auth.service.ts';
import { expirePendingOrders } from './services/order.service.ts';
import authRoutes from './routes/auth.routes.ts';
import orderRoutes from './routes/order.routes.ts';
import workerRoutes from './routes/worker.routes.ts';
import adminRoutes from './routes/admin.routes.ts';

const app = express();
const httpServer = createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const orderLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  message: { error: 'Too many requests, please try again later' },
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/orders', orderLimiter, orderRoutes);
app.use('/api/worker', workerRoutes);
app.use('/api/admin', adminRoutes);

app.use(errorHandler);

setupWebSocket(httpServer);

async function start() {
  await prisma.$connect();
  console.log('Database connected');

  await seedAdmin();

  setInterval(() => {
    expirePendingOrders().catch(console.error);
  }, 60_000);

  httpServer.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
