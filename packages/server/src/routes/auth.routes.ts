import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { login, getCurrentUser } from '../services/auth.service.ts';
import { authenticate } from '../middleware/auth.ts';
import { loginSchema } from '../utils/validators.ts';
import { AppError } from '../middleware/error-handler.ts';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.toLowerCase() : '';
    return `${req.ip ?? 'unknown'}:${username}`;
  },
  message: { error: '登录尝试过多，请稍后再试', code: 'RATE_LIMITED' },
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid input');

    const result = await login(parsed.data.username, parsed.data.password);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req.user!.sub);
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

export default router;
