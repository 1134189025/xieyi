import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.ts';
import { config } from '../config.ts';
import { AppError } from '../middleware/error-handler.ts';
import type { JwtPayload } from '../middleware/auth.ts';

export async function login(username: string, password: string) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !user.enabled || user.deletedAt) {
    throw new AppError(401, 'Invalid credentials');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, 'Invalid credentials');
  }

  const payload: JwtPayload = { sub: user.id, role: user.role };
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: '24h' as unknown as number });

  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
    },
  };
}

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.enabled || user.deletedAt) {
    throw new AppError(401, 'Invalid or expired token');
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
  };
}

export async function seedAdmin() {
  const existing = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (existing) return;

  const passwordHash = await bcrypt.hash(config.adminPassword, 10);
  await prisma.user.create({
    data: {
      username: config.adminUsername,
      passwordHash,
      role: 'ADMIN',
      displayName: 'Administrator',
    },
  });
  console.log(`Admin account created: ${config.adminUsername}`);
}
