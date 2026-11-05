import type { Host, SettingsStore } from "./index.ts";

const PREFIX = "animaquill.";

/** Keeps settings in this browser. Used until an account or a local project can hold them. */
export function createBrowserHost(storage: () => Storage = () => localStorage): Host {
  const settings: SettingsStore = {
    async load(key) {
      const text = storage().getItem(PREFIX + key);
      return text === null ? undefined : JSON.parse(text);
    },
    async save(key, value) {
      storage().setItem(PREFIX + key, JSON.stringify(value));
    },
  };
  return { settings };
}
