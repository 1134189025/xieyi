import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.ts';
import {
  archiveCode,
  archiveUsedCodes,
  batchCreateCodes,
  deleteCode,
  listCodeBatches,
  listCodes,
} from '../services/redemption-code.service.ts';
import { createWorker, listWorkers, updateWorker, deleteWorker } from '../services/worker.service.ts';
import { getAdminOrders, cancelOrder } from '../services/order.service.ts';
import { getDashboardStats } from '../services/dashboard.service.ts';
import {
  getAutoPaymentDetectionSetting,
  getMaintenanceModeSetting,
  getProxySetting,
  updateAutoPaymentDetectionSetting,
  updateMaintenanceModeSetting,
  updateProxySetting,
} from '../services/settings.service.ts';
import {
  batchCodesSchema,
  archiveUsedCodesSchema,
  createWorkerSchema,
  listRedemptionCodesQuerySchema,
  updateWorkerSchema,
  updateOrderSchema,
  updateAutoPaymentDetectionSettingSchema,
  updateMaintenanceModeSettingSchema,
  updateProxySettingSchema,
  listOrdersQuerySchema,
} from '../utils/validators.ts';
import { AppError } from '../middleware/error-handler.ts';

const router = Router();

router.use(authenticate, authorize('ADMIN'));

// Redemption codes
router.post('/redemption-codes', async (req, res, next) => {
  try {
    const parsed = batchCodesSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid input');

    const codes = await batchCreateCodes(parsed.data.count, req.user!.sub, parsed.data.batchLabel);
    res.status(201).json({ codes, batchLabel: parsed.data.batchLabel ?? null });
  } catch (error) {
    next(error);
  }
});

router.get('/redemption-codes', async (req, res, next) => {
  try {
    const parsed = listRedemptionCodesQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, 'Invalid input');
    const result = await listCodes(parsed.data);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/redemption-code-batches', async (_req, res, next) => {
  try {
    const batches = await listCodeBatches();
    res.json({ batches });
  } catch (error) {
    next(error);
  }
});

router.post('/redemption-codes/archive-used', async (req, res, next) => {
  try {
    const parsed = archiveUsedCodesSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid input');

    res.json(await archiveUsedCodes(parsed.data));
  } catch (error) {
    next(error);
  }
});

router.post('/redemption-codes/:id/archive', async (req, res, next) => {
  try {
    res.json(await archiveCode(req.params.id));
  } catch (error) {
    next(error);
  }
});

router.delete('/redemption-codes/:id', async (req, res, next) => {
  try {
    await deleteCode(req.params.id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Workers
router.post('/workers', async (req, res, next) => {
  try {
    const parsed = createWorkerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid input');

    const worker = await createWorker(parsed.data.username, parsed.data.password, parsed.data.displayName);
    res.status(201).json(worker);
  } catch (error) {
    next(error);
  }
});

router.get('/workers', async (_req, res, next) => {
  try {
    const workers = await listWorkers();
    res.json({ workers });
  } catch (error) {
    next(error);
  }
});

router.patch('/workers/:id', async (req, res, next) => {
  try {
    const parsed = updateWorkerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid input');

    const worker = await updateWorker(req.params.id, parsed.data);
    res.json(worker);
  } catch (error) {
    next(error);
  }
});

router.delete('/workers/:id', async (req, res, next) => {
  try {
    await deleteWorker(req.params.id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Orders
router.get('/orders', async (req, res, next) => {
  try {
    const parsed = listOrdersQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, 'Invalid input');
    const result = await getAdminOrders(parsed.data);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.patch('/orders/:id', async (req, res, next) => {
  try {
    const parsed = updateOrderSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid input');

    const result = await cancelOrder(req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Dashboard
router.get('/dashboard', async (_req, res, next) => {
  try {
    const stats = await getDashboardStats();
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

// Settings
router.get('/settings/proxy', async (_req, res, next) => {
  try {
    res.json(await getProxySetting());
  } catch (error) {
    next(error);
  }
});

router.put('/settings/proxy', async (req, res, next) => {
  try {
    const parsed = updateProxySettingSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid input');

    res.json(await updateProxySetting(parsed.data));
  } catch (error) {
    next(error);
  }
});

router.get('/settings/maintenance-mode', async (_req, res, next) => {
  try {
    res.json(await getMaintenanceModeSetting());
  } catch (error) {
    next(error);
  }
});

router.put('/settings/maintenance-mode', async (req, res, next) => {
  try {
    const parsed = updateMaintenanceModeSettingSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid input');

    res.json(await updateMaintenanceModeSetting(parsed.data.enabled));
  } catch (error) {
    next(error);
  }
});

router.get('/settings/auto-payment-detection', async (_req, res, next) => {
  try {
    res.json(await getAutoPaymentDetectionSetting());
  } catch (error) {
    next(error);
  }
});

router.put('/settings/auto-payment-detection', async (req, res, next) => {
  try {
    const parsed = updateAutoPaymentDetectionSettingSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid input');

    res.json(await updateAutoPaymentDetectionSetting(parsed.data.enabled));
  } catch (error) {
    next(error);
  }
});

export default router;
