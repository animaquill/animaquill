import { sha256 } from "@noble/hashes/sha2.js";

export interface HashOptions {
  readonly signal?: AbortSignal;
  /** How much of the file was read so far, in bytes. */
  readonly onProgress?: (bytes: number) => void;
}

const PREFIX = "sha256-";

/** How a project writes down the hash of a file: `sha256-` and the digest in URL-safe base64. */
export function formatHash(digest: Uint8Array): string {
  const text = String.fromCharCode(...digest);
  return `${PREFIX}${btoa(text).replaceAll("+", "-").replaceAll("/", "_")}`;
}

/**
 * The hash of a file of any size. The browser has a faster way, but only for what fits in memory
 * as a whole, and WebAssembly is not an option because of the Content-Security-Policy.
 */
export async function hashFile(file: Blob, { signal, onProgress }: HashOptions = {}) {
  const hash = sha256.create();
  const reader = file.stream().getReader();
  let bytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return formatHash(hash.digest());
      hash.update(value);
      bytes += value.byteLength;
      onProgress?.(bytes);
    }
  } finally {
    // Whatever stopped this, the file does not have to stay open.
    await reader.cancel().catch(() => {});
  }
}

/** The digest in a form that can be compared, whatever a tool wrote it as. */
function digestOf(hash: string): string | undefined {
  const text = hash.slice(PREFIX.length);
  if (/^[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase();
  try {
    const bytes = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    if (bytes.length !== sha256.outputLen) return undefined;
    return [...bytes].map((byte) => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

/**
 * Whether two hashes stand for the same content. The format is public, so a hash can also come
 * from a tool that writes hexadecimal, or base64 with or without padding.
 */
export function isSameHash(a: string, b: string): boolean {
  const digest = digestOf(a);
  return digest !== undefined && digest === digestOf(b);
}
