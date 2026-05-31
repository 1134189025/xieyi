import { z } from 'zod';

export const orderStatusSchema = z.enum([
  'CREATING_PAYMENT',
  'PENDING_PAYMENT',
  'PAYMENT_COMPLETED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
]);

export const loginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(200),
});

export const createOrderSchema = z.object({
  redemptionCode: z.string().min(1).max(20).trim(),
  session: z.string().min(10).max(10000).trim(),
});

export const batchCodesSchema = z.object({
  count: z.number().int().min(1).max(500),
  batchLabel: z.string().max(100).optional(),
});

export const createWorkerSchema = z.object({
  username: z.string().min(2).max(50),
  password: z.string().min(6).max(200),
  displayName: z.string().max(100).optional(),
});

export const updateWorkerSchema = z.object({
  enabled: z.boolean().optional(),
  password: z.string().min(6).max(200).optional(),
  displayName: z.string().max(100).optional(),
});

export const updateOrderSchema = z.object({
  status: z.enum(['CANCELLED']),
});

export const updateProxySettingSchema = z.object({
  proxy: z.string().max(1000).trim().nullable(),
});

export const listOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: orderStatusSchema.optional(),
});
