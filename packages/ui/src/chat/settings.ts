import {
  DEFAULT_CONTEXT_WINDOW,
  EMPTY_AI_SETTINGS,
  TOOL_CALL_LIMITS,
  enabledCountOf,
  failureOf,
  kindOf,
  knownModels,
  listModels,
  readAiSettings,
  recommendedOf,
  settledDefault,
  testModel,
  writeAiSettings,
  type AiSettings,
  type CustomModel,
  type Endpoint,
  type ListedModel,
  type ModelRef,
  type ReasoningLevel,
  type Relayed,
  type Route,
  type ServiceConfig,
  type ServiceFailure,
  type ServiceKind,
} from "@animaquill/agent";
import { memoryKeys, type AiRelay, type KeyStore, type SettingsStore } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

const SETTINGS_KEY = "ai";
/** How many characters of a key the settings show, for people to tell keys apart. */
const HINT_LENGTH = 4;

/** What a service said about its models, when people asked. */
export type ModelListing =
  | { readonly state: "loading" }
  | { readonly state: "ok"; readonly models: readonly ListedModel[] }
  | { readonly state: "failed"; readonly failure: ServiceFailure }
  /** Not asked: the way to the service is not there, see `ServiceRoute`. */
  | { readonly state: "held"; readonly hold: "relayMissing" | "relayUrl" };

/**
 * What a test of a service or of one of its models came to, see `AiSettingsStore.test`: a word from
 * the model (or, with no model to ask, its list of models), how long it took.
 */
export type ConnectionTest =
  | { readonly state: "running" }
  | {
      readonly state: "ok";
      readonly ms: number;
      /** What the model said; nothing where the list of models was asked instead. */
      readonly text?: string;
      /** How many models the service listed, where that was the test. */
      readonly models?: number;
    }
  | { readonly state: "failed"; readonly failure: ServiceFailure; readonly ms?: number }
  /** Not tried: there is no way to the service, or nothing to ask. */
  | { readonly state: "held"; readonly hold: "relayMissing" | "relayUrl" | "badUrl" };

/** Settings this editor cannot take as they are, which it leaves alone, see `readAiSettings`. */
export type SettingsHeld = "newer" | "broken";

export interface AiSettingsSnapshot extends AiSettings {
  /** The services that have a key in this browser. */
  readonly keyed: ReadonlySet<string>;
  /** The last characters of each key, by service, for people to tell which one it is. */
  readonly hints: ReadonlyMap<string, string>;
  /** What services said about their models, by service. Only for this page. */
  readonly listings: ReadonlyMap<string, ModelListing>;
  /** The models pi knows of, by kind of service, once somebody looked. */
  readonly known: ReadonlyMap<string, readonly ListedModel[]>;
  /** Where keys are, for people: the name of the database, or nothing where they are not kept. */
  readonly keysWhere: string | undefined;
  /** The settings saved could not be taken, and are left as they are: nothing changes them. */
  readonly held: SettingsHeld | undefined;
  /** Tests of services (by id) and of models (by `testKey`), on this page. */
  readonly tests: ReadonlyMap<string, ConnectionTest>;
}

export interface AiSettingsMessages {
  saveFailed(): void;
  keyFailed(): void;
}

/**
 * Where requests to a service go: straight to its address, or to the relay's for it. A string says
 * why they cannot go through the relay: there is none here, or it does not take the address.
 */
export type ServiceRoute =
  { readonly baseUrl: string; readonly relay?: Relayed } | "relayMissing" | "relayUrl";

/** A service as people fill it in before it is added. */
export interface ServiceDraft {
  readonly kind: string;
  readonly baseUrl: string;
  readonly route: Route;
}

/** A model of a service, as the settings list it: what is known of it, and whether it is on. */
export interface ServiceModel extends ListedModel {
  readonly enabled: boolean;
  /** The service listed it and pi does not know it: something new. */
  readonly fresh: boolean;
  /** People named it themselves. */
  readonly custom: boolean;
}

/** Where the test of one model of a service is kept, see `AiSettingsSnapshot.tests`. */
export const testKey = (service: string, model: string) => `${service}\n${model}`;

const newServiceId = () =>
  `service-${[...crypto.getRandomValues(new Uint32Array(2))].map((n) => n.toString(36)).join("")}`;

const byName = (a: ListedModel, b: ListedModel) =>
  (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { numeric: true, sensitivity: "base" });

