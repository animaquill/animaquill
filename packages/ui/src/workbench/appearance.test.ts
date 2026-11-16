import type { SettingsStore } from "@animaquill/host";
import { describe, expect, it, vi } from "vitest";
import { Appearance, type AppearancePage, type FontSize } from "./appearance.ts";

function setup(stored?: unknown, systemLight = false) {
  let other: (value: unknown) => void = () => {};
  const settings: SettingsStore = {
    load: async () => stored,
    save: vi.fn(async () => {}),
    listen: (_, listener) => {
      other = listener;
      return () => {};
    },
  };
  const watching = new Set<() => void>();
  const state = { light: systemLight, shown: [] as [string, FontSize][] };
  const page: AppearancePage = {
    show: (theme, fontSize) => void state.shown.push([theme, fontSize]),
    prefersLight: () => state.light,
    watchSystem(listener) {
      watching.add(listener);
      return () => watching.delete(listener);
    },
  };
  const system = (light: boolean) => {
    state.light = light;
    for (const listener of watching) listener();
  };
  const appearance = new Appearance(settings, page);
  const last = () => state.shown.at(-1);
  return {
    appearance,
    settings,
    system,
    watching,
    last,
    fromOtherWindow: (value: unknown) => other(value),
  };
}

describe("the theme and the size of words", () => {
  it("follow the system by default, at the standard size, also as the system changes", async () => {
    const { appearance, system, last } = setup(undefined, true);
    await appearance.load();
    expect(appearance.getSnapshot()).toEqual({ theme: "system", fontSize: "normal" });
    expect(last()).toEqual(["light", "normal"]);
    system(false);
    expect(last()).toEqual(["dark", "normal"]);
    system(true);
    expect(last()).toEqual(["light", "normal"]);
  });

  it("stay as chosen whatever the system, and keep what is chosen", async () => {
    const { appearance, settings, system, watching, last } = setup();
    await appearance.load();
    appearance.set({ theme: "light" });
    expect(last()).toEqual(["light", "normal"]);
    expect(watching.size).toBe(0);
    system(false);
    expect(last()).toEqual(["light", "normal"]);
    appearance.set({ fontSize: "large" });
    expect(last()).toEqual(["light", "large"]);
    expect(settings.save).toHaveBeenLastCalledWith("appearance", {
      version: 1,
      theme: "light",
      fontSize: "large",
    });
  });

  it("read what was kept, and take what another window chooses", async () => {
    const { appearance, fromOtherWindow, last } = setup({
      version: 1,
      theme: "dark",
      fontSize: "small",
    });
    await appearance.load();
    expect(last()).toEqual(["dark", "small"]);
    const heard = vi.fn();
    appearance.subscribe(heard);
    fromOtherWindow({ version: 1, theme: "light", fontSize: "small" });
    expect(last()).toEqual(["light", "small"]);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("are as by default where what was kept cannot be read, part by part", async () => {
    for (const [stored, theme, fontSize] of [
      [{ version: 2, theme: "light", fontSize: "large" }, "system", "normal"],
      [{ version: 1, theme: "sepia", fontSize: "large" }, "system", "large"],
      [{ version: 1, theme: "light", fontSize: 15 }, "light", "normal"],
      ["light", "system", "normal"],
      [null, "system", "normal"],
    ] as const) {
      const { appearance } = setup(stored);
      await appearance.load();
      expect(appearance.getSnapshot(), JSON.stringify(stored)).toEqual({ theme, fontSize });
    }
  });
});
