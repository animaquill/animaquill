import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenePicture } from "../protocol.ts";
import { startCapture } from "./capture.ts";
import type { Stage } from "./stage.ts";

function setup({ canCapture = true, makesImages = true } = {}) {
  const listeners: (() => void)[] = [];
  const screen: (() => void)[] = [];
  const context = {
    reset: vi.fn(),
    drawImage: vi.fn(),
    globalAlpha: 1,
    ...(canCapture && { drawElementImage: vi.fn() }),
  };
  const canvas = {
    width: 3840,
    getContext: () => context,
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    requestPaint: vi.fn(),
  };
  const nested: unknown[] = [canvas];
  vi.stubGlobal("document", { getElementsByTagName: () => nested });
  vi.stubGlobal("innerWidth", 1920);
  vi.stubGlobal("getComputedStyle", (element: { opacity?: string }) => ({
    opacity: element.opacity ?? "1",
  }));
  const sent: ScenePicture[] = [];
  const reported: string[] = [];
  const wake: (() => void)[] = [];
  const image = { width: 1 };
  const made = makesImages ? Promise.resolve(image) : Promise.reject(new Error("no"));
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(() => made),
  );
  vi.stubGlobal("window", {});
  const body = {} as HTMLElement;
  const capture = startCapture({ canvas, body } as unknown as Stage, {
    send: (picture) => sent.push(picture),
    report: (code) => reported.push(code),
    sleep: () => new Promise((resolve) => wake.push(resolve)),
    onScreenFrame: (run) => screen.push(run),
  });
  /** A frame of the screen and the paint that comes with it, which only something can ask for. */
  const screenFrame = () => {
    for (const run of screen.splice(0)) run();
  };
  const paint = () => {
    screenFrame();
    for (const listener of listeners) listener();
  };
  return {
    capture,
    context,
    canvas,
    body,
    nested,
    sent,
    reported,
    screenFrame,
    listeners,
    wake,
    paint,
    image,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("taking a picture", () => {
  it("is nothing a browser without capture can do", () => {
    expect(setup({ canCapture: false }).capture).toBeUndefined();
  });

  it("waits for the browser to paint, and draws in that moment", async () => {
    const { capture, context, canvas, body, paint, sent, image } = setup();
    const taking = capture?.take(7);
    expect(canvas.requestPaint).toHaveBeenCalledTimes(1);
    expect(context.drawElementImage).not.toHaveBeenCalled();
    paint();
    expect(context.reset).toHaveBeenCalledTimes(1);
    expect(context.drawElementImage).toHaveBeenCalledWith(body, 0, 0);
    await taking;
    expect(sent).toEqual([{ frame: 7, image }]);
  });

  it("goes on when there is no paint, and says so: a hidden frame gets none", async () => {
    const { capture, wake, sent, reported } = setup();
    const taking = capture?.take(7);
    wake[0]?.();
    await taking;
    expect(sent).toEqual([]);
    expect(reported).toEqual(["capture-timeout"]);
  });

  it("tries again when the screen comes back, for what is still the latest frame", async () => {
    const { capture, wake, screenFrame, paint, sent, image } = setup();
    const taking = capture?.take(7);
    wake[0]?.();
    await taking;
    screenFrame();
    paint();
    await vi.waitFor(() => expect(sent).toEqual([{ frame: 7, image }]));
  });

  it("leaves that when another frame was asked for in the meantime", async () => {
    const { capture, wake, screenFrame, paint, sent } = setup();
    const first = capture?.take(7);
    wake[0]?.();
    await first;
    const second = capture?.take(8);
    screenFrame();
    paint();
    await second;
    expect(sent.map(({ frame }) => frame)).toEqual([8]);
  });

  it("a paint that comes too late does not draw anything any more", async () => {
    const { capture, context, wake, listeners } = setup();
    const taking = capture?.take(7);
    wake[0]?.();
    await taking;
    for (const listener of listeners) listener();
    expect(context.drawElementImage).not.toHaveBeenCalled();
  });

  it("says so when the browser cannot draw it, and goes on", async () => {
    const { capture, context, paint, sent, reported } = setup();
    context.drawElementImage?.mockImplementation(() => {
      throw new Error("no");
    });
    const taking = capture?.take(7);
    paint();
    await taking;
    expect(sent).toEqual([]);
    expect(reported).toEqual(["capture-failed"]);
  });

  it("says so when there is no image to be had, and goes on", async () => {
    const { capture, paint, sent, reported } = setup({ makesImages: false });
    const taking = capture?.take(7);
    paint();
    await taking;
    expect(sent).toEqual([]);
    expect(reported).toEqual(["capture-failed"]);
  });

  describe("with a canvas in the page", () => {
    const inner = (box: object, more: object = {}) => ({
      width: 100,
      height: 100,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, ...box }),
      ...more,
    });

    it("draws it on top of the page, where it is, in the pixels of the picture", async () => {
      const { capture, context, nested, paint, reported } = setup();
      const element = inner({ left: 10, top: 20, width: 300, height: 200 });
      nested.push(element);
      const taking = capture?.take(7);
      paint();
      await taking;
      expect(context.drawImage).toHaveBeenCalledWith(element, 20, 40, 600, 400);
      const order = (fake: { mock: { invocationCallOrder: readonly number[] } }) =>
        fake.mock.invocationCallOrder[0] as number;
      expect(order(context.drawElementImage as never)).toBeLessThan(order(context.drawImage));
      expect(reported).toEqual(["canvas-layer"]);
    });

    it("keeps its opacity", async () => {
      const { capture, context, nested, paint } = setup();
      nested.push(inner({}, { opacity: "0.25" }));
      const taking = capture?.take(7);
      paint();
      await taking;
      expect(context.globalAlpha).toBe(0.25);
    });

    it("leaves out what has no box or no pixels, and says nothing", async () => {
      const { capture, context, nested, paint, reported } = setup();
      nested.push(inner({ width: 0 }), inner({}, { height: 0 }));
      const taking = capture?.take(7);
      paint();
      await taking;
      expect(context.drawImage).not.toHaveBeenCalled();
      expect(reported).toEqual([]);
    });

    it("does not draw the stage on itself", async () => {
      const { capture, context, canvas, paint } = setup();
      Object.assign(canvas, {
        height: 2160,
        getBoundingClientRect: () => ({ width: 1, height: 1 }),
      });
      const taking = capture?.take(7);
      paint();
      await taking;
      expect(context.drawImage).not.toHaveBeenCalled();
    });
  });

  it("does not use what the project put in place of the real thing", async () => {
    const { capture, paint, image, sent } = setup();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.resolve("not a picture")),
    );
    const taking = capture?.take(7);
    paint();
    await taking;
    expect(sent).toEqual([{ frame: 7, image }]);
  });
});
