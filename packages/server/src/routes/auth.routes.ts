import { Router } from 'express';
import { login } from '../services/auth.service.ts';
import { loginSchema } from '../utils/validators.ts';
import { AppError } from '../middleware/error-handler.ts';

const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid input');

    const result = await login(parsed.data.username, parsed.data.password);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
