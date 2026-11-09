import { describe, expect, it, vi } from "vitest";
import { formatHash, hashFile, hashText, hashingCopy, isSameHash } from "./hash.ts";

const bytes = new Uint8Array(300_000).map((_, index) => index % 251);

async function withCrypto(content: Uint8Array<ArrayBuffer>) {
  return formatHash(new Uint8Array(await crypto.subtle.digest("SHA-256", content)));
}

describe("the hash of a file", () => {
  it("is the same as the browser works out in one go", async () => {
    expect(await hashFile(new Blob([bytes]))).toBe(await withCrypto(bytes));
  });

  it("is written the way projects have it", async () => {
    expect(await hashFile(new Blob([]))).toBe(
      "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU=",
    );
  });

  it("does not depend on how the file is cut up", async () => {
    const parts = [bytes.slice(0, 5), bytes.slice(5, 70_000), bytes.slice(70_000)];
    expect(await hashFile(new Blob(parts))).toBe(await withCrypto(bytes));
  });

  it("reports how far it got", async () => {
    const onProgress = vi.fn<(bytes: number) => void>();
    await hashFile(new Blob([bytes]), { onProgress });
    expect(onProgress).toHaveBeenLastCalledWith(bytes.length);
  });

  it("stops when asked to", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(hashFile(new Blob([bytes]), controller)).rejects.toThrow("stop");
  });

  it("goes on reporting a failure to read", async () => {
    const file = {
      stream: () =>
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("gone"));
          },
        }),
    } as Blob;
    await expect(hashFile(file)).rejects.toThrow("gone");
  });
});

describe("comparing hashes", () => {
  const digest = new Uint8Array(32).map((_, index) => index * 8 + 250);
  const base64 = btoa(String.fromCharCode(...digest));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  it.each([
    ["the same text", formatHash(digest)],
    ["plain base64", `sha256-${base64}`],
    ["base64 without padding", `sha256-${base64.replace(/=+$/, "")}`],
    ["hexadecimal", `sha256-${hex}`],
    ["hexadecimal in capitals", `sha256-${hex.toUpperCase()}`],
  ])("finds %s to be the same", (_, other) => {
    expect(isSameHash(formatHash(digest), other)).toBe(true);
  });

  it.each([
    ["other content", formatHash(new Uint8Array(32))],
    ["too short", "sha256-abcd"],
    ["no hash at all", "sha256-"],
    ["not encoded", "sha256-不是"],
  ])("finds %s to be different", (_, other) => {
    expect(isSameHash(formatHash(digest), other)).toBe(false);
  });

  it("does not take two things it cannot read for the same", () => {
    expect(isSameHash("sha256-abcd", "sha256-abcd")).toBe(false);
  });
});

describe("the hash of a text", () => {
  it("is the hash of its UTF-8, right away", async () => {
    const text = "原子是什么\n";
    expect(hashText(text)).toBe(await hashFile(new Blob([text])));
    expect(hashText(text)).not.toBe(hashText("原子是什么"));
  });
});

describe("a file copied somewhere", () => {
  it("has its hash once it was read to the end, the same as when it is hashed", async () => {
    const file = new Blob([new Uint8Array(200_000).map((_, index) => index % 251)]);
    const copy = hashingCopy(file);
    expect(copy.hash()).toBeUndefined();
    const read = new Uint8Array(await new Response(copy.content.stream()).arrayBuffer());
    expect(read.length).toBe(200_000);
    expect(copy.hash()).toBe(await hashFile(file));
    expect(copy.content.size).toBe(file.size);
  });
});
