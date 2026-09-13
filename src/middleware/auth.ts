import { NextFunction, Request, Response } from "express";
import { UserRole } from "@prisma/client";
import { verifyToken } from "../utils/jwt";
import { ApiError } from "./errorHandler";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; role: UserRole };
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new ApiError(401, "Authentication required");
  }
  try {
    const payload = verifyToken(header.slice("Bearer ".length));
    req.auth = { userId: payload.userId, role: payload.role as UserRole };
    next();
  } catch {
    throw new ApiError(401, "Invalid or expired token");
  }
}

// Populates req.auth if a valid token is present, but never rejects (Guest browsing, FR-4).
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = verifyToken(header.slice("Bearer ".length));
      req.auth = { userId: payload.userId, role: payload.role as UserRole };
    } catch {
      // ignore invalid token for optional auth
    }
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      throw new ApiError(403, "Insufficient permissions");
    }
    next();
  };
}
