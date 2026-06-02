import 'dotenv/config';
import { prisma } from './db.ts';
import { createPixGenerationWorker } from './queues/pix-generation.queue.ts';
import { processPixGenerationJob } from './services/pix-generation.service.ts';

async function startWorker() {
  await prisma.$connect();
  console.log('Pix generation worker connected to database');

  const worker = createPixGenerationWorker(async (job) => {
    const attempts = Number(job.opts.attempts ?? 1);
    const finalAttempt = job.attemptsMade + 1 >= attempts;
    await processPixGenerationJob({ orderId: job.data.orderId, finalAttempt });
  });

  worker.on('completed', (job) => {
    console.log(`Pix generation job lifecycle completed order=${job.data.orderId}`);
  });
  worker.on('failed', (job, error) => {
    const orderId = job?.data.orderId ?? 'unknown';
    const code = (error as { code?: unknown }).code;
    console.warn(`Pix generation job failed order=${orderId} error=${error.name}${typeof code === 'string' ? ` code=${code}` : ''}`);
  });
}

startWorker().catch((error) => {
  console.error('Failed to start Pix generation worker:', error);
  process.exit(1);
});
