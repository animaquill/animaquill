import { describe, expect, it } from "vitest";
import { memoryWindow } from "./memory-library.ts";
import { SettingsNav } from "./settings-nav.ts";

/** Where the settings of a window are, which it keeps for itself through a reload. */
describe("the settings of a window", () => {
  it("open where they were last, also after a reload", () => {
    const memory = memoryWindow();
    const nav = new SettingsNav(memory);
    expect(nav.isOpen).toBe(false);
    nav.open();
    expect(nav.isOpen).toBe(true);
    expect(nav.getSnapshot()).toEqual({ group: "general", depth: 1 });
    nav.go({ group: "chat", depth: 1 });
    nav.close();
    nav.open();
    expect(nav.getSnapshot().group).toBe("chat");
    // A reload: a new window of the same memory.
    const again = new SettingsNav(memory);
    expect(again.isOpen).toBe(false);
    expect(again.getSnapshot()).toEqual({ group: "chat", depth: 1 });
  });

  it("open at a place, and forget a setting that stood out once they open again", () => {
    const nav = new SettingsNav(memoryWindow());
    nav.open({ group: "models", depth: 2, service: "a" });
    expect(nav.getSnapshot()).toEqual({ group: "models", depth: 2, service: "a" });
    nav.go({ group: "export", depth: 1, item: "export.hardware" });
    nav.close();
    nav.open();
    expect(nav.getSnapshot().item).toBeUndefined();
    expect(nav.getSnapshot().group).toBe("export");
  });

  it("go back a level at a time", () => {
    const nav = new SettingsNav(memoryWindow());
    nav.go({ group: "models", depth: 2, service: "a" });
    nav.back();
    expect(nav.getSnapshot()).toEqual({ group: "models", depth: 1 });
    nav.back();
    expect(nav.getSnapshot()).toEqual({ group: "models", depth: 0 });
  });

  it("start in the first group where what was kept is not a group", () => {
    const memory = memoryWindow();
    memory.write("settings.group", "nonsense");
    expect(new SettingsNav(memory).getSnapshot().group).toBe("general");
  });
});
