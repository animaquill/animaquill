import { describe, expect, it } from "vitest";
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
