import {
  EMPTY_AI_SETTINGS,
  TOOL_CALL_LIMITS,
  kindOf,
  knownModels,
  listModels,
  readAiSettings,
  type AiSettings,
  type ListedModel,
  type ServiceConfig,
  type ServiceFailure,
} from "@animaquill/agent";
import { memoryKeys, type KeyStore, type SettingsStore } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { readSetting } from "../workbench/settings.ts";

const SETTINGS_KEY = "ai";

/** What a service said about its models, when people asked. */
export type ModelListing =
  | { readonly state: "loading" }
  | { readonly state: "ok"; readonly models: readonly ListedModel[] }
  | { readonly state: "failed"; readonly failure: ServiceFailure };

export interface AiSettingsSnapshot extends AiSettings {
  /** The services that have a key in this browser. */
  readonly keyed: ReadonlySet<string>;
  /** What services said about their models, by service. Only for this page. */
  readonly listings: ReadonlyMap<string, ModelListing>;
  /** The models pi knows of, by kind of service, once somebody looked. */
  readonly known: ReadonlyMap<string, readonly ListedModel[]>;
  /** Where keys are, for people: the name of the database, or nothing where they are not kept. */
  readonly keysWhere: string | undefined;
}

export interface AiSettingsMessages {
  saveFailed(): void;
  keyFailed(): void;
}

const newServiceId = () =>
  `service-${[...crypto.getRandomValues(new Uint32Array(2))].map((n) => n.toString(36)).join("")}`;

/**
 * The AI services people set up, shared by all windows like every setting, and their keys, which
 * are kept apart in `KeyStore`: never in settings, a project or a report. Keys that this page has
 * read stay known here only so that reports can leave them out.
 */
export class AiSettingsStore {
  readonly #settings: SettingsStore;
  readonly #keys: KeyStore;
  readonly #messages: AiSettingsMessages;
  readonly #emitter = new Emitter();
  #snapshot: AiSettingsSnapshot;
  /** What this page knows of keys, by service, so that reports can leave them out. */
  readonly #known = new Map<string, string>();
  #knownSet: ReadonlySet<string> = new Set();

