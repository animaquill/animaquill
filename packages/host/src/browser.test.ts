import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserHost } from "./browser.ts";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  } as Storage;
}

describe("browser settings", () => {
  it("reads back what it saved", async () => {
    const { settings } = createBrowserHost(() => memoryStorage());
    const shared = memoryStorage();
    const host = createBrowserHost(() => shared);
    await host.settings.save("layout", { a: 1 });
    expect(await host.settings.load("layout")).toEqual({ a: 1 });
    expect(await settings.load("layout")).toBeUndefined();
  });

  it("rejects when the stored text is not JSON", async () => {
    const storage = memoryStorage();
    storage.setItem("animaquill.layout", "{oops");
    await expect(createBrowserHost(() => storage).settings.load("layout")).rejects.toThrow();
  });

  it("rejects when the browser blocks storage", async () => {
    const host = createBrowserHost(() => {
      throw new DOMException("denied", "SecurityError");
    });
    await expect(host.settings.load("layout")).rejects.toThrow("denied");
    await expect(host.settings.save("layout", 1)).rejects.toThrow("denied");
  });
});

describe("settings saved in another window", () => {
  /** What the browser does in the other windows when one of them writes. */
  function listenWith() {
    const target = new EventTarget();
    vi.stubGlobal("addEventListener", target.addEventListener.bind(target));
    vi.stubGlobal("removeEventListener", target.removeEventListener.bind(target));
    return (key: string | null, newValue: string | null) => {
      target.dispatchEvent(Object.assign(new Event("storage"), { key, newValue }));
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports the new value of the key", () => {
    const write = listenWith();
    const { settings } = createBrowserHost(() => memoryStorage());
    const listener = vi.fn<(value: unknown) => void>();
    settings.listen("layout", listener);
    write("animaquill.layout", '{"a":1}');
    expect(listener).toHaveBeenCalledExactlyOnceWith({ a: 1 });
  });

  it.each([
    ["another key", "animaquill.other", "{}"],
    ["a key of another site part", "layout", "{}"],
    ["a removed value", "animaquill.layout", null],
    ["everything cleared", null, null],
  ])("stays quiet on %s", (_, key, value) => {
    const write = listenWith();
    const { settings } = createBrowserHost(() => memoryStorage());
    const listener = vi.fn<(value: unknown) => void>();
    settings.listen("layout", listener);
    write(key, value);
    expect(listener).not.toHaveBeenCalled();
  });

  it("survives a value it cannot read", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const write = listenWith();
    const { settings } = createBrowserHost(() => memoryStorage());
    const listener = vi.fn<(value: unknown) => void>();
    settings.listen("layout", listener);
    expect(() => write("animaquill.layout", "{oops")).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops when asked", () => {
    const write = listenWith();
    const { settings } = createBrowserHost(() => memoryStorage());
    const listener = vi.fn<(value: unknown) => void>();
    settings.listen("layout", listener)();
    write("animaquill.layout", "{}");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("window memory", () => {
  const hostWith = (storage: () => Storage) =>
    createBrowserHost(memoryStorage, () => indexedDB, storage);

  it("reads back what it wrote", () => {
    const shared = memoryStorage();
    const { windowMemory } = hostWith(() => shared);
    windowMemory.write("workspace", "edit");
    expect(windowMemory.read("workspace")).toBe("edit");
    expect(hostWith(() => shared).windowMemory.read("workspace")).toBe("edit");
  });

  it("knows nothing about a key it never wrote", () => {
    const shared = memoryStorage();
    expect(hostWith(() => shared).windowMemory.read("workspace")).toBeUndefined();
  });

  it("stays out of the way when the browser blocks it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { windowMemory } = hostWith(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(windowMemory.read("workspace")).toBeUndefined();
    expect(() => windowMemory.write("workspace", "edit")).not.toThrow();
    vi.restoreAllMocks();
  });
});
