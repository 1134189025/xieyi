import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor } from 'bullmq';
import { config } from '../config.ts';

const PIX_GENERATION_QUEUE_NAME = 'pix-generation';
const DEFAULT_SECONDS_PER_GENERATION = 300;

export interface PixGenerationJobData {
  orderId: string;
}

export interface PixGenerationQueueSnapshot {
  waitingCount: number;
  delayedCount: number;
  activeCount: number;
  failedCount: number;
  orderIdsInQueue: string[];
  oldestWaitingTimestamp: number | null;
}

export interface PixGenerationQueueMetrics {
  waitingCount: number;
  delayedCount: number;
  activeCount: number;
  failedCount: number;
  oldestWaitingSeconds: number | null;
}

let queue: Queue | null = null;
let connection: ConnectionOptions | null = null;

export async function enqueuePixGenerationJob(data: PixGenerationJobData) {
  return getPixGenerationQueue().add('generate', data, pixGenerationJobOptions(data.orderId));
}

export async function getPixGenerationQueueSnapshot(): Promise<PixGenerationQueueSnapshot> {
  const queueInstance = getPixGenerationQueue();
  const [counts, waitingJobs, delayedJobs] = await Promise.all([
    queueInstance.getJobCounts('waiting', 'delayed', 'active', 'failed'),
    queueInstance.getJobs(['waiting'], 0, 5000, true),
    queueInstance.getJobs(['delayed'], 0, 5000, true),
  ]);
  const queuedJobs = [...waitingJobs, ...delayedJobs];
  const timestamps = queuedJobs.map((job) => job.timestamp).filter((timestamp) => Number.isFinite(timestamp));

  return {
    waitingCount: counts.waiting ?? 0,
    delayedCount: counts.delayed ?? 0,
    activeCount: counts.active ?? 0,
    failedCount: counts.failed ?? 0,
    orderIdsInQueue: queuedJobs
      .map((job) => job.data.orderId)
      .filter((orderId): orderId is string => typeof orderId === 'string'),
    oldestWaitingTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : null,
  };
}

export async function getPixGenerationQueueMetrics(): Promise<PixGenerationQueueMetrics> {
  const snapshot = await getPixGenerationQueueSnapshot();
  return {
    waitingCount: snapshot.waitingCount,
    delayedCount: snapshot.delayedCount,
    activeCount: snapshot.activeCount,
    failedCount: snapshot.failedCount,
    oldestWaitingSeconds: snapshot.oldestWaitingTimestamp
      ? Math.max(0, Math.floor((Date.now() - snapshot.oldestWaitingTimestamp) / 1000))
      : null,
  };
}

export function createPixGenerationWorker(processor: Processor<PixGenerationJobData>) {
  return new Worker<PixGenerationJobData>(PIX_GENERATION_QUEUE_NAME, processor, {
    connection: getRedisConnection(),
    concurrency: config.pixWorkerConcurrency,
  });
}

export function secondsPerGenerationEstimate(): number {
  return DEFAULT_SECONDS_PER_GENERATION;
}

function getPixGenerationQueue(): Queue {
  if (!queue) {
    queue = new Queue(PIX_GENERATION_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: pixGenerationJobOptions(),
    });
  }
  return queue;
}

function getRedisConnection(): ConnectionOptions {
  if (!connection) {
    const redisUrl = new URL(config.redisUrl);
    connection = {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
      username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
      password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
      db: redisUrl.pathname.length > 1 ? Number(redisUrl.pathname.slice(1)) : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
  return connection;
}

function pixGenerationJobOptions(orderId?: string): JobsOptions {
  return {
    jobId: orderId ? `pix-generation-${orderId}` : undefined,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
  };
}
