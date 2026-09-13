import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { hashPassword, comparePassword } from "../../utils/password";
import { signToken } from "../../utils/jwt";
import { asyncHandler, ApiError } from "../../middleware/errorHandler";
import { requireAuth } from "../../middleware/auth";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(2).max(60),
});

// FR-1.1: register via email (OAuth handled by oauthGoogleLogin below)
authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { email, password, displayName } = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new ApiError(409, "Email already registered");

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, passwordHash, displayName },
    });

    const token = signToken({ userId: user.id, role: user.role });
    res.status(201).json({ token, user: toPublicUser(user) });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) throw new ApiError(401, "Invalid credentials");

    const valid = await comparePassword(password, user.passwordHash);
    if (!valid) throw new ApiError(401, "Invalid credentials");
    if (user.status === "BANNED") throw new ApiError(403, "Account banned");

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), status: "ACTIVE" } });

    const token = signToken({ userId: user.id, role: user.role });
    res.json({ token, user: toPublicUser(user) });
  })
);

// FR-1.1: OAuth (Google) - accepts a verified Google sub/email from the client's
// Google Sign-In flow. Real deployments should verify the ID token server-side;
// stubbed here as the MVP boundary since it requires Google credentials.
const oauthSchema = z.object({
  googleSub: z.string(),
  email: z.string().email(),
  displayName: z.string().min(2).max(60),
});

authRouter.post(
  "/oauth/google",
  asyncHandler(async (req, res) => {
    const { googleSub, email, displayName } = oauthSchema.parse(req.body);

    let user = await prisma.user.findUnique({ where: { oauthGoogleSub: googleSub } });
    if (!user) {
      user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        user = await prisma.user.update({ where: { id: user.id }, data: { oauthGoogleSub: googleSub } });
      } else {
        user = await prisma.user.create({ data: { email, displayName, oauthGoogleSub: googleSub } });
      }
    }
    if (user.status === "BANNED") throw new ApiError(403, "Account banned");

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), status: "ACTIVE" } });
    const token = signToken({ userId: user.id, role: user.role });
    res.json({ token, user: toPublicUser(user) });
  })
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
    res.json({ user: toPublicUser(user) });
  })
);

function toPublicUser(user: {
  id: string;
  email: string;
  displayName: string;
  role: string;
  tier: string;
  isArtistMode: boolean;
  storageUsedBytes: bigint;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    tier: user.tier,
    isArtistMode: user.isArtistMode,
    storageUsedBytes: user.storageUsedBytes.toString(),
  };
}