  constructor(settings: SettingsStore, keys: KeyStore | undefined, messages: AiSettingsMessages) {
    this.#settings = settings;
    this.#keys = keys ?? memoryKeys();
    this.#messages = messages;
    this.#snapshot = {
      ...EMPTY_AI_SETTINGS,
      keyed: new Set(),
      listings: new Map(),
      known: new Map(),
      keysWhere: this.#keys.where,
    };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): AiSettingsSnapshot => this.#snapshot;

  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, readAiSettings);
    if (reading.kind === "ok") this.#adopt(reading.value);
    this.#settings.listen(SETTINGS_KEY, (value) => {
      const read = readAiSettings(value);
      if (read) this.#adopt(read);
      void this.#refreshKeyed();
    });
    await this.#refreshKeyed();
  }

  /** Keys this page read, for whatever must not show them. */
  get knownKeys(): ReadonlySet<string> {
    return this.#knownSet;
  }

  serviceOf(id: string | undefined): ServiceConfig | undefined {
    return this.#snapshot.services.find((service) => service.id === id);
  }

  get current(): ServiceConfig | undefined {
    return this.serviceOf(this.#snapshot.current);
  }

  #adopt(settings: AiSettings): void {
    this.#snapshot = { ...this.#snapshot, ...settings };
    this.#emitter.emit();
  }

  async #refreshKeyed(): Promise<void> {
    try {
      const keyed = new Set(await this.#keys.list());
      this.#snapshot = { ...this.#snapshot, keyed };
      this.#emitter.emit();
    } catch (error) {
      console.warn("Which services have a key could not be read", error);
    }
  }

  #save(settings: AiSettings): void {
    this.#adopt(settings);
    const { services, current, maxToolCalls } = settings;
    this.#settings.save(SETTINGS_KEY, { services, current, maxToolCalls }).catch((error) => {
      console.warn("The AI services could not be saved", error);
      this.#messages.saveFailed();
    });
  }

  #settingsNow(): AiSettings {
    const { services, current, maxToolCalls } = this.#snapshot;
    return { services, current, maxToolCalls };
  }

  /** A new service of a kind, with what that kind has by default. Returns its id. */
  add(kind: string, name: string): string | undefined {
    const found = kindOf(kind);
    if (!found) return undefined;
    const id = newServiceId();
    const service: ServiceConfig = {
      id,
      kind,
      name,
      baseUrl: found.baseUrl,
      model: "",
      route: found.route,
    };
    const now = this.#settingsNow();
    this.#save({ ...now, services: [...now.services, service], current: now.current ?? id });
    return id;
  }

  update(id: string, changes: Partial<Omit<ServiceConfig, "id" | "kind">>): void {
    const now = this.#settingsNow();
    const services = now.services.map((service) =>
      service.id === id ? { ...service, ...changes } : service,
    );
    this.#save({ ...now, services });
  }

  /** Takes a service away, and its key with it. */
  async remove(id: string): Promise<void> {
    const now = this.#settingsNow();
    const services = now.services.filter((service) => service.id !== id);
    const current = now.current === id ? services[0]?.id : now.current;
    this.#save({ ...now, services, current });
    await this.removeKey(id);
  }

  choose(id: string): void {
    if (!this.serviceOf(id)) return;
    this.#save({ ...this.#settingsNow(), current: id });
  }

  setMaxToolCalls(value: number): void {
    if (!Number.isInteger(value)) return;
    const limited = Math.min(TOOL_CALL_LIMITS.max, Math.max(TOOL_CALL_LIMITS.min, value));
    this.#save({ ...this.#settingsNow(), maxToolCalls: limited });
  }

  async keyOf(id: string): Promise<string | undefined> {
    try {
      const key = await this.#keys.read(id);
      this.#know(id, key);
      return key;
    } catch (error) {
      console.warn("A key could not be read", error);
      this.#messages.keyFailed();
      return undefined;
    }
  }

  async setKey(id: string, key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) return this.removeKey(id);
    this.#know(id, trimmed);
    try {
      await this.#keys.write(id, trimmed);
    } catch (error) {
      console.warn("A key could not be kept", error);
      this.#messages.keyFailed();
    }
    await this.#refreshKeyed();
  }

  async removeKey(id: string): Promise<void> {
    try {
      await this.#keys.remove(id);
    } catch (error) {
      console.warn("A key could not be taken away", error);
      this.#messages.keyFailed();
    }
    await this.#refreshKeyed();
  }

  /** Every key in this browser goes, also of services that are no longer set up. */
  async removeAllKeys(): Promise<void> {
    try {
      await this.#keys.clear();
    } catch (error) {
      console.warn("The keys could not be taken away", error);
      this.#messages.keyFailed();
    }
    await this.#refreshKeyed();
  }

  /** Asks the service which models it has, with its key. */
  async fetchModels(id: string): Promise<void> {
    const service = this.serviceOf(id);
    const kind = service && kindOf(service.kind);
    if (!service || !kind) return;
    this.#setListing(id, { state: "loading" });
    const key = (await this.keyOf(id)) ?? "";
    const listed = await listModels(kind.protocol, service.baseUrl, key);
    this.#setListing(
      id,
      listed.ok
        ? { state: "ok", models: listed.models }
        : { state: "failed", failure: listed.failure },
    );
  }

  #setListing(id: string, listing: ModelListing): void {
    const listings = new Map(this.#snapshot.listings).set(id, listing);
    this.#snapshot = { ...this.#snapshot, listings };
    this.#emitter.emit();
  }

  /** What pi knows of the models of a kind of service, for people to pick from. */
  async loadKnown(kindId: string): Promise<void> {
    const kind = kindOf(kindId);
    if (!kind || this.#snapshot.known.has(kindId)) return;
    try {
      const models = await knownModels(kind.catalog, kind.protocol);
      const known = new Map(this.#snapshot.known).set(kindId, models);
      this.#snapshot = { ...this.#snapshot, known };
      this.#emitter.emit();
    } catch (error) {
      console.warn("The models pi knows of could not be loaded", error);
    }
  }

  /** The models to pick from for a service: what it said, else what pi knows. */
  modelsFor(id: string): readonly ListedModel[] {
    const service = this.serviceOf(id);
    const listing = this.#snapshot.listings.get(id);
    if (listing?.state === "ok" && listing.models.length > 0) return listing.models;
    return (service && this.#snapshot.known.get(service.kind)) ?? [];
  }

  #know(id: string, key: string | undefined): void {
    if (key === undefined || this.#known.get(id) === key) return;
    this.#known.set(id, key);
    // Old keys stay known: a report could still be about something from before.
    this.#knownSet = new Set([...this.#knownSet, key]);
  }
}
