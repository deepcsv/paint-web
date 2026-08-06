/**
 * Strict snapshot name sanitizer — allows only [a-zA-Z0-9_-].
 * Prevents path traversal.
 */
export function sanitizeSnapshotName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  if (!cleaned) throw new Error("Invalid snapshot name");
  if (cleaned === "." || cleaned === "..") throw new Error("Invalid snapshot name");
  return cleaned;
}

/**
 * Generate a URL-safe random id for snapshot temp files.
 */
export function randomSnapshotId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
