import { Router } from 'express';
import { createOrder, getOrderByTrackingToken } from '../services/order.service.ts';
import { createOrderSchema } from '../utils/validators.ts';
import { AppError } from '../middleware/error-handler.ts';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid input: redemptionCode and session are required');

    const result = await createOrder(parsed.data.redemptionCode, parsed.data.session);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/track/:trackingToken', async (req, res, next) => {
  try {
    const result = await getOrderByTrackingToken(req.params.trackingToken);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
