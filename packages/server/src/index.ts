import { createServer } from 'node:http';
import { config } from './config.ts';
import { prisma } from './db.ts';
import { createApp } from './app.ts';
import { setupWebSocket } from './ws/index.ts';
import { seedAdmin } from './services/auth.service.ts';
import { startPaymentMaintenanceLoop } from './services/payment-maintenance.service.ts';

const app = createApp();
const httpServer = createServer(app);

setupWebSocket(httpServer);

async function start() {
  await prisma.$connect();
  console.log('Database connected');

  await seedAdmin();

  if (config.enablePaymentMaintenance) {
    startPaymentMaintenanceLoop();
  }

  httpServer.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
