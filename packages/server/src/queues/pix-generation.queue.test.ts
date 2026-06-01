import { beforeEach, describe, expect, it, vi } from 'vitest';

const queueMocks = vi.hoisted(() => {
  const addJob = vi.fn();
  const QueueMock = vi.fn(function MockQueue() {
    return {
      add: addJob,
      getJobCounts: vi.fn(),
      getJobs: vi.fn(),
    };
  });
  const WorkerMock = vi.fn(function MockWorker() {
    return {};
  });
  return { addJob, QueueMock, WorkerMock };
});

vi.mock('bullmq', () => ({
  Queue: queueMocks.QueueMock,
  Worker: queueMocks.WorkerMock,
}));

vi.mock('../config.ts', () => ({
  config: {
    redisUrl: 'redis://127.0.0.1:6379',
    pixWorkerConcurrency: 5,
  },
}));

const { enqueuePixGenerationJob } = await import('./pix-generation.queue.ts');

describe('pix-generation.queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueMocks.addJob.mockResolvedValue({ id: 'pix-generation-order-1' });
  });

  it('uses a BullMQ-safe custom jobId while keeping one job per order', async () => {
    await enqueuePixGenerationJob({ orderId: 'order-1' });

    expect(queueMocks.addJob).toHaveBeenCalledWith(
      'generate',
      { orderId: 'order-1' },
      expect.objectContaining({
        jobId: 'pix-generation-order-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
      }),
    );
    const jobOptions = queueMocks.addJob.mock.calls[0]?.[2] as { jobId?: string };
    expect(jobOptions.jobId).not.toContain(':');
  });
});
