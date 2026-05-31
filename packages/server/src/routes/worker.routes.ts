import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.ts';
import { getWorkerOrders, completeOrder } from '../services/order.service.ts';

const router = Router();

router.use(authenticate, authorize('WORKER', 'ADMIN'));

router.get('/orders', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const result = await getWorkerOrders(page, limit);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/orders/:orderId/complete', async (req, res, next) => {
  try {
    const result = await completeOrder(req.params.orderId, req.user!.sub);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
