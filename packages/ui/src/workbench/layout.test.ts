import type { SettingsStore } from "@animaquill/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LayoutController,
  type Dock,
  type LayoutNode,
  type WorkspaceDefinition,
} from "./layout.ts";

const layoutOf = (panel: string): LayoutNode => ({ kind: "tabs", panels: [panel] });

const WORKSPACES: WorkspaceDefinition[] = [
  { id: "edit", title: () => "edit", layout: layoutOf("timeline") },
  { id: "animate", title: () => "animate", layout: layoutOf("keyframes") },
];

/** Keeps the arrangement as a plain value. Like dockview, it reports changes a moment later. */
class FakeDock implements Dock {
  state: unknown = "empty";
  rejects = new Set<unknown>();
  #listener: (() => void) | undefined;

  #announce() {
    setTimeout(() => this.#listener?.(), 0);
  }

  arrange(layout: LayoutNode) {
    this.state = layout;
    this.#announce();
  }

  restore(state: unknown) {
    if (this.rejects.has(state)) throw new Error("unusable");
    this.state = state;
    this.#announce();
  }

  serialize = () => this.state;
  open = vi.fn();
  items = () => [{ type: "timeline", visible: true }];

  onChange(listener: () => void) {
    this.#listener = listener;
    return () => (this.#listener = undefined);
  }

  /** What dragging a tab looks like from the outside. */
  async userChanges(state: unknown) {
    this.state = state;
    this.#announce();
    await vi.advanceTimersByTimeAsync(0);
  }
}

function setup(stored?: unknown) {
  const values = new Map<string, unknown>();
  if (stored !== undefined) values.set("layout", stored);
  const settings: SettingsStore = {
    load: vi.fn(async (key: string) => values.get(key)),
    save: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
  };
  const messages = { restoreFailed: vi.fn(), saveFailed: vi.fn() };
  const layout = new LayoutController(settings, WORKSPACES, messages);
  const dock = new FakeDock();
  return { layout, dock, settings, messages, values };
}

const saved = (workspace: string, states: Record<string, unknown>) => ({
  version: 1,
  workspace,
  states,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("opening", () => {
  it("starts with the first workspace when nothing was saved", async () => {
    const { layout, dock, messages } = setup();
    await layout.load();
    layout.attach(dock);
    expect(dock.state).toEqual(layoutOf("timeline"));
    expect(layout.getSnapshot().workspace).toBe("edit");
    expect(messages.restoreFailed).not.toHaveBeenCalled();
  });

  it("restores the saved workspace and its arrangement", async () => {
    const { layout, dock } = setup(saved("animate", { animate: "my arrangement" }));
    await layout.load();
    layout.attach(dock);
    expect(dock.state).toBe("my arrangement");
    expect(layout.getSnapshot().workspace).toBe("animate");
  });

  it.each([
    ["not an object", "garbage"],
    ["a newer format", { version: 2, workspace: "edit", states: {} }],
    ["no states", { version: 1, workspace: "edit" }],
    ["null", null],
  ])("falls back and says so when saved data is %s", async (_, stored) => {
    const { layout, dock, messages } = setup(stored);
    await layout.load();
    layout.attach(dock);
    expect(dock.state).toEqual(layoutOf("timeline"));
    expect(messages.restoreFailed).toHaveBeenCalledOnce();
  });

  it("falls back and says so when the store cannot be read", async () => {
    const { layout, dock, settings, messages } = setup();
    vi.mocked(settings.load).mockRejectedValue(new SyntaxError("bad JSON"));
    await layout.load();
    layout.attach(dock);
    expect(dock.state).toEqual(layoutOf("timeline"));
    expect(messages.restoreFailed).toHaveBeenCalledOnce();
  });

  it("falls back and says so when the dock refuses the saved arrangement", async () => {
    const { layout, dock, messages } = setup(saved("edit", { edit: "broken" }));
    dock.rejects.add("broken");
    await layout.load();
    layout.attach(dock);
    expect(dock.state).toEqual(layoutOf("timeline"));
    expect(messages.restoreFailed).toHaveBeenCalledOnce();
  });

  it("uses the first workspace when the saved one no longer exists", async () => {
    const { layout, dock, messages } = setup(saved("removed", { removed: "old" }));
    await layout.load();
    layout.attach(dock);
    expect(layout.getSnapshot().workspace).toBe("edit");
    expect(dock.state).toEqual(layoutOf("timeline"));
    expect(messages.restoreFailed).not.toHaveBeenCalled();
  });

  it.each([
    ["a saved layout", saved("edit", { edit: "mine" })],
    ["nothing saved", undefined],
  ])("does not write anything just because it opened with %s", async (_, stored) => {
    const { layout, dock, settings } = setup(stored);
    await layout.load();
    layout.attach(dock);
    await vi.runAllTimersAsync();
    await layout.flush();
    expect(settings.save).not.toHaveBeenCalled();
  });

  it("leaves data it could not read alone until something really changes", async () => {
    const { layout, dock, settings } = setup("garbage");
    await layout.load();
    layout.attach(dock);
    await vi.runAllTimersAsync();
    expect(settings.save).not.toHaveBeenCalled();
    await dock.userChanges("mine");
    await vi.runAllTimersAsync();
    expect(settings.save).toHaveBeenCalledOnce();
  });
});

describe("saving", () => {
  it("saves a change after a short delay, once for a burst of changes", async () => {
    const { layout, dock, settings, values } = setup();
    await layout.load();
    layout.attach(dock);
    await dock.userChanges("first");
    await dock.userChanges("second");
    expect(settings.save).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(settings.save).toHaveBeenCalledOnce();
    expect(values.get("layout")).toEqual(saved("edit", { edit: "second" }));
  });

  it("saves at once when the page is going away", async () => {
    const { layout, dock, values } = setup();
    await layout.load();
    layout.attach(dock);
    await dock.userChanges("mine");
    await layout.flush();
    expect(values.get("layout")).toEqual(saved("edit", { edit: "mine" }));
  });

  it("keeps the arrangement when the dock goes away and comes back", async () => {
    const { layout, dock, values } = setup();
    await layout.load();
    layout.attach(dock);
    await dock.userChanges("mine");
    await layout.detach();
    expect(values.get("layout")).toEqual(saved("edit", { edit: "mine" }));
    const next = new FakeDock();
    layout.attach(next);
    expect(next.state).toBe("mine");
  });

  it("ignores a dock that is gone", async () => {
    const { layout, dock, settings } = setup();
    await layout.load();
    layout.attach(dock);
    await layout.detach();
    await dock.userChanges("too late");
    await vi.runAllTimersAsync();
    expect(settings.save).not.toHaveBeenCalled();
  });

  it("has nothing to do when the page goes away with no change", async () => {
    const { layout, dock, settings } = setup();
    await layout.load();
    layout.attach(dock);
    await layout.flush();
    expect(settings.save).not.toHaveBeenCalled();
  });

  it("says once that saving fails, and again only after it worked in between", async () => {
    const { layout, dock, settings, messages } = setup();
    await layout.load();
    layout.attach(dock);
    vi.mocked(settings.save).mockRejectedValue(new Error("quota"));
    await dock.userChanges("a");
    await vi.runAllTimersAsync();
    await dock.userChanges("b");
    await vi.runAllTimersAsync();
    expect(messages.saveFailed).toHaveBeenCalledOnce();

    vi.mocked(settings.save).mockResolvedValue();
    await dock.userChanges("c");
    await vi.runAllTimersAsync();
    vi.mocked(settings.save).mockRejectedValue(new Error("quota"));
    await dock.userChanges("d");
    await vi.runAllTimersAsync();
    expect(messages.saveFailed).toHaveBeenCalledTimes(2);
  });

  it("tries again after a failed save, even without a new change", async () => {
    const { layout, dock, settings, values } = setup();
    await layout.load();
    layout.attach(dock);
    vi.mocked(settings.save).mockRejectedValueOnce(new Error("quota"));
    await dock.userChanges("mine");
    await vi.runAllTimersAsync();
    expect(values.has("layout")).toBe(false);
    await dock.userChanges("mine");
    await vi.runAllTimersAsync();
    expect(values.get("layout")).toEqual(saved("edit", { edit: "mine" }));
  });
});

describe("workspaces", () => {
  it("remembers the arrangement of each workspace", async () => {
    const { layout, dock } = setup();
    await layout.load();
    layout.attach(dock);
    await dock.userChanges("my edit");
    layout.switchWorkspace("animate");
    expect(dock.state).toEqual(layoutOf("keyframes"));
    await dock.userChanges("my animate");
    layout.switchWorkspace("edit");
    expect(dock.state).toBe("my edit");
    layout.switchWorkspace("animate");
    expect(dock.state).toBe("my animate");
  });

  it("resets only the current workspace", async () => {
    const { layout, dock } = setup();
    await layout.load();
    layout.attach(dock);
    await dock.userChanges("my edit");
    layout.switchWorkspace("animate");
    await dock.userChanges("my animate");
    layout.resetWorkspace();
    expect(dock.state).toEqual(layoutOf("keyframes"));
    layout.switchWorkspace("edit");
    expect(dock.state).toBe("my edit");
  });

  it("saves which workspace is open", async () => {
    const { layout, dock, values } = setup();
    await layout.load();
    layout.attach(dock);
    layout.switchWorkspace("animate");
    await vi.runAllTimersAsync();
    expect(values.get("layout")).toMatchObject({ workspace: "animate" });
  });

  it("ignores a workspace that does not exist", async () => {
    const { layout, dock } = setup();
    await layout.load();
    layout.attach(dock);
    layout.switchWorkspace("nope");
    expect(layout.getSnapshot().workspace).toBe("edit");
  });

  it("forgets every arrangement when asked", async () => {
    const { layout, dock, values } = setup(saved("edit", { edit: "bad", animate: "bad too" }));
    await layout.load();
    layout.attach(dock);
    await layout.forget();
    expect(values.get("layout")).toEqual(saved("edit", {}));
  });
});
