/** What the editor needs from the place it runs in: a browser, the desktop app or the platform. */
export interface Host {
  readonly settings: SettingsStore;
}

/**
 * Preferences of the person using the editor, such as the layout. Values must survive JSON.
 * Both methods reject when the store cannot do its job, and the caller decides what to tell people.
 */
export interface SettingsStore {
  /** Resolves to undefined when nothing has been saved under this key. */
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
}