/** The cheapest of some models, by what their input costs; the first where nothing is known. */
function cheapestOf(models: readonly ListedModel[]): ListedModel | undefined {
  return models.toSorted((a, b) => (a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity))[0];
}

/**
 * The AI services people set up, shared by all windows like every setting, and their keys, which
 * are kept apart in `KeyStore`: never in settings, a project or a report. Keys that this page has
 * read stay known here only so that reports can leave them out.
 *
 * Settings that cannot be taken (written by a newer editor, or not settings at all) are `held`:
 * shown as such, and never written over unless people start again (`reset`).
 */
export class AiSettingsStore {
  readonly #settings: SettingsStore;
  readonly #keys: KeyStore;
  readonly #messages: AiSettingsMessages;
  readonly #relay: AiRelay | undefined;
  readonly #emitter = new Emitter();
  #snapshot: AiSettingsSnapshot;
  /** What this page knows of keys, by service, so that reports can leave them out. */
  readonly #known = new Map<string, string>();
  #knownSet: ReadonlySet<string> = new Set();
  /** The kinds whose models pi knows are being loaded, once each. */
  readonly #loading = new Map<string, Promise<readonly ListedModel[]>>();

  constructor(
    settings: SettingsStore,
    keys: KeyStore | undefined,
    messages: AiSettingsMessages,
    /** The relay of the platform, where the editor is hosted on one. */
    relay?: AiRelay,
  ) {
    this.#settings = settings;
    this.#keys = keys ?? memoryKeys();
    this.#messages = messages;
    this.#relay = relay;
    this.#snapshot = {
      ...EMPTY_AI_SETTINGS,
      keyed: new Set(),
      hints: new Map(),
      listings: new Map(),
      known: new Map(),
      keysWhere: this.#keys.where,
      held: undefined,
      tests: new Map(),
    };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): AiSettingsSnapshot => this.#snapshot;

  async load(): Promise<void> {
    let value: unknown;
    try {
      value = await this.#settings.load(SETTINGS_KEY);
    } catch (error) {
      // Unreadable is not empty: what is there may be fine another time, and is not written over.
      console.warn(`Setting ${SETTINGS_KEY} is unreadable`, error);
      this.#hold("broken");
    }
    if (value !== undefined) this.#take(value);
    this.#settings.listen(SETTINGS_KEY, (changed) => {
      if (changed !== undefined) this.#take(changed);
      void this.#refreshKeyed();
    });
    await this.#refreshKeyed();
  }

  /** Takes settings as saved, or holds them where they cannot be taken. */
  #take(value: unknown): void {
    const reading = readAiSettings(value);
    if (reading.kind !== "ok") {
      console.warn(`Setting ${SETTINGS_KEY} is ${reading.kind}: left as it is`);
      this.#hold(reading.kind);
      return;
    }
    this.#adopt(reading.settings, undefined);
  }

  #hold(held: SettingsHeld): void {
    this.#snapshot = { ...this.#snapshot, held };
    this.#emitter.emit();
  }

  /** Keys this page read, for whatever must not show them. */
  get knownKeys(): ReadonlySet<string> {
    return this.#knownSet;
  }

  /** Whether services can be reached through the relay of a platform here. */
  get canRelay(): boolean {
    return this.#relay !== undefined;
  }

  /** Where requests to a service go, see `ServiceRoute`. */
  routeOf(service: Pick<ServiceConfig, "baseUrl" | "route">): ServiceRoute {
    if (service.route !== "relay") return { baseUrl: service.baseUrl };
    if (!this.#relay) return "relayMissing";
    const relayed = this.#relay.addressOf(service.baseUrl);
    if (relayed === undefined) return "relayUrl";
    return { baseUrl: service.baseUrl, relay: { baseUrl: relayed, headers: this.#relay.headers } };
  }

  /** How the chat reaches a model of a service, or why it cannot. */
  endpointOf(
    service: Pick<ServiceConfig, "kind" | "baseUrl" | "route">,
    model: string,
  ): Endpoint | "badUrl" | "relayMissing" | "relayUrl" | undefined {
    const kind = kindOf(service.kind);
    if (!kind) return undefined;
    if (!service.baseUrl) return "badUrl";
    const route = this.routeOf(service);
    if (typeof route === "string") return route;
    return {
      service: service.kind,
      protocol: kind.protocol,
      baseUrl: route.baseUrl,
      model,
      catalog: kind.catalog,
      ...(route.relay && { relay: route.relay }),
    };
  }

  serviceOf(id: string | undefined): ServiceConfig | undefined {
    return this.#snapshot.services.find((service) => service.id === id);
  }

  /** The model a new conversation uses, and its service. */
  defaultModel(): { readonly service: ServiceConfig; readonly model: string } | undefined {
    const ref = this.#snapshot.default;
    const service = this.serviceOf(ref?.service);
    return service && ref ? { service, model: ref.model } : undefined;
  }

  #adopt(settings: AiSettings, held: SettingsHeld | undefined): void {
    // What the settings leave out is off: a field that went away takes its value with it.
    const {
      showHiddenPacks: _shown,
      packFor: _chosen,
      reasoningFor: _reasoning,
      kept: _kept,
      ...before
    } = this.#snapshot;
    this.#snapshot = { ...before, ...settings, held };
    this.#emitter.emit();
  }

  async #refreshKeyed(): Promise<void> {
    try {
      const ids = await this.#keys.list();
      const hints = new Map<string, string>();
      for (const id of ids) {
        const key = await this.#keys.read(id);
        this.#know(id, key);
        if (key) hints.set(id, key.slice(-HINT_LENGTH));
      }
      this.#snapshot = { ...this.#snapshot, keyed: new Set(ids), hints };
      this.#emitter.emit();
    } catch (error) {
      console.warn("Which services have a key could not be read", error);
    }
  }

  /** The settings as they are now, without what only this page has. */
  #settingsNow(): AiSettings {
    const {
      services,
      default: chosen,
      reasoningFor,
      packFor,
      showHiddenPacks,
      maxToolCalls,
      autoTitle,
      expandThinking,
      kept,
    } = this.#snapshot;
    return {
      services,
      default: chosen,
      ...(reasoningFor && { reasoningFor }),
      ...(packFor && { packFor }),
      ...(showHiddenPacks && { showHiddenPacks }),
      maxToolCalls,
      autoTitle,
      expandThinking,
      ...(kept && { kept }),
    };
  }

  /** Saves settings, with a default that is on. Held settings are not written over. */
  #save(changed: AiSettings): boolean {
    if (this.#snapshot.held) return false;
    const settings = { ...changed, default: settledDefault(changed.services, changed.default) };
    this.#adopt(settings, undefined);
    this.#settings.save(SETTINGS_KEY, writeAiSettings(settings)).catch((error) => {
      console.warn("The AI services could not be saved", error);
      this.#messages.saveFailed();
    });
    return true;
  }

  /**
   * Starts again from nothing, over settings that are held: what was there is gone. Keys stay, as
   * they are kept apart.
   */
  reset(): void {
    if (!this.#snapshot.held) return;
    this.#snapshot = { ...this.#snapshot, held: undefined };
    this.#save(EMPTY_AI_SETTINGS);
  }

  #changeService(id: string, change: (service: ServiceConfig) => ServiceConfig): void {
    const now = this.#settingsNow();
    this.#save({
      ...now,
      services: now.services.map((service) => (service.id === id ? change(service) : service)),
    });
  }

  /**
   * The model pack for some models, as people chose it; nothing goes back to the pack that is for
   * them. New conversations take it, see `ChatSession`.
   */
  choosePack(models: readonly string[], pack: string | undefined): void {
    const { packFor: before, ...now } = this.#settingsNow();
    const packFor: Record<string, string> = { ...before };
    for (const model of models) {
      if (pack === undefined) delete packFor[model];
      else packFor[model] = pack;
    }
    this.#save({ ...now, ...(Object.keys(packFor).length > 0 && { packFor }) });
  }

  /** What people chose for models, without a pack that is no longer there. */
  forgetPack(pack: string): void {
    const models = Object.entries(this.#snapshot.packFor ?? {})
      .filter(([, id]) => id === pack)
      .map(([model]) => model);
    if (models.length > 0) this.choosePack(models, undefined);
  }

  /**
   * A new service of a kind, with what that kind has by default unless people said otherwise, and
   * the models turned on that it starts with. Returns its id.
   */
  add(
    kind: string,
    name: string,
    options: {
      readonly baseUrl?: string;
      readonly route?: Route;
      readonly enabled?: readonly string[];
    } = {},
  ): string | undefined {
    const found = kindOf(kind);
    if (!found || this.#snapshot.held) return undefined;
    const id = newServiceId();
    const service: ServiceConfig = {
      id,
      kind,
      name,
      baseUrl: options.baseUrl ?? found.baseUrl,
      // Where there is no relay, straight is all there is.
      route: this.#relay ? (options.route ?? found.route) : "direct",
      enabled: [...new Set(options.enabled ?? [])],
    };
    const now = this.#settingsNow();
    this.#save({ ...now, services: [...now.services, service] });
    return id;
  }

  update(id: string, changes: Partial<Pick<ServiceConfig, "name" | "baseUrl" | "route">>): void {
    this.#changeService(id, (service) => ({ ...service, ...changes }));
  }

  /** Takes a service away, and its key with it. */
  async remove(id: string): Promise<void> {
    const now = this.#settingsNow();
    if (!this.#save({ ...now, services: now.services.filter((service) => service.id !== id) })) {
      return;
    }
    await this.removeKey(id);
  }

  /**
   * Turns a model of a service on or off. The last model that is on anywhere stays on: "last" says
   * that is why nothing changed. Off, the default goes to another model that is on.
   */
  setEnabled(id: string, model: string, on: boolean): "last" | undefined {
    const service = this.serviceOf(id);
    if (!service || service.enabled.includes(model) === on) return undefined;
    if (!on && enabledCountOf(this.#snapshot) <= 1) return "last";
    this.#changeService(id, (each) => ({
      ...each,
      enabled: on ? [...each.enabled, model] : each.enabled.filter((name) => name !== model),
    }));
    return undefined;
  }

  /** Turns some models of a service on or off at once, keeping one on anywhere, see `setEnabled`. */
  setAllEnabled(id: string, models: readonly string[], on: boolean): "last" | undefined {
    const service = this.serviceOf(id);
    if (!service) return undefined;
    const off = new Set(on ? [] : models);
    const enabled = on
      ? [...new Set([...service.enabled, ...models])]
      : service.enabled.filter((name) => !off.has(name));
    const left = enabledCountOf(this.#snapshot) - (service.enabled.length - enabled.length);
    if (left < 1) return "last";
    this.#changeService(id, (each) => ({ ...each, enabled }));
    return undefined;
  }

  /** The model new conversations use. It is turned on if it was not. */
  setDefault(ref: ModelRef): void {
    const service = this.serviceOf(ref.service);
    if (!service) return;
    const now = this.#settingsNow();
    this.#save({
      ...now,
      services: now.services.map((each) =>
        each.id === ref.service && !each.enabled.includes(ref.model)
          ? { ...each, enabled: [...each.enabled, ref.model] }
          : each,
      ),
      default: ref,
    });
  }

  /**
   * A model people name themselves, which neither pi nor the service told of, turned on. Its size
   * is 128k tokens unless they say.
   */
  addModel(id: string, model: CustomModel): void {
    const name = model.id.trim();
    if (!name) return;
    this.#changeService(id, (service) => ({
      ...service,
      enabled: service.enabled.includes(name) ? service.enabled : [...service.enabled, name],
      models: [
        ...(service.models ?? []).filter((each) => each.id !== name),
        {
          id: name,
          ...(model.contextWindow !== undefined &&
            model.contextWindow !== DEFAULT_CONTEXT_WINDOW && {
              contextWindow: model.contextWindow,
            }),
        },
      ],
    }));
  }

  /** Forgets a model people named themselves. One that is on stays on, if it is the last one. */
  removeModel(id: string, model: string): void {
    const service = this.serviceOf(id);
    if (!service) return;
    if (service.enabled.includes(model) && this.setEnabled(id, model, false) === "last") return;
    this.#changeService(id, (each) => {
      const models = (each.models ?? []).filter((custom) => custom.id !== model);
      const { models: _was, ...rest } = each;
      return models.length > 0 ? { ...rest, models } : rest;
    });
  }

  /** How hard a model reasons by default; nothing leaves it to its pack. */
  setReasoning(model: string, level: ReasoningLevel | undefined): void {
    const { reasoningFor: before, ...now } = this.#settingsNow();
    const reasoningFor: Record<string, ReasoningLevel> = { ...before };
    if (level === undefined) delete reasoningFor[model];
    else reasoningFor[model] = level;
    this.#save({ ...now, ...(Object.keys(reasoningFor).length > 0 && { reasoningFor }) });
  }

  setMaxToolCalls(value: number): void {
    if (!Number.isInteger(value)) return;
    const limited = Math.min(TOOL_CALL_LIMITS.max, Math.max(TOOL_CALL_LIMITS.min, value));
    this.#save({ ...this.#settingsNow(), maxToolCalls: limited });
  }

  /** Whether the settings list the model packs that are hidden, see `AiSettings`. */
  setShowHiddenPacks(on: boolean): void {
    const { showHiddenPacks: _was, ...now } = this.#settingsNow();
    this.#save({ ...now, ...(on && { showHiddenPacks: true }) });
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
    this.#forgetTests(id);
    try {
      await this.#keys.write(id, trimmed);
    } catch (error) {
      console.warn("A key could not be kept", error);
      this.#messages.keyFailed();
    }
    await this.#refreshKeyed();
  }

  async removeKey(id: string): Promise<void> {
    this.#forgetTests(id);
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

  /** Asks the service which models it has, with its key, the way the chat reaches it. */
  async fetchModels(id: string): Promise<void> {
    const service = this.serviceOf(id);
    const kind = service && kindOf(service.kind);
    if (!service || !kind) return;
    const route = this.routeOf(service);
    if (typeof route === "string") {
      this.#setListing(id, { state: "held", hold: route });
      return;
    }
    this.#setListing(id, { state: "loading" });
    const key = (await this.keyOf(id)) ?? "";
    const listed = await listModels(kind.protocol, route.relay?.baseUrl ?? route.baseUrl, key, {
      ...(route.relay && { headers: route.relay.headers }),
    });
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
  loadKnown(kindId: string): Promise<readonly ListedModel[]> {
    const kind = kindOf(kindId);
    if (!kind?.catalog) return Promise.resolve([]);
    const loading = this.#loading.get(kindId);
    if (loading) return loading;
    const load = knownModels(kind.catalog, kind.protocol).then(
      (models) => {
        const known = new Map(this.#snapshot.known).set(kindId, models);
        this.#snapshot = { ...this.#snapshot, known };
        this.#emitter.emit();
        return models;
      },
      (error: unknown) => {
        console.warn("The models pi knows of could not be loaded", error);
        this.#loading.delete(kindId);
        return [];
      },
    );
    this.#loading.set(kindId, load);
    return load;
  }

  /**
   * The models of a service, for people to turn on: what pi knows of its kind, what it said when
   * asked, what people named, and whatever is on besides. Each once, by name.
   */
  modelsFor(id: string): readonly ServiceModel[] {
    const service = this.serviceOf(id);
    if (!service) return [];
    const catalog = this.#snapshot.known.get(service.kind) ?? [];
    const listing = this.#snapshot.listings.get(id);
    const listed = listing?.state === "ok" ? listing.models : [];
    const inCatalog = new Set(catalog.map((model) => model.id));
    const rows = new Map<string, ServiceModel>();
    const enabled = new Set(service.enabled);
    const put = (model: ListedModel, fresh: boolean, custom: boolean) => {
      const before = rows.get(model.id);
      rows.set(model.id, {
        ...model,
        ...before,
        // What pi knows comes first; the service fills what it does not.
        ...(before?.contextWindow === undefined &&
          model.contextWindow !== undefined && { contextWindow: model.contextWindow }),
        enabled: enabled.has(model.id),
        fresh: before?.fresh ?? fresh,
        custom: before?.custom === true || custom,
      });
    };
    for (const model of catalog) put(model, false, false);
    const kind = kindOf(service.kind);
    for (const model of listed)
      put(model, kind?.catalog !== undefined && !inCatalog.has(model.id), false);
    for (const model of service.models ?? []) {
      put(
        { id: model.id, contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
        false,
        true,
      );
    }
    for (const model of service.enabled) if (!rows.has(model)) put({ id: model }, false, false);
    return [...rows.values()].toSorted(byName);
  }

  /** What is known of a model of a service, see `modelsFor`. */
  modelOf(id: string, model: string): ServiceModel | undefined {
    return this.modelsFor(id).find((each) => each.id === model);
  }

  /**
   * Which models a new service of a kind starts with, see `recommendedOf`: from what pi knows of
   * the kind, or else from what the service lists.
   */
  async recommendedFor(kindId: string, listed: readonly ListedModel[] = []): Promise<string[]> {
    const kind = kindOf(kindId);
    if (!kind) return [];
    const catalog = await this.loadKnown(kindId);
    return recommendedOf(kind, catalog.length > 0 ? catalog : listed);
  }

  /**
   * Tests a service before it is added: a word from the cheapest of the models it would start with,
   * or its list of models where pi knows none of its models. Says which models it would start with.
   */
  async tryService(
    draft: ServiceDraft,
    key: string,
  ): Promise<{
    readonly test: ConnectionTest;
    readonly recommended: readonly string[];
    /** What the service listed, where that was the test. */
    readonly listed?: readonly ListedModel[];
  }> {
    const kind = kindOf(draft.kind);
    if (!kind) return { test: { state: "held", hold: "badUrl" }, recommended: [] };
    const catalog = await this.loadKnown(draft.kind);
    const recommended = recommendedOf(kind, catalog);
    const ids = new Set(recommended);
    const model = cheapestOf(catalog.filter((each) => ids.has(each.id)))?.id;
    if (model !== undefined) return { test: await this.#test(draft, key, model), recommended };
    const listed = await this.#list(draft, kind, key);
    return {
      test: listed.test,
      recommended: listed.models ? recommendedOf(kind, listed.models) : [],
      ...(listed.models && { listed: listed.models }),
    };
  }

  /**
   * Tests a service that is set up, or one model of it: a word from the model asked, else from the
   * first model that is on, else the cheapest pi knows; with none of those, its list of models.
   * What it came to stays in `tests` for this page.
   */
  async test(id: string, model?: string): Promise<ConnectionTest> {
    const service = this.serviceOf(id);
    const kind = service && kindOf(service.kind);
    if (!service || !kind) return { state: "held", hold: "badUrl" };
    const where = model === undefined ? id : testKey(id, model);
    this.#setTest(where, { state: "running" });
    const key = (await this.keyOf(id)) ?? "";
    const asked = model ?? service.enabled[0] ?? cheapestOf(await this.loadKnown(service.kind))?.id;
    const test =
      asked !== undefined
        ? await this.#test(service, key, asked)
        : (await this.#list(service, kind, key)).test;
    this.#setTest(where, test);
    return test;
  }

  /** Keeps what a test came to, and what the service listed, for a service added after it was tried. */
  keepTest(id: string, test: ConnectionTest, listed?: readonly ListedModel[]): void {
    if (listed) this.#setListing(id, { state: "ok", models: listed });
    this.#setTest(id, test);
  }

  async #test(draft: ServiceDraft, key: string, model: string): Promise<ConnectionTest> {
    const endpoint = this.endpointOf(draft, model);
    if (endpoint === undefined) return { state: "held", hold: "badUrl" };
    if (typeof endpoint === "string") return { state: "held", hold: endpoint };
    const tested = await testModel(endpoint, key);
    if (tested.ok) return { state: "ok", ms: tested.ms, text: tested.text };
    return { state: "failed", ms: tested.ms, failure: failureOf(tested.error, [key]) };
  }

  async #list(
    draft: ServiceDraft,
    kind: ServiceKind,
    key: string,
  ): Promise<{ readonly test: ConnectionTest; readonly models?: readonly ListedModel[] }> {
    if (!draft.baseUrl) return { test: { state: "held", hold: "badUrl" } };
    const route = this.routeOf(draft);
    if (typeof route === "string") return { test: { state: "held", hold: route } };
    const started = Date.now();
    const listed = await listModels(kind.protocol, route.relay?.baseUrl ?? route.baseUrl, key, {
      ...(route.relay && { headers: route.relay.headers }),
    });
    const ms = Date.now() - started;
    if (!listed.ok) return { test: { state: "failed", ms, failure: listed.failure } };
    return { test: { state: "ok", ms, models: listed.models.length }, models: listed.models };
  }

  /** What tests of a service came to no longer counts once its key changed. */
  #forgetTests(id: string): void {
    const tests = new Map(this.#snapshot.tests);
    for (const where of tests.keys()) {
      if (where === id || where.startsWith(testKey(id, ""))) tests.delete(where);
    }
    if (tests.size === this.#snapshot.tests.size) return;
    this.#snapshot = { ...this.#snapshot, tests };
    this.#emitter.emit();
  }

  #setTest(where: string, test: ConnectionTest): void {
    const tests = new Map(this.#snapshot.tests).set(where, test);
    this.#snapshot = { ...this.#snapshot, tests };
    this.#emitter.emit();
  }

  #know(id: string, key: string | undefined): void {
    if (key === undefined || this.#known.get(id) === key) return;
    this.#known.set(id, key);
    // Old keys stay known: a report could still be about something from before.
    this.#knownSet = new Set([...this.#knownSet, key]);
  }
}
