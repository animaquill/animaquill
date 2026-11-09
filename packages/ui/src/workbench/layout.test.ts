import type { SettingsStore } from "@animaquill/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LayoutController,
  neighboursIn,
  panelsOf,
  pruneLayout,
  type Dock,
  type LayoutNode,
  type LayoutPreset,
  type PanelNeighbours,
} from "./layout.ts";
import { memoryWindow } from "./memory-library.ts";

const tabs = (...panels: string[]): LayoutNode => ({ kind: "tabs", panels });
const row = (...children: (readonly [number, LayoutNode])[]): LayoutNode => ({
  kind: "split",
  direction: "row",
  children,
});
const column = (...children: (readonly [number, LayoutNode])[]): LayoutNode => ({
  kind: "split",
  direction: "column",
  children,
});

/** "soon" is in the design of the first layout, but not ready yet. */
const PRESETS: LayoutPreset[] = [
  { id: "edit", title: () => "edit", layout: tabs("timeline", "soon") },
  { id: "animate", title: () => "animate", layout: tabs("keyframes") },
];
const DESIGN_OF_EDIT = tabs("timeline");
const DESIGN_OF_ANIMATE = tabs("keyframes");
const READY = ["keyframes", "timeline"];

/** An arrangement the way the fake dock saves it. */
const arranged = (name: string, panels = ["timeline"]) => ({ name, panels });

/** Keeps the arrangement as a plain value. Like dockview, it reports changes a moment later. */
class FakeDock implements Dock {
  state: unknown = "empty";
  rejects = new Set<string>();
  added: { type: string; neighbours: PanelNeighbours }[] = [];
  #listener: (() => void) | undefined;

  #announce() {
    setTimeout(() => this.#listener?.(), 0);
  }

