import { AccountTier } from "@prisma/client";
import { env } from "../config/env";

// Section 9.1: quota applies to the sum of original files only; derivatives are excluded.
export function quotaForTier(tier: AccountTier): bigint {
  return tier === "VERIFIED" ? env.quotas.verifiedBytes : env.quotas.freeBytes;
}

export function hasRoomFor(usedBytes: bigint, tier: AccountTier, incomingBytes: bigint): boolean {
  return usedBytes + incomingBytes <= quotaForTier(tier);
}
