/**
 * Section 4.2 step 5 / Section 4.3: malware + .blend-specific auto-run script scan.
 *
 * MVP note: this is the integration boundary for a real scanner (e.g. ClamAV via
 * clamd, or a hosted scanning API). The contract below is what the rest of the
 * pipeline depends on - swap the implementation without touching the worker.
 *
 * Whatever the implementation, it MUST run headless/CLI-only and MUST NOT open
 * .blend files in a way that executes embedded Python (bpy.app.autoexec must
 * stay disabled) - see Section 4.3.
 */
export interface ScanResult {
  clean: boolean;
  reason?: string;
}

export async function scanObject(_bucket: string, _key: string, _mimeType: string): Promise<ScanResult> {
  // TODO(production): shell out to `clamdscan` against the downloaded object, or
  // call a hosted AV API. For the MVP we assume clean so the pipeline is exercisable
  // end-to-end; do not ship this stub to a public deployment.
  return { clean: true };
}
