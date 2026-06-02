import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  $connect: vi.fn(),
}));

const workerEvents = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
}));

const createPixGenerationWorker = vi.hoisted(() => vi.fn(() => ({
  on: vi.fn((eventName: string, handler: (...args: unknown[]) => void) => {
    workerEvents.handlers.set(eventName, handler);
  }),
})));

vi.mock('./db.ts', () => ({ prisma }));
vi.mock('./queues/pix-generation.queue.ts', () => ({ createPixGenerationWorker }));
vi.mock('./services/pix-generation.service.ts', () => ({ processPixGenerationJob: vi.fn() }));

async function loadWorkerModule() {
  vi.resetModules();
  workerEvents.handlers.clear();
  await import('./worker.ts');
  await Promise.resolve();
}

describe('pix generation worker logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$connect.mockResolvedValue(undefined);
  });

  it('logs BullMQ completed events as job lifecycle completion instead of Pix success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await loadWorkerModule();
    logSpy.mockClear();

    const completedHandler = workerEvents.handlers.get('completed');
    expect(completedHandler).toBeDefined();

    completedHandler?.({ data: { orderId: 'order-1' } });

    expect(logSpy).toHaveBeenCalledWith('Pix generation job lifecycle completed order=order-1');
  });
});
