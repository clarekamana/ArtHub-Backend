import { FileCategory } from "@prisma/client";
import { env } from "../config/env";

// FR-2.1: accepted formats per category
const EXTENSION_MAP: Record<string, FileCategory> = {
  jpg: "RASTER_IMAGE",
  jpeg: "RASTER_IMAGE",
  png: "RASTER_IMAGE",
  webp: "RASTER_IMAGE",
  gif: "RASTER_IMAGE",

  svg: "VECTOR_DESIGN",
  ai: "VECTOR_DESIGN",
  psd: "VECTOR_DESIGN",
  fig: "VECTOR_DESIGN",
  sketch: "VECTOR_DESIGN",
  pdf: "VECTOR_DESIGN",

  blend: "THREE_D_NATIVE",
  max: "THREE_D_NATIVE",
  c4d: "THREE_D_NATIVE",

  fbx: "THREE_D_INTERCHANGE",
  obj: "THREE_D_INTERCHANGE",
  stl: "THREE_D_INTERCHANGE",
  dae: "THREE_D_INTERCHANGE",

  gltf: "THREE_D_WEB_READY",
  glb: "THREE_D_WEB_READY",

  zip: "ARCHIVE",
};

const THREE_D_CATEGORIES: FileCategory[] = ["THREE_D_NATIVE", "THREE_D_INTERCHANGE", "THREE_D_WEB_READY"];

// Only formats a headless Blender worker can meaningfully import/export are converted (Section 4.3)
const CONVERTIBLE_EXTENSIONS = new Set(["blend", "fbx", "obj", "dae"]);

export function getExtension(filename: string): string {
  const parts = filename.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

export function categorizeFile(filename: string): FileCategory | null {
  const ext = getExtension(filename);
  return EXTENSION_MAP[ext] ?? null;
}

export function isThreeD(category: FileCategory): boolean {
  return THREE_D_CATEGORIES.includes(category);
}

export function isConvertible(filename: string): boolean {
  return CONVERTIBLE_EXTENSIONS.has(getExtension(filename));
}

/**
 * Hard size ceiling per category (Section 9.3). For 3D files this returns the
 * standard 500MB cap; the 2GB admin-exception ceiling must be checked
 * separately via an approval flag.
 */
export function maxStandardSizeFor(category: FileCategory): number {
  switch (category) {
    case "RASTER_IMAGE":
      return env.maxFileSize.RASTER_IMAGE;
    case "VECTOR_DESIGN":
      return env.maxFileSize.VECTOR_DESIGN;
    case "THREE_D_NATIVE":
    case "THREE_D_INTERCHANGE":
    case "THREE_D_WEB_READY":
      return env.maxFileSize.THREE_D_STANDARD;
    case "ARCHIVE":
      return env.maxFileSize.THREE_D_STANDARD; // bounded by quota in practice
    default:
      return env.maxFileSize.RASTER_IMAGE;
  }
}

export function absoluteMaxSizeFor(category: FileCategory): number {
  return isThreeD(category) ? env.maxFileSize.THREE_D_EXCEPTION : maxStandardSizeFor(category);
}
