import { verifyToken, isAdmin } from './auth.js';
import type { User } from './auth.js';

export interface Request {
  headers: Record<string, string>;
  user?: User;
}

export interface Response {
  status: (code: number) => Response;
  json: (body: unknown) => void;
}

type NextFn = () => void;

/**
 * Middleware that checks if the request has a valid auth token.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFn,
): Promise<void> {
  const token = req.headers['authorization']?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }

  const user = await verifyToken(token);

  if (!user) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  req.user = user;
  next();
}

/**
 * Middleware that checks if the authenticated user is an admin.
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFn,
): void {
  if (!req.user || !isAdmin(req.user)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
}
