import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { authRouter } from "./modules/auth/auth.routes";
import { usersRouter } from "./modules/users/users.routes";
import { uploadsRouter } from "./modules/uploads/uploads.routes";
import { discoveryRouter } from "./modules/discovery/discovery.routes";
import { communityRouter } from "./modules/community/community.routes";
import { collectionsRouter } from "./modules/collections/collections.routes";
import { moderationRouter } from "./modules/moderation/moderation.routes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" })); // file bytes never pass through this server (Section 4.1)
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Section 5.3: rate-limited auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/discovery", discoveryRouter);
app.use("/api/community", communityRouter);
app.use("/api/collections", collectionsRouter);
app.use("/api/admin", moderationRouter);

app.use(notFoundHandler);
app.use(errorHandler);