  #panels(): readonly string[] {
    const state = this.state as { kind?: string; panels?: readonly string[] } | undefined;
    if (state?.kind) return panelsOf(state as LayoutNode);
    return state?.panels ?? [];
  }

  arrange(layout: LayoutNode | undefined) {
    this.state = layout;
    this.#announce();
  }

  restore(state: unknown) {
    if (this.rejects.has((state as { name?: string }).name ?? "")) throw new Error("unusable");
    this.state = state;
    this.#announce();
  }

  serialize = () => this.state;
  open = vi.fn();

  add(type: string, neighbours: PanelNeighbours) {
    this.added.push({ type, neighbours });
    const { name } = this.state as { name: string };
    this.state = arranged(name, [...this.#panels(), type]);
    this.#announce();
  }

  items = () => this.#panels().map((type) => ({ type, visible: true }));
  active = () => this.#panels()[0];

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

interface Saved {
  version: number;
  current: string;
  custom: { id: string; name: string; base: string; design: { dock: unknown } }[];
  states: Record<string, { dock: unknown; panels: string[] }>;
}

function setup(stored?: unknown, memory = memoryWindow()) {
  const values = new Map<string, unknown>();
  if (stored !== undefined) values.set("layout", stored);
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
  const messages = { restoreFailed: vi.fn(), saveFailed: vi.fn() };
  const ready = new Set(READY);
  const layout = new LayoutController(settings, memory, PRESETS, () => ready, messages);
  const dock = new FakeDock();
  const saveInOtherWindow = (value: unknown) => {
    values.set("layout", value);
    fromOtherWindow(value);
  };
  const storedNow = () => values.get("layout") as Saved;
  return { layout, dock, settings, messages, values, memory, ready, saveInOtherWindow, storedNow };
}

/** Saved data in the current format. Arrangements are given by what the dock saved. */
const saved = (
  current: string,
  states: Record<string, unknown>,
  custom: Saved["custom"] = [],
): Saved => ({
  version: 2,
  current,
  custom,
  states: Object.fromEntries(
    Object.entries(states).map(([id, dock]) => [id, { dock, panels: READY }]),
  ),
});

async function opened(stored?: unknown, memory?: ReturnType<typeof memoryWindow>) {
  const context = setup(stored, memory);
  await context.layout.load();
  context.layout.attach(context.dock);
  return context;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pruning a design", () => {
  it("leaves out panels, then empty groups, then splits with one part", () => {
    const design = column([60, row([1, tabs("a", "x")], [1, tabs("x")])], [40, tabs("b")]);
    expect(pruneLayout(design, (type) => type !== "x")).toEqual(
      column([60, tabs("a")], [40, tabs("b")]),
    );
  });

  it("joins what is left of a part to a split that runs the same way", () => {
    const inner = column([1, tabs("a")], [3, tabs("b")]);
    const design = column([50, row([1, tabs("x")], [1, inner])], [50, tabs("c")]);
    expect(pruneLayout(design, (type) => type !== "x")).toEqual(
      column([12.5, tabs("a")], [37.5, tabs("b")], [50, tabs("c")]),
    );
  });

  it("keeps where the tabs are and whether they show their names", () => {
    const side: LayoutNode = { kind: "tabs", panels: ["a", "x"], strip: "left", pinned: false };
    expect(pruneLayout(side, (type) => type !== "x")).toEqual({ ...side, panels: ["a"] });
  });

  it("keeps the tab that shows, unless it is left out", () => {
    const group: LayoutNode = { kind: "tabs", panels: ["a", "b", "x"], active: "b" };
    expect(pruneLayout(group, (type) => type !== "x")).toEqual({ ...group, panels: ["a", "b"] });
    expect(pruneLayout(group, (type) => type !== "b")).toEqual(tabs("a", "x"));
  });

  it("has nothing left when nothing is ready", () => {
    expect(pruneLayout(row([1, tabs("x")]), () => false)).toBeUndefined();
  });

  it("knows the neighbours of a panel, the nearest first", () => {
    const design = row([1, tabs("z")], [1, tabs("a", "b", "c", "d")]);
    expect(neighboursIn(design, "c")).toEqual({ before: ["b", "a"], after: ["d"] });
    expect(neighboursIn(design, "nope")).toBeUndefined();
  });
});

describe("opening", () => {
  it("starts with the first layout, without what is not ready, when nothing was saved", async () => {
    const { layout, dock, messages } = await opened();
    expect(dock.state).toEqual(DESIGN_OF_EDIT);
    expect(layout.getSnapshot().layout).toBe("edit");
    expect(messages.restoreFailed).not.toHaveBeenCalled();
  });

  it("restores the saved layout and its arrangement", async () => {
    const { layout, dock } = await opened(saved("animate", { animate: arranged("mine") }));
    expect(dock.state).toEqual(arranged("mine"));
    expect(layout.getSnapshot().layout).toBe("animate");
  });

  it.each([
    ["not an object", "garbage"],
    ["a newer format", { version: 3, current: "edit", custom: [], states: {} }],
    ["no states", { version: 2, current: "edit", custom: [] }],
    ["an arrangement without its panels", { ...saved("edit", {}), states: { edit: { dock: {} } } }],
    ["a layout of one's own without a name", { ...saved("edit", {}), custom: [{ id: "c" }] }],
    ["null", null],
  ])("falls back and says so when saved data is %s", async (_, stored) => {
    const { dock, messages } = await opened(stored);
    expect(dock.state).toEqual(DESIGN_OF_EDIT);
    expect(messages.restoreFailed).toHaveBeenCalledOnce();
  });

  it("drops the workspaces of before without a word", async () => {
    const { dock, messages } = await opened({ version: 1, workspace: "edit", states: {} });
    expect(dock.state).toEqual(DESIGN_OF_EDIT);
    expect(messages.restoreFailed).not.toHaveBeenCalled();
  });

  it("falls back and says so when the store cannot be read", async () => {
    const { layout, dock, settings, messages } = setup();
    vi.mocked(settings.load).mockRejectedValue(new SyntaxError("bad JSON"));
    await layout.load();
    layout.attach(dock);
    expect(dock.state).toEqual(DESIGN_OF_EDIT);
    expect(messages.restoreFailed).toHaveBeenCalledOnce();
  });

  it("falls back and says so when the dock refuses the saved arrangement", async () => {
    const { layout, dock, messages } = setup(saved("edit", { edit: arranged("broken") }));
    dock.rejects.add("broken");
    await layout.load();
    layout.attach(dock);
    expect(dock.state).toEqual(DESIGN_OF_EDIT);
    expect(messages.restoreFailed).toHaveBeenCalledOnce();
  });

  it("uses the first layout when the saved one no longer exists", async () => {
    const { layout, dock, messages } = await opened(saved("removed", { removed: arranged("old") }));
    expect(layout.getSnapshot().layout).toBe("edit");
    expect(dock.state).toEqual(DESIGN_OF_EDIT);
    expect(messages.restoreFailed).not.toHaveBeenCalled();
  });

  it.each([
    ["a saved layout", saved("edit", { edit: arranged("mine") })],
    ["nothing saved", undefined],
  ])("does not write anything just because it opened with %s", async (_, stored) => {
    const { layout, settings } = await opened(stored);
    await vi.runAllTimersAsync();
    await layout.flush();
    expect(settings.save).not.toHaveBeenCalled();
  });

  it("leaves data it could not read alone until something really changes", async () => {
    const { dock, settings } = await opened("garbage");
    await vi.runAllTimersAsync();
    expect(settings.save).not.toHaveBeenCalled();
    await dock.userChanges(arranged("mine"));
    await vi.runAllTimersAsync();
    expect(settings.save).toHaveBeenCalledOnce();
  });
});

describe("panels that come later", () => {
  it("take their place in a layout people arranged, once", async () => {
    const context = setup(saved("edit", { edit: arranged("mine") }));
    context.ready.add("soon");
    await context.layout.load();
    context.layout.attach(context.dock);
    expect(context.dock.added).toEqual([
      { type: "soon", neighbours: { before: ["timeline"], after: [] } },
    ]);
    expect(context.dock.state).toEqual(arranged("mine", ["timeline", "soon"]));

    // Closing it afterwards is a choice, which stays.
    await context.dock.userChanges(arranged("mine without soon"));
    context.layout.switchLayout("animate");
    context.layout.switchLayout("edit");
    expect(context.dock.added).toHaveLength(1);
    expect(context.dock.state).toEqual(arranged("mine without soon"));
  });

  it("are not added again where they are already", async () => {
    const context = setup(saved("edit", { edit: arranged("mine", ["timeline", "soon"]) }));
    context.ready.add("soon");
    await context.layout.load();
    context.layout.attach(context.dock);
    expect(context.dock.added).toEqual([]);
  });

  it("are in the design from the start", async () => {
    const context = setup();
    context.ready.add("soon");
    await context.layout.load();
    context.layout.attach(context.dock);
    expect(context.dock.state).toEqual(tabs("timeline", "soon"));
  });

  it("find their place in people's own layouts too, by the preset they came from", async () => {
    const { layout, dock, storedNow } = await opened();
    await dock.userChanges(arranged("mine"));
    const id = layout.saveAs("Mine") as string;
    await vi.runAllTimersAsync();
    const later = setup(storedNow());
    later.ready.add("soon");
    await later.layout.load();
    later.layout.attach(later.dock);
    expect(later.layout.getSnapshot().layout).toBe(id);
    expect(later.dock.added.map((added) => added.type)).toEqual(["soon"]);
  });
});

describe("saving", () => {
  it("saves a change after a short delay, once for a burst of changes", async () => {
    const { dock, settings, storedNow } = await opened();
    await dock.userChanges(arranged("first"));
    await dock.userChanges(arranged("second"));
    expect(settings.save).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(settings.save).toHaveBeenCalledOnce();
    expect(storedNow()).toEqual(saved("edit", { edit: arranged("second") }));
  });

  it("saves at once when the page is going away", async () => {
    const { layout, dock, storedNow } = await opened();
    await dock.userChanges(arranged("mine"));
    await layout.flush();
    expect(storedNow()).toEqual(saved("edit", { edit: arranged("mine") }));
  });

  it("keeps the arrangement when the dock goes away and comes back", async () => {
    const { layout, dock, storedNow } = await opened();
    await dock.userChanges(arranged("mine"));
    await layout.detach();
    expect(storedNow()).toEqual(saved("edit", { edit: arranged("mine") }));
    const next = new FakeDock();
    layout.attach(next);
    expect(next.state).toEqual(arranged("mine"));
  });

  it("ignores a dock that is gone", async () => {
    const { layout, dock, settings } = await opened();
    await layout.detach();
    await dock.userChanges(arranged("too late"));
    await vi.runAllTimersAsync();
    expect(settings.save).not.toHaveBeenCalled();
  });

  it("has nothing to do when the page goes away with no change", async () => {
    const { layout, settings } = await opened();
    await layout.flush();
    expect(settings.save).not.toHaveBeenCalled();
  });

  it("says once that saving fails, and again only after it worked in between", async () => {
    const { dock, settings, messages } = await opened();
    vi.mocked(settings.save).mockRejectedValue(new Error("quota"));
    await dock.userChanges(arranged("a"));
    await vi.runAllTimersAsync();
    await dock.userChanges(arranged("b"));
    await vi.runAllTimersAsync();
    expect(messages.saveFailed).toHaveBeenCalledOnce();

    vi.mocked(settings.save).mockResolvedValue();
    await dock.userChanges(arranged("c"));
    await vi.runAllTimersAsync();
    vi.mocked(settings.save).mockRejectedValue(new Error("quota"));
    await dock.userChanges(arranged("d"));
    await vi.runAllTimersAsync();
    expect(messages.saveFailed).toHaveBeenCalledTimes(2);
  });

  it("tries again after a failed save, even without a new change", async () => {
    const { dock, settings, values, storedNow } = await opened();
    vi.mocked(settings.save).mockRejectedValueOnce(new Error("quota"));
    await dock.userChanges(arranged("mine"));
    await vi.runAllTimersAsync();
    expect(values.has("layout")).toBe(false);
    await dock.userChanges(arranged("mine"));
    await vi.runAllTimersAsync();
    expect(storedNow()).toEqual(saved("edit", { edit: arranged("mine") }));
  });
});

describe("presets", () => {
  it("remember the arrangement of each", async () => {
    const { layout, dock } = await opened();
    await dock.userChanges(arranged("my edit"));
    layout.switchLayout("animate");
    expect(dock.state).toEqual(DESIGN_OF_ANIMATE);
    await dock.userChanges(arranged("my animate"));
    layout.switchLayout("edit");
    expect(dock.state).toEqual(arranged("my edit"));
    layout.switchLayout("animate");
    expect(dock.state).toEqual(arranged("my animate"));
  });

  it("reset only the current one", async () => {
    const { layout, dock } = await opened();
    await dock.userChanges(arranged("my edit"));
    layout.switchLayout("animate");
    await dock.userChanges(arranged("my animate"));
    layout.resetLayout();
    expect(dock.state).toEqual(DESIGN_OF_ANIMATE);
    layout.switchLayout("edit");
    expect(dock.state).toEqual(arranged("my edit"));
  });

  it("save which layout is open", async () => {
    const { layout, storedNow } = await opened();
    layout.switchLayout("animate");
    await vi.runAllTimersAsync();
    expect(storedNow()).toMatchObject({ current: "animate" });
  });

  it("know which panel is in use", async () => {
    const { layout, dock } = setup();
    await layout.load();
    expect(layout.getSnapshot().active).toBeUndefined();
    layout.attach(dock);
    expect(layout.getSnapshot().active).toBe("timeline");
  });

  it("ignore a layout that does not exist", async () => {
    const { layout } = await opened();
    layout.switchLayout("nope");
    expect(layout.getSnapshot().layout).toBe("edit");
  });

  it("cannot be renamed or deleted", async () => {
    const { layout, settings } = await opened();
    layout.rename("edit", "Mine");
    layout.remove("edit");
    expect(layout.getSnapshot().layouts.map((choice) => choice.id)).toEqual(["edit", "animate"]);
    expect(layout.isCustom("edit")).toBe(false);
    expect(settings.save).not.toHaveBeenCalled();
  });

  it("forget every arrangement when asked, and go back to the first", async () => {
    const memory = memoryWindow();
    const { layout, storedNow } = await opened(
      saved("animate", { edit: arranged("bad"), animate: arranged("bad too") }),
      memory,
    );
    const id = layout.saveAs("Mine") as string;
    await layout.forget();
    expect(storedNow()).toMatchObject({ current: "edit", states: {} });
    expect(storedNow().custom.map((custom) => custom.id)).toEqual([id]);
    expect(memory.read("layout")).toBe("edit");
  });
});

describe("people's own layouts", () => {
  const nameOf = (layout: LayoutController, index: number) =>
    layout
      .getSnapshot()
      .layouts.at(index)
      ?.title((() => "") as never);

  it("are saved from what is on screen, and become the current one", async () => {
    const { layout, dock, storedNow, memory } = await opened();
    await dock.userChanges(arranged("mine"));
    const id = layout.saveAs("  My   layout ") as string;
    expect(id).toMatch(/^custom-/);
    const { layouts, layout: current } = layout.getSnapshot();
    expect(current).toBe(id);
    expect(layouts.map((choice) => [choice.id, choice.custom])).toEqual([
      ["edit", false],
      ["animate", false],
      [id, true],
    ]);
    expect(nameOf(layout, -1)).toBe("My layout");
    expect(memory.read("layout")).toBe(id);
    await vi.runAllTimersAsync();
    expect(storedNow()).toMatchObject({
      current: id,
      custom: [{ id, name: "My layout", base: "edit", design: { dock: arranged("mine") } }],
    });
    expect(storedNow().states[id]?.dock).toEqual(arranged("mine"));
    expect(storedNow().states["edit"]?.dock).toEqual(arranged("mine"));
  });

  it("need a name", async () => {
    const { layout } = await opened();
    expect(layout.saveAs("   ")).toBeUndefined();
    expect(layout.getSnapshot().layouts).toHaveLength(2);
  });

  it("remember changes, and go back to how they were saved", async () => {
    const { layout, dock } = await opened();
    await dock.userChanges(arranged("saved"));
    const id = layout.saveAs("Mine") as string;
    await dock.userChanges(arranged("changed"));
    layout.switchLayout("animate");
    layout.switchLayout(id);
    expect(dock.state).toEqual(arranged("changed"));
    layout.resetLayout();
    expect(dock.state).toEqual(arranged("saved"));
  });

  it("can be renamed", async () => {
    const { layout, storedNow } = await opened();
    const id = layout.saveAs("Mine") as string;
    layout.rename(id, "Yours");
    expect(nameOf(layout, -1)).toBe("Yours");
    await vi.runAllTimersAsync();
    expect(storedNow().custom[0]?.name).toBe("Yours");
    layout.rename(id, " ");
    expect(nameOf(layout, -1)).toBe("Yours");
  });

  it("can be deleted, and then the window goes to the first preset", async () => {
    const { layout, dock, storedNow } = await opened();
    layout.switchLayout("animate");
    await dock.userChanges(arranged("mine"));
    const id = layout.saveAs("Mine") as string;
    layout.remove(id);
    expect(layout.getSnapshot().layout).toBe("edit");
    expect(layout.getSnapshot().layouts).toHaveLength(2);
    expect(dock.state).toEqual(DESIGN_OF_EDIT);
    await vi.runAllTimersAsync();
    expect(storedNow().custom).toEqual([]);
    expect(storedNow().states[id]).toBeUndefined();
    expect(storedNow().current).toBe("edit");
  });

  it("can be deleted while another one is on screen", async () => {
    const { layout, dock } = await opened();
    const first = layout.saveAs("First") as string;
    const second = layout.saveAs("Second") as string;
    await dock.userChanges(arranged("second"));
    layout.remove(first);
    expect(layout.getSnapshot().layout).toBe(second);
    expect(dock.state).toEqual(arranged("second"));
  });

  it("fall back to how they were saved when their changes are unusable", async () => {
    const { layout, dock, messages } = await opened();
    await dock.userChanges(arranged("saved"));
    const id = layout.saveAs("Mine") as string;
    await dock.userChanges(arranged("broken"));
    layout.switchLayout("edit");
    dock.rejects.add("broken");
    layout.switchLayout(id);
    expect(dock.state).toEqual(arranged("saved"));
    expect(messages.restoreFailed).toHaveBeenCalledOnce();
  });
});

describe("several windows", () => {
  it("start a new window in the layout chosen last", async () => {
    const { layout } = await opened(saved("animate", {}));
    expect(layout.getSnapshot().layout).toBe("animate");
  });

  it("stay in their own layout through a reload, whatever was chosen elsewhere", async () => {
    const memory = memoryWindow();
    memory.write("layout", "edit");
    const { layout, dock } = setup(saved("animate", {}), memory);
    await layout.load();
    expect(layout.getSnapshot().layout).toBe("edit");
    layout.attach(dock);
    expect(layout.getSnapshot().layout).toBe("edit");
    expect(dock.state).toEqual(DESIGN_OF_EDIT);
  });

  it("remember the layout they started in, not only one they switched to", async () => {
    const { memory } = await opened();
    expect(memory.read("layout")).toBe("edit");
  });

  it("remember the layout they switched to", async () => {
    const { layout, memory } = await opened();
    layout.switchLayout("animate");
    expect(memory.read("layout")).toBe("animate");
  });

  it("do not choose before they show something", async () => {
    const { layout, dock, memory, saveInOtherWindow } = setup();
    await layout.load();
    expect(memory.read("layout")).toBeUndefined();
    saveInOtherWindow(saved("animate", {}));
    layout.attach(dock);
    expect(layout.getSnapshot().layout).toBe("animate");
  });

  it("use the layout chosen last when their own no longer exists", async () => {
    const memory = memoryWindow();
    memory.write("layout", "removed");
    const { layout, messages } = await opened(saved("animate", {}), memory);
    expect(layout.getSnapshot().layout).toBe("animate");
    expect(messages.restoreFailed).not.toHaveBeenCalled();
  });

  it("keep their layout when saved data is broken", async () => {
    const memory = memoryWindow();
    memory.write("layout", "animate");
    const { layout, messages } = await opened("garbage", memory);
    expect(layout.getSnapshot().layout).toBe("animate");
    expect(messages.restoreFailed).toHaveBeenCalledOnce();
  });

  it("stay where they are when another window switches", async () => {
    const { layout, dock, saveInOtherWindow } = await opened();
    saveInOtherWindow(saved("animate", {}));
    expect(layout.getSnapshot().layout).toBe("edit");
    expect(dock.state).toEqual(DESIGN_OF_EDIT);
  });

  it("do not bring back an old arrangement when saving", async () => {
    const { dock, storedNow, saveInOtherWindow } = await opened(
      saved("edit", { animate: arranged("old") }),
    );
    saveInOtherWindow(saved("animate", { animate: arranged("theirs") }));
    await dock.userChanges(arranged("mine"));
    await vi.runAllTimersAsync();
    expect(storedNow()).toEqual(
      saved("animate", { animate: arranged("theirs"), edit: arranged("mine") }),
    );
  });

  it("show what another window arranged when switching to it", async () => {
    const { layout, dock, saveInOtherWindow } = await opened();
    saveInOtherWindow(saved("animate", { animate: arranged("theirs") }));
    layout.switchLayout("animate");
    expect(dock.state).toEqual(arranged("theirs"));
  });

  it("do not lose the arrangement they just left to news from another window", async () => {
    const { layout, dock, storedNow, saveInOtherWindow } = await opened();
    await dock.userChanges(arranged("my edit"));
    layout.switchLayout("animate");
    await Promise.resolve();
    const other = structuredClone(storedNow());
    other.states["animate"] = { dock: arranged("theirs"), panels: READY };
    saveInOtherWindow(other);
    layout.switchLayout("edit");
    expect(dock.state).toEqual(arranged("my edit"));
  });

  it("do not write what another window just wrote", async () => {
    const { dock, settings, saveInOtherWindow } = await opened();
    saveInOtherWindow(saved("animate", { edit: DESIGN_OF_EDIT }));
    await dock.userChanges(DESIGN_OF_EDIT);
    await vi.runAllTimersAsync();
    expect(settings.save).not.toHaveBeenCalled();
  });

  it("ignore what they cannot read", async () => {
    const { layout, dock, saveInOtherWindow } = await opened(
      saved("edit", { animate: arranged("mine") }),
    );
    saveInOtherWindow({ version: 99 });
    layout.switchLayout("animate");
    expect(dock.state).toEqual(arranged("mine"));
  });

  it("get the layouts another window saved, renamed or deleted", async () => {
    const one = await opened();
    const two = await opened();
    // The two share one store in a browser.
    const share = () => two.saveInOtherWindow(structuredClone(one.storedNow()));
    const id = one.layout.saveAs("Mine") as string;
    await vi.runAllTimersAsync();
    share();
    expect(two.layout.getSnapshot().layouts.map((choice) => choice.id)).toContain(id);

    two.layout.switchLayout(id);
    one.layout.rename(id, "Renamed");
    await vi.runAllTimersAsync();
    share();
    expect(
      two.layout
        .getSnapshot()
        .layouts.at(-1)
        ?.title((() => "") as never),
    ).toBe("Renamed");
    expect(two.layout.getSnapshot().layout).toBe(id);

    one.layout.remove(id);
    await vi.runAllTimersAsync();
    share();
    expect(two.layout.getSnapshot().layout).toBe("edit");
    expect(two.dock.state).toEqual(DESIGN_OF_EDIT);
    // Its arrangement does not come back from the window that showed it.
    await two.dock.userChanges(arranged("still there"));
    await vi.runAllTimersAsync();
    const written = vi.mocked(two.settings.save).mock.calls.at(-1)?.[1] as Saved;
    expect(written.states[id]).toBeUndefined();
    expect(written.custom).toEqual([]);
  });
});
