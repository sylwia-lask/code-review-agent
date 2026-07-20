import { createHash } from 'crypto';

/**
 * Hash a password with SHA-256.
 * NOTE: In production, use bcrypt or argon2 instead!
 */
export function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}
