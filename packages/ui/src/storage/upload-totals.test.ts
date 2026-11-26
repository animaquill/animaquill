import { describe, expect, it } from "vitest";
import type { UploadItem } from "./uploads.ts";
import { uploadTotals } from "./UploadsSection.tsx";

/** What the status bar says of files on their way: what waits for the server's disk is not. */
describe("files on their way, all together", () => {
  const item = (asset: string, more: Partial<UploadItem>): UploadItem =>
    ({
      asset,
      name: asset,
      size: 100,
      hash: "h",
      received: 0,
      phase: "sending",
      at: 0,
      ...more,
    }) as UploadItem;

  it("leave out what waits for the disk of the server", () => {
    const totals = uploadTotals({
      key: "p",
      sender: "here",
      blocked: undefined,
      items: [
        item("a", { received: 50 }),
        item("b", { phase: "busy", diskFull: true }),
        item("c", { phase: "busy", received: 100 }),
      ],
    });
    expect(totals.going.map(({ asset }) => asset)).toEqual(["a", "c"]);
    expect(totals.percent).toBe(75);
  });
});
