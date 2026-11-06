import type { SettingsStore } from "@animaquill/host";
import { describe, expect, it, vi } from "vitest";
import { InputMode } from "./input-mode.ts";

function setup(stored?: unknown) {
  let other: (value: unknown) => void = () => {};
  const settings: SettingsStore = {
    load: async () => stored,
    save: vi.fn(async () => {}),
    listen: (_, listener) => {
      other = listener;
      return () => {};
    },
  };
  return { mode: new InputMode(settings), settings, fromOtherWindow: (v: unknown) => other(v) };
}

describe("automatic", () => {
  it("follows what is used", () => {
    const { mode } = setup();
    expect(mode.getSnapshot().device).toBe("mouse");
    mode.notice("trackpad");
    expect(mode.getSnapshot()).toEqual({ choice: "auto", device: "trackpad" });
    mode.noticePointer("touch");
    expect(mode.getSnapshot().device).toBe("touch");
    mode.noticePointer("mouse");
    expect(mode.getSnapshot().device).toBe("mouse");
  });

  it("does not take a click on a trackpad for a mouse", () => {
    const { mode } = setup();
    mode.notice("trackpad");
    mode.noticePointer("mouse");
    expect(mode.getSnapshot().device).toBe("trackpad");
  });

  it("goes by the pointer, and leaves the wheel to its steps", () => {
    const { mode } = setup();
    expect(mode.isTouch("touch")).toBe(true);
    expect(mode.isTouch("mouse")).toBe(false);
    expect(mode.wheelDevice).toBeUndefined();
  });
});

describe("a choice", () => {
  it("stays, whatever gets used", () => {
    const { mode, settings } = setup();
    mode.choose("trackpad");
    mode.notice("mouse");
    expect(mode.getSnapshot()).toEqual({ choice: "trackpad", device: "trackpad" });
    expect(mode.wheelDevice).toBe("trackpad");
    expect(settings.save).toHaveBeenCalledOnce();
  });

  it("makes a mouse work like a finger, or a finger like a mouse", () => {
    const { mode } = setup();
    mode.choose("touch");
    expect(mode.isTouch("mouse")).toBe(true);
    mode.choose("mouse");
    expect(mode.isTouch("touch")).toBe(false);
  });

  it("comes back, and follows other windows", async () => {
    const { mode, fromOtherWindow } = setup({ version: 1, choice: "touch" });
    await mode.load();
    expect(mode.getSnapshot().choice).toBe("touch");
    fromOtherWindow({ version: 1, choice: "mouse" });
    expect(mode.getSnapshot().choice).toBe("mouse");
    fromOtherWindow({ version: 1, choice: "nonsense" });
    expect(mode.getSnapshot().choice).toBe("mouse");
  });
});
