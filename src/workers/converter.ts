/**
 * Section 4.2 step 6 / Section 4.3: headless conversion of a 3D source file into
 * a .glb web-viewable derivative plus a static thumbnail render.
 *
 * MVP note: real conversion must run inside a disposable, network-isolated
 * Docker container invoking a pinned Blender version headlessly, e.g.:
 *
 *   docker run --rm --network none -v <tmp>:/data blender:<pinned-version> \
 *     blender --background --python export_glb.py -- /data/<in> /data/<out>.glb
 *
 * with bpy.app.autoexec explicitly disabled inside export_glb.py. That container
 * boundary is the actual security control from Section 4.3 and is infra, not
 * application code - this module is the integration point the worker calls.
 * The stub below produces a minimal placeholder so the pipeline is testable
 * end-to-end without a Blender install.
 */
export interface ConversionResult {
  success: boolean;
  glbBuffer?: Buffer;
  thumbnailBuffer?: Buffer;
  blenderVersion?: string;
  error?: string;
}

const PINNED_BLENDER_VERSION = "4.2.0";

// Minimal valid PNG (1x1 transparent pixel) used as a placeholder thumbnail.
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

export async function convertToGlbAndThumbnail(
  _localFilePath: string,
  sourceExtension: string
): Promise<ConversionResult> {
  const convertible = ["blend", "fbx", "obj", "dae"].includes(sourceExtension);
  if (!convertible) {
    return { success: false, error: `No headless converter available for .${sourceExtension}` };
  }

  // TODO(production): invoke the sandboxed Blender container described above and
  // read back the produced .glb + thumbnail bytes instead of this placeholder.
  return {
    success: true,
    glbBuffer: Buffer.from("glTF"), // placeholder - not a valid glb, MVP wiring only
    thumbnailBuffer: PLACEHOLDER_PNG,
    blenderVersion: PINNED_BLENDER_VERSION,
  };
}
