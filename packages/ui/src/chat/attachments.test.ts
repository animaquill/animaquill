import { memoryChatImages } from "@animaquill/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAttachments } from "./attachments.ts";

afterEach(() => vi.restoreAllMocks());

describe("addresses of pictures to show", () => {
  it("are made once while held, and revoked when the last holder lets go", async () => {
    const images = memoryChatImages();
    const made = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:one");
    const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const ref = await images.save(new Blob([new Uint8Array([1])], { type: "image/jpeg" }), {
      width: 1,
      height: 1,
    });
    const attachments = new ChatAttachments({
      images,
      side: () => 1568,
      maxBytes: () => 1_000_000,
    });
    // A thumbnail and the large picture of the same.
    expect(await attachments.holdUrl(ref.image)).toBe("blob:one");
    expect(await attachments.holdUrl(ref.image)).toBe("blob:one");
    expect(made).toHaveBeenCalledTimes(1);
    attachments.releaseUrl(ref.image);
    await Promise.resolve();
    expect(revoked).not.toHaveBeenCalled();
    attachments.releaseUrl(ref.image);
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledWith("blob:one"));
    // Held again, it is made again; a picture not here has none, and nothing to revoke.
    await attachments.holdUrl(ref.image);
    expect(made).toHaveBeenCalledTimes(2);
    expect(await attachments.holdUrl("sha256:none")).toBeUndefined();
    attachments.releaseUrl("sha256:none");
    attachments.releaseUrl("sha256:never-held");
    expect(revoked).toHaveBeenCalledTimes(1);
  });
});
