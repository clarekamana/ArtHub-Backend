import { PrismaClient } from "@prisma/client";

// Single shared client (Section 4.1: Postgres holds metadata/pointers only, never file bytes)
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});
