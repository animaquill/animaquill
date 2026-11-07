import type { RenderLayer } from "@animaquill/core";
import { describe, expect, it, vi } from "vitest";
import {
  failureOf,
  FileArrivals,
  StillFailed,
  stillPictures,
  type StillFailure,
  type StillSources,
} from "./still.ts";

class FakePicture {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

const layer = (id: string, source: RenderLayer["source"], changes = {}): RenderLayer => ({
  id,
  start: 0,
  end: 10,
  offset: 0,
  source,
  fit: "contain",
  fades: { in: 0, out: 0 },
  channels: {},
  ...changes,
});

const image = (id = "picture", file = "file-a") => layer(id, { kind: "image", file });
const video = (id = "film", file = "file-a") => layer(id, { kind: "video", file });
const scene = (id = "scene") =>
  layer(id, {
    kind: "scene",
    scene: "a",
    revision: "1",
    entry: "index.html",
    runtime: 1,
    seed: 1,
    assets: [],
  });
const color = layer("color", { kind: "color", color: "#ff0000" });

const sources = (changes: Partial<StillSources<FakePicture>> = {}): StillSources<FakePicture> => ({
  file: async () => new Blob(["a"]),
  image: async () => new FakePicture(),
  video: async () => new FakePicture(),
  scene: async () => new FakePicture(),
  ...changes,
});

const failureFrom = (work: Promise<unknown>): Promise<StillFailure> =>
  work.then(
    () => {
      throw new Error("There was a picture");
    },
    (error: unknown) => failureOf(error),
  );

describe("files for a still", () => {
  it("wait until the file is there", async () => {
    const arrivals = new FileArrivals();
    const waiting = arrivals.wait("a");
    const file = new Blob(["a"]);
    arrivals.settle("a", file);
    await expect(waiting).resolves.toBe(file);
  });

  it("end when the editor says that it does not have the file", async () => {
    const arrivals = new FileArrivals();
    const waiting = arrivals.wait("a");
    arrivals.settle("a", undefined);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("are one wait however many clips need them", async () => {
    const arrivals = new FileArrivals();
    const both = Promise.all([arrivals.wait("a"), arrivals.wait("a")]);
    const file = new Blob(["a"]);
    arrivals.settle("a", file);
    await expect(both).resolves.toEqual([file, file]);
  });

  it("can be asked for again after that", async () => {
    const arrivals = new FileArrivals();
    void arrivals.wait("a");
    arrivals.settle("a", undefined);
    const again = arrivals.wait("a");
    const file = new Blob(["a"]);
    arrivals.settle("a", file);
    await expect(again).resolves.toBe(file);
  });
});

describe("what a still is made of", () => {
  it("is nothing for a color, which needs no file", async () => {
    const file = vi.fn(async () => undefined);
    await expect(stillPictures([color], 1, sources({ file }))).resolves.toEqual([undefined]);
    expect(file).not.toHaveBeenCalled();
  });

  it("is one picture per layer, in their order", async () => {
    const [first, second, third] = [new FakePicture(), new FakePicture(), new FakePicture()];
    const pictures = await stillPictures(
      [image(), color, video(), scene()],
      1,
      sources({
        image: async () => first,
        video: async () => second,
        scene: async () => third,
      }),
    );
    expect(pictures).toEqual([first, undefined, second, third]);
  });

  it("waits for a file that comes late, and draws nothing until then", async () => {
    const arrivals = new FileArrivals();
    let done = false;
    const pictures = stillPictures([image()], 1, sources({ file: (id) => arrivals.wait(id) })).then(
      (all) => {
        done = true;
        return all;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(done).toBe(false);
    arrivals.settle("file-a", new Blob(["a"]));
    await expect(pictures).resolves.toHaveLength(1);
  });

  it("does not exist when a file is missing", async () => {
    const failure = await failureFrom(
      stillPictures([image("gone")], 1, sources({ file: async () => undefined })),
    );
    expect(failure).toEqual({ reason: "missing-file", layer: "gone", file: "file-a" });
  });

  it("does not exist when a file cannot be decoded, however that shows", async () => {
    const nothing = await failureFrom(
      stillPictures([video("film")], 1, sources({ video: async () => undefined })),
    );
    expect(nothing).toEqual({ reason: "cannot-decode", layer: "film", file: "file-a" });
    const broken = await failureFrom(
      stillPictures([image("it")], 1, sources({ image: () => Promise.reject(new Error("no")) })),
    );
    expect(broken).toEqual({ reason: "cannot-decode", layer: "it", file: "file-a" });
  });

  it("does not exist without the right picture of a scene", async () => {
    const failure: StillFailure = { reason: "scene-frame", layer: "scene", wanted: 7, got: 6 };
    await expect(
      failureFrom(
        stillPictures(
          [scene()],
          1,
          sources({ scene: () => Promise.reject(new StillFailed(failure)) }),
        ),
      ),
    ).resolves.toEqual(failure);
  });

  it("gives back what did arrive when something else did not", async () => {
    const arrived = new FakePicture();
    const failure = await failureFrom(
      stillPictures(
        [scene(), image("gone")],
        1,
        sources({ scene: async () => arrived, file: async () => undefined }),
      ),
    );
    expect(failure.reason).toBe("missing-file");
    expect(arrived.closed).toBe(true);
  });

  it("does not depend on what cannot be seen at this moment", async () => {
    const hidden = { ...image("gone"), fades: { in: 1, out: 0 } };
    const file = vi.fn(async () => undefined);
    await expect(stillPictures([hidden], 0, sources({ file }))).resolves.toEqual([undefined]);
    expect(file).not.toHaveBeenCalled();
  });
});

describe("the reason for no still", () => {
  it("says what went wrong with anything else", () => {
    expect(failureOf(new Error("too large"))).toEqual({ reason: "failed", message: "too large" });
    expect(failureOf("what")).toEqual({ reason: "failed", message: "what" });
  });
});
