import type { SettingsStore } from "@animaquill/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionRegistry, type Action } from "./actions.ts";
import { KeybindingService, type KeyDown } from "./keybindings.ts";

const action = (id: string, keys?: string[]) =>
  ({
    id,
    title: () => id,
    run: vi.fn<() => void>(),
    ...(keys ? { keys } : {}),
  }) satisfies Action;

function keyDown(code: string, modifiers: Partial<KeyDown> = {}): KeyDown {
  return {
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    target: null,
    preventDefault: vi.fn(),
    ...modifiers,
  };
}

async function setup(stored?: unknown) {
  const values = new Map<string, unknown>();
  if (stored !== undefined) values.set("keybindings", stored);
  let fromOtherWindow: (value: unknown) => void = () => {};
  const settings: SettingsStore = {
    load: vi.fn(async (key: string) => values.get(key)),
    save: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
    listen: (_, listener) => {
      fromOtherWindow = listener;
      return () => {};
    },
  };
  const open = action("open", ["mod+o", "f2"]);
  const save = action("save", ["mod+s"]);
  const plain = action("plain");
  const actions = new ActionRegistry();
  for (const item of [open, save, plain]) actions.register(item);
  const messages = { restoreFailed: vi.fn(), saveFailed: vi.fn() };
  const service = new KeybindingService(settings, actions, "other", messages);
  await service.load();
  return {
    service,
    actions,
    open,
    save,
    plain,
    settings,
    values,
    messages,
    saveInOtherWindow: (value: unknown) => fromOtherWindow(value),
  };
}

