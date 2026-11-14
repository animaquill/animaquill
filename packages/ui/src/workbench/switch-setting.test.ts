import type { SettingsStore } from "@animaquill/host";
import { describe, expect, it, vi } from "vitest";
import { SwitchSetting } from "./switch-setting.ts";

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
  const setting = new SwitchSetting(settings, "proxyOffer", true);
  return { setting, settings, fromOtherWindow: (value: unknown) => other(value) };
}

describe("a preference that is on or off", () => {
  it("is as it is by default until it is set, and keeps what is set", async () => {
    const { setting, settings } = setup();
    await setting.load();
    expect(setting.getSnapshot()).toBe(true);
    setting.set(false);
    expect(setting.getSnapshot()).toBe(false);
    expect(settings.save).toHaveBeenCalledWith("proxyOffer", { version: 1, on: false });
  });

  it("reads what was kept, and takes what another window sets", async () => {
    const { setting, fromOtherWindow } = setup({ version: 1, on: false });
    await setting.load();
    expect(setting.getSnapshot()).toBe(false);
    const heard = vi.fn();
    setting.subscribe(heard);
    fromOtherWindow({ version: 1, on: true });
    expect(setting.getSnapshot()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("stays as it is by default where what was kept cannot be read", async () => {
    for (const broken of [{ version: 2, on: false }, { on: false }, "off", null]) {
      const { setting } = setup(broken);
      await setting.load();
      expect(setting.getSnapshot(), JSON.stringify(broken)).toBe(true);
    }
  });
});
