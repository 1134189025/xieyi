import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.ts';
import {
  claimNextPaymentOrder,
  completeClaimedPaymentOrder,
  getWorkerClaimedOrders,
  getWorkerOrders,
  getWorkerSummary,
  releaseClaimedPaymentOrder,
  renewClaimedPaymentOrder,
} from '../services/order.service.ts';

const router = Router();

router.use(authenticate, authorize('WORKER', 'ADMIN'));

router.get('/orders', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const result = await getWorkerClaimedOrders(req.user!.sub, page, limit);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/orders/available', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const result = await getWorkerOrders(page, limit);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/orders/mine', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const result = await getWorkerClaimedOrders(req.user!.sub, page, limit);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/summary', async (req, res, next) => {
  try {
    const summary = await getWorkerSummary(req.user!.sub);
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

router.post('/orders/claim-next', async (req, res, next) => {
  try {
    const order = await claimNextPaymentOrder(req.user!.sub);
    res.json({ order });
  } catch (error) {
    next(error);
  }
});

router.post('/orders/:orderId/renew', async (req, res, next) => {
  try {
    res.json(await renewClaimedPaymentOrder(req.params.orderId, req.user!.sub));
  } catch (error) {
    next(error);
  }
});

router.post('/orders/:orderId/release', async (req, res, next) => {
  try {
    res.json(await releaseClaimedPaymentOrder(req.params.orderId, req.user!.sub));
  } catch (error) {
    next(error);
  }
});

router.post('/orders/:orderId/complete', async (req, res, next) => {
  try {
    const result = await completeClaimedPaymentOrder(req.params.orderId, req.user!.sub);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