const overrides = (data: Record<string, string[]>) => ({ version: 1, overrides: data });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("running", () => {
  it("runs the action of a key and keeps the browser from acting on it", async () => {
    const { service, open } = await setup();
    const event = keyDown("KeyO", { ctrlKey: true });
    service.handle(event);
    expect(open.run).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves keys without an action alone", async () => {
    const { service } = await setup();
    const event = keyDown("KeyQ", { ctrlKey: true });
    service.handle(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("works while a Chinese input method is on, which reports letters as Process", async () => {
    const { service, plain } = await setup();
    service.assign("plain", "j");
    service.handle({ ...keyDown("KeyJ"), key: "Process" } as KeyDown);
    expect(plain.run).toHaveBeenCalledOnce();
  });

  it("does nothing during composition, when the keys belong to the input method", async () => {
    const { service, plain } = await setup();
    service.assign("plain", "j");
    service.handle(keyDown("KeyJ", { isComposing: true }));
    expect(plain.run).not.toHaveBeenCalled();
  });

  it("runs once when a key is held down", async () => {
    const { service, open } = await setup();
    service.handle(keyDown("KeyO", { ctrlKey: true }));
    service.handle(keyDown("KeyO", { ctrlKey: true, repeat: true }));
    expect(open.run).toHaveBeenCalledOnce();
  });

  it("leaves the key to the browser while the action cannot run", async () => {
    const { service, actions } = await setup();
    const run = vi.fn<() => void>();
    actions.register({ id: "off", title: () => "off", run, keys: ["mod+u"], enabled: () => false });
    service.reset("off");
    const event = keyDown("KeyU", { ctrlKey: true });
    service.handle(event);
    expect(run).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("stays out when something else already handled the key", async () => {
    const { service, open } = await setup();
    service.handle(keyDown("KeyO", { ctrlKey: true, defaultPrevented: true }));
    expect(open.run).not.toHaveBeenCalled();
  });

  it("lets a text box have plain keys", async () => {
    const { service, plain } = await setup();
    service.assign("plain", "j");
    const input = { tagName: "INPUT" } as unknown as EventTarget;
    const event = keyDown("KeyJ", { target: input });
    service.handle(event);
    expect(plain.run).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("lets editable elements have plain keys", async () => {
    const { service, plain } = await setup();
    service.assign("plain", "j");
    const editable = { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;
    service.handle(keyDown("KeyJ", { target: editable }));
    expect(plain.run).not.toHaveBeenCalled();
  });

  it("keeps copy and paste working in a text box, even when they are bound", async () => {
    const { service, plain } = await setup();
    service.assign("plain", "mod+c");
    const input = { tagName: "TEXTAREA" } as unknown as EventTarget;
    service.handle(keyDown("KeyC", { ctrlKey: true, target: input }));
    expect(plain.run).not.toHaveBeenCalled();
  });

  it("still runs shortcuts with modifiers from a text box", async () => {
    const { service, open } = await setup();
    const input = { tagName: "INPUT" } as unknown as EventTarget;
    service.handle(keyDown("KeyO", { ctrlKey: true, target: input }));
    expect(open.run).toHaveBeenCalledOnce();
  });
});

describe("changing", () => {
  it("adds a key next to the existing ones", async () => {
    const { service } = await setup();
    service.assign("open", "mod+k");
    expect(service.keysFor("open")).toEqual(["mod+o", "f2", "mod+k"]);
    expect(service.ownerOf("mod+k")).toBe("open");
  });

  it("moves a key that another action had", async () => {
    const { service } = await setup();
    service.assign("plain", "mod+s");
    expect(service.ownerOf("mod+s")).toBe("plain");
    expect(service.keysFor("save")).toEqual([]);
  });

  it("removes one key and keeps the others", async () => {
    const { service } = await setup();
    service.remove("open", "f2");
    expect(service.keysFor("open")).toEqual(["mod+o"]);
    expect(service.ownerOf("f2")).toBeUndefined();
  });

  it("resets one action", async () => {
    const { service } = await setup();
    service.remove("open", "f2");
    service.remove("save", "mod+s");
    service.reset("open");
    expect(service.keysFor("open")).toEqual(["mod+o", "f2"]);
    expect(service.keysFor("save")).toEqual([]);
    expect(service.isCustomized("open")).toBe(false);
  });

  it("resets everything", async () => {
    const { service } = await setup();
    service.remove("open", "f2");
    service.assign("plain", "mod+s");
    service.resetAll();
    expect(service.keysFor("open")).toEqual(["mod+o", "f2"]);
    expect(service.keysFor("save")).toEqual(["mod+s"]);
    expect(service.hasCustomizations).toBe(false);
  });

  it("does not count as changed once the keys are the default again", async () => {
    const { service } = await setup();
    service.remove("save", "mod+s");
    expect(service.isCustomized("save")).toBe(true);
    service.assign("save", "mod+s");
    expect(service.isCustomized("save")).toBe(false);
  });

  it("tells listeners about a change", async () => {
    const { service } = await setup();
    const listener = vi.fn();
    service.subscribe(listener);
    const before = service.getSnapshot();
    service.assign("plain", "j");
    expect(listener).toHaveBeenCalled();
    expect(service.getSnapshot()).not.toBe(before);
  });
});

describe("saving", () => {
  it("saves only what was changed", async () => {
    const { service, values } = await setup();
    service.assign("plain", "j");
    await vi.waitFor(() => expect(values.get("keybindings")).toEqual(overrides({ plain: ["j"] })));
  });

  it("restores what was saved", async () => {
    const { service, plain } = await setup(overrides({ plain: ["j"], open: [] }));
    expect(service.keysFor("plain")).toEqual(["j"]);
    expect(service.keysFor("open")).toEqual([]);
    service.handle(keyDown("KeyJ"));
    expect(plain.run).toHaveBeenCalledOnce();
  });

  it("gives the person's choice priority over a default that came later", async () => {
    const { service, plain, save } = await setup(overrides({ plain: ["mod+s"] }));
    expect(service.keysFor("save")).toEqual([]);
    service.handle(keyDown("KeyS", { ctrlKey: true }));
    expect(plain.run).toHaveBeenCalledOnce();
    expect(save.run).not.toHaveBeenCalled();
  });

  it("keeps the bindings of actions it does not know, such as a plugin that is off", async () => {
    const { service, values } = await setup(overrides({ "plugin.action": ["mod+u"] }));
    service.assign("plain", "j");
    await vi.waitFor(() =>
      expect(values.get("keybindings")).toEqual(
        overrides({ "plugin.action": ["mod+u"], plain: ["j"] }),
      ),
    );
  });

  it.each([
    ["not an object", "garbage"],
    ["a newer format", { version: 2, overrides: {} }],
    ["no overrides", { version: 1 }],
  ])("falls back to defaults and says so when saved data is %s", async (_, stored) => {
    const { service, messages } = await setup(stored);
    expect(service.keysFor("open")).toEqual(["mod+o", "f2"]);
    expect(messages.restoreFailed).toHaveBeenCalledOnce();
  });

  it("ignores a broken entry and keeps the good ones", async () => {
    const { service, messages } = await setup({
      version: 1,
      overrides: { plain: ["j"], open: "nonsense" },
    });
    expect(service.keysFor("plain")).toEqual(["j"]);
    expect(service.keysFor("open")).toEqual(["mod+o", "f2"]);
    expect(messages.restoreFailed).not.toHaveBeenCalled();
  });

  it("says once that saving fails", async () => {
    const { service, settings, messages } = await setup();
    vi.mocked(settings.save).mockRejectedValue(new Error("quota"));
    service.assign("plain", "j");
    service.assign("plain", "k");
    await vi.waitFor(() => expect(messages.saveFailed).toHaveBeenCalled());
    await Promise.resolve();
    expect(messages.saveFailed).toHaveBeenCalledOnce();
    expect(service.keysFor("plain")).toEqual(["j", "k"]);
  });
});

describe("several windows", () => {
  it("uses what another window changed right away", async () => {
    const { service, saveInOtherWindow } = await setup();
    saveInOtherWindow(overrides({ open: ["mod+k"] }));
    expect(service.keysFor("open")).toEqual(["mod+k"]);
    expect(service.ownerOf("mod+o")).toBeUndefined();
  });

  it("does not bring back an old value when saving here", async () => {
    const { service, values, saveInOtherWindow } = await setup();
    saveInOtherWindow(overrides({ open: ["mod+k"] }));
    service.assign("plain", "mod+j");
    await vi.waitFor(() =>
      expect(values.get("keybindings")).toEqual(overrides({ open: ["mod+k"], plain: ["mod+j"] })),
    );
  });

  it("tells the screen about it", async () => {
    const { service, saveInOtherWindow } = await setup();
    const listener = vi.fn<() => void>();
    service.subscribe(listener);
    saveInOtherWindow(overrides({ open: ["mod+k"] }));
    expect(listener).toHaveBeenCalled();
  });

  it("ignores what it cannot read", async () => {
    const { service, saveInOtherWindow } = await setup(overrides({ open: ["mod+k"] }));
    saveInOtherWindow({ version: 99 });
    expect(service.keysFor("open")).toEqual(["mod+k"]);
  });
});
