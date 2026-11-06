import type { SettingsStore } from "@animaquill/host";
import type { TFunction } from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionRegistry, type Action } from "./actions.ts";
import { CommandPalette } from "./palette.ts";

const t = ((key: string) => key) as unknown as TFunction;

const action = (id: string, title: string, extra: Partial<Action> = {}): Action => ({
  id,
  title: () => title,
  run: vi.fn(),
  ...extra,
});

async function setup(stored?: unknown) {
  const values = new Map<string, unknown>();
  if (stored !== undefined) values.set("palette", stored);
  const settings: SettingsStore = {
    load: vi.fn(async (key: string) => values.get(key)),
    save: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
    listen: () => () => {},
  };
  const actions = new ActionRegistry();
  const items = [
    action("view.open.timeline", "打开选项卡：时间轴"),
    action("view.open.keyframes", "打开选项卡：关键帧"),
    action("view.workspace.animate", "切换工作区：动画"),
    action("view.commandPalette", "命令面板", { palette: false }),
  ];
  for (const item of items) actions.register(item);
  const palette = new CommandPalette(settings, actions);
  await palette.load();
  return { palette, actions, items, settings, values };
}

const ids = (palette: CommandPalette, query: string) =>
  palette.search(query, t).map((entry) => entry.action.id);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("searching", () => {
  it("lists everything without a query, except what makes no sense here", async () => {
    const { palette } = await setup();
    expect(ids(palette, "")).toEqual([
      "view.open.timeline",
      "view.open.keyframes",
      "view.workspace.animate",
    ]);
  });

  it("finds by title and says what to highlight", async () => {
    const { palette } = await setup();
    const [entry, ...rest] = palette.search("时间", t);
    expect(entry?.action.id).toBe("view.open.timeline");
    expect(entry?.positions).toEqual([6, 7]);
    expect(rest).toEqual([]);
  });

  it("also finds by the English name, without highlighting the title", async () => {
    const { palette } = await setup();
    const [entry] = palette.search("timeline", t);
    expect(entry?.action.id).toBe("view.open.timeline");
    expect(entry?.positions).toEqual([]);
  });

  it("leaves out what cannot run right now", async () => {
    const { palette, actions } = await setup();
    actions.register(action("edit.undo", "撤销", { enabled: () => false }));
    expect(ids(palette, "")).not.toContain("edit.undo");
    expect(ids(palette, "撤销")).toEqual([]);
  });

  it("finds nothing when nothing matches", async () => {
    const { palette } = await setup();
    expect(ids(palette, "音频")).toEqual([]);
  });
});

describe("recent commands", () => {
  it("puts what was used first, newest on top", async () => {
    const { palette, items } = await setup();
    palette.run(items[1] as Action);
    palette.run(items[2] as Action);
    expect(ids(palette, "").slice(0, 2)).toEqual(["view.workspace.animate", "view.open.keyframes"]);
    expect(palette.search("", t).map((entry) => entry.recent)).toEqual([true, true, false]);
  });

  it("does not list a command twice", async () => {
    const { palette, items } = await setup();
    palette.run(items[0] as Action);
    palette.run(items[0] as Action);
    expect(ids(palette, "")).toHaveLength(3);
  });

  it("uses recent commands to break ties in a search", async () => {
    const { palette, items } = await setup();
    palette.run(items[1] as Action);
    expect(ids(palette, "打开")[0]).toBe("view.open.keyframes");
  });

  it("remembers across visits", async () => {
    const first = await setup();
    first.palette.run(first.items[2] as Action);
    await vi.waitFor(() => expect(first.values.has("palette")).toBe(true));
    const second = await setup(first.values.get("palette"));
    expect(ids(second.palette, "")[0]).toBe("view.workspace.animate");
  });

  it("skips commands that no longer exist", async () => {
    const { palette } = await setup({ version: 1, recent: ["view.removed"] });
    expect(ids(palette, "")).toHaveLength(3);
  });

  it.each([["garbage"], [{ version: 2, recent: [] }], [{ version: 1 }]])(
    "starts fresh, without bothering anyone, when saved data is %j",
    async (stored) => {
      const { palette } = await setup(stored);
      expect(ids(palette, "")).toHaveLength(3);
    },
  );

  it("still runs the command when it cannot be remembered", async () => {
    const { palette, items, settings } = await setup();
    vi.mocked(settings.save).mockRejectedValue(new Error("quota"));
    palette.run(items[0] as Action);
    expect(items[0]?.run).toHaveBeenCalledOnce();
  });
});

describe("opening and closing", () => {
  it("toggles and closes", async () => {
    const { palette } = await setup();
    palette.toggle();
    expect(palette.isOpen()).toBe(true);
    palette.toggle();
    expect(palette.isOpen()).toBe(false);
    palette.toggle();
    palette.close();
    expect(palette.isOpen()).toBe(false);
  });

  it("closes before the command runs, so the command can take the focus", async () => {
    const { palette, actions } = await setup();
    let openDuringRun: boolean | undefined;
    const check = action("check", "检查", { run: () => (openDuringRun = palette.isOpen()) });
    actions.register(check);
    palette.toggle();
    palette.run(check);
    expect(openDuringRun).toBe(false);
  });
});
