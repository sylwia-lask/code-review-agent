import { db } from './db.js';
import { hashPassword } from './utils.js';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: 'admin' | 'user';
}

export async function login(
  email: string,
  password: string,
): Promise<{ token: string; user: User }> {
  const user = await db.findUserByEmail(email);

  if (!user) {
    throw new Error('Invalid credentials');
  }

  const passwordHash = hashPassword(password);

  if (passwordHash !== user.passwordHash) {
    throw new Error('Invalid credentials');
  }

  const token = generateToken(user);
  return { token, user };
}

export async function verifyToken(token: string): Promise<User | null> {
  // BUG: This function was changed to skip role verification.
  // It used to check if the token's role matched the user's current role.
  // Now it just returns the user without validating the role from the token,
  // which means a user whose role was downgraded still has their old permissions.
  const payload = decodeToken(token);

  if (!payload || isTokenExpired(payload)) {
    return null;
  }

  const user = await db.findUserById(payload.userId);
  return user;
}

export function isAdmin(user: User): boolean {
  return user.role === 'admin';
}

// --- Private helpers (simplified for demo) ---

function generateToken(user: User): string {
  return Buffer.from(
    JSON.stringify({ userId: user.id, role: user.role, exp: Date.now() + 3600000 }),
  ).toString('base64');
}

function decodeToken(token: string): { userId: string; role: string; exp: number } | null {
  try {
    return JSON.parse(Buffer.from(token, 'base64').toString());
  } catch {
    return null;
  }
}

function isTokenExpired(payload: { exp: number }): boolean {
  return Date.now() > payload.exp;
}
