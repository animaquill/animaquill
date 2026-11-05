import { describe, expect, it } from "vitest";
import { comboOf, formatCombo, isBindable, worksWhileTyping, type KeyEventFacts } from "./keys.ts";

const press = (code: string, modifiers: Partial<KeyEventFacts> = {}): KeyEventFacts => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("comboOf", () => {
  it("names letters, digits and function keys", () => {
    expect(comboOf(press("KeyP"), "other")).toBe("p");
    expect(comboOf(press("Digit2"), "other")).toBe("2");
    expect(comboOf(press("F1"), "other")).toBe("f1");
    expect(comboOf(press("Space"), "other")).toBe("space");
  });

  it("uses the physical key, so Shift does not change the name", () => {
    expect(comboOf(press("Digit1", { shiftKey: true }), "other")).toBe("shift+1");
    expect(comboOf(press("BracketLeft", { shiftKey: true }), "other")).toBe("shift+[");
  });

  it("puts modifiers in a fixed order", () => {
    const event = press("KeyP", { shiftKey: true, altKey: true, ctrlKey: true });
    expect(comboOf(event, "other")).toBe("mod+alt+shift+p");
  });

  it("calls Ctrl mod except on a Mac, where Command is", () => {
    expect(comboOf(press("KeyS", { ctrlKey: true }), "other")).toBe("mod+s");
    expect(comboOf(press("KeyS", { metaKey: true }), "mac")).toBe("mod+s");
    expect(comboOf(press("KeyS", { ctrlKey: true }), "mac")).toBe("ctrl+s");
  });

  it("has no combination while only modifiers are held", () => {
    for (const code of ["ControlLeft", "ShiftRight", "AltLeft", "MetaLeft", "OSLeft", ""]) {
      expect(comboOf(press(code), "other")).toBeUndefined();
    }
  });
});

describe("formatCombo", () => {
  it("writes combinations the way each platform does", () => {
    expect(formatCombo("mod+shift+p", "other")).toBe("Ctrl+Shift+P");
    expect(formatCombo("mod+shift+p", "mac")).toBe("⌘⇧P");
    expect(formatCombo("alt+1", "other")).toBe("Alt+1");
    expect(formatCombo("f1", "other")).toBe("F1");
  });

  it("has readable names for keys without a letter", () => {
    expect(formatCombo("left", "other")).toBe("←");
    expect(formatCombo("escape", "other")).toBe("Esc");
    expect(formatCombo("mod+`", "other")).toBe("Ctrl+`");
    expect(formatCombo("space", "other")).toBe("Space");
  });
});

describe("rules", () => {
  it("keeps the keys of keyboard navigation free", () => {
    for (const combo of ["tab", "shift+tab", "escape", "enter"]) {
      expect(isBindable(combo)).toBe(false);
    }
    expect(isBindable("mod+enter")).toBe(true);
    expect(isBindable("j")).toBe(true);
  });

  it("lets typing win in text boxes", () => {
    for (const combo of ["j", "shift+j", "space", "enter", "mod+c", "mod+v", "mod+z"]) {
      expect(worksWhileTyping(combo)).toBe(false);
    }
  });

  it("still runs real shortcuts in text boxes", () => {
    for (const combo of ["mod+shift+p", "f1", "alt+1", "shift+f2"]) {
      expect(worksWhileTyping(combo)).toBe(true);
    }
  });
});
