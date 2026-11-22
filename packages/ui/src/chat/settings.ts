import {
  EMPTY_AI_SETTINGS,
  TOOL_CALL_LIMITS,
  canonical,
  catalogValues,
  editField,
  effectiveValues,
  enabledCountOf,
  failureOf,
  fillModel,
  kindOf,
  knownModels,
  listModels,
  liveOf,
  keyIntoHeader,
  readAiSettings,
  recommendedOf,
  recoverOldWrite,
  revertField,
  saysRed,
  secretsOf,
  settledDefault,
  supportedLevels,
  testModel,
  testModelPicture,
  undoFill,
  withSecrets,
  writeAiSettings,
  type AiSettings,
  type CatalogSay,
  type CatalogValues,
  type Endpoint,
  type ListedModel,
  type ModelApi,
  type ModelConfig,
  type ModelField,
  type ModelRef,
  type ModelValues,
  type AiSettingsReading,
  type Protocol,
  type ReasoningLevel,
  type Relayed,
  type Route,
  type ServiceConfig,
  type ServiceFailure,
  type ServiceKind,
  type ServiceSecret,
  type SendWith,
  type ShotSide,
} from "@animaquill/agent";
import {
  MODEL_CATALOG_MAX_AGE_MS,
  MODELS_DEV_URL,
  RELAY_PASS_PREFIX,
  flattenModelsDev,
  memoryKeys,
  readModelCatalog,
  recommendFromCatalog,
  relayPassHeaders,
  type AiRelay,
  type CatalogEntry,
  type KeyStore,
  type ModelCatalog,
  type SettingsStore,
  type WorkCache,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

const SETTINGS_KEY = "ai";
/**
 * The settings as version 2 wrote them last, apart from `ai`, where pages of version 1 (0.3.56 and
 * before) still write: what one of those writes is taken over on top of this, rather than taken for
 * all there is, see `recoverOldWrite`.
 */
const LATEST_KEY = "ai.latest";
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

/**
 * What the test of a picture came to, for a model people say takes pictures: it named the colour,
 * or it did not (`said`), or the request failed.
 */
export type PictureTest =
  | { readonly state: "ok" }
  | { readonly state: "wrong"; readonly said: string }
  | { readonly state: "failed"; readonly failure: ServiceFailure };

/** How far the open catalog of models (models.dev) is, on this page. */
export type CatalogState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | {
      readonly state: "ok";
      readonly fetchedAt: number;
      /** Where it came from now: this device's copy, models.dev, or the platform. */
      readonly from: "device" | "models.dev" | "platform";
      readonly count: number;
    }
  | { readonly state: "failed" };

/** Settings this editor cannot take as they are, which it leaves alone, see `readAiSettings`. */
/**
 * Settings this editor cannot take as they are, which it leaves alone, see `readAiSettings`; or
 * that cannot change now, as the backend that has them cannot be reached ("offline"), see
 * `AiSettingsStore.holdFor`.
 */
export type SettingsHeld = "newer" | "broken" | "offline";

export interface AiSettingsSnapshot extends AiSettings {
  /** The services that have a key in this browser. */
  readonly keyed: ReadonlySet<string>;
  /** How many services have anything secret kept in this browser, set up or not any more. */
  readonly secrets: number;
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
  /** People can start again over what is held, see `reset`: not where the backend holds them. */
  readonly resettable: boolean;
  /** Tests of services (by id) and of models (by `testKey`), on this page. */
  readonly tests: ReadonlyMap<string, ConnectionTest>;
  /** Tests of pictures of models, by `testKey`, on this page. */
  readonly pictureTests: ReadonlyMap<string, PictureTest>;
  /**
   * The services whose last test or request failed, with how: until a test or a request of
   * theirs goes through. In this window only.
   */
  readonly failing: ReadonlyMap<string, ServiceFailure>;
  /** The open catalog of models, as far as this page has it. */
  readonly catalog: CatalogState;
}

export interface AiSettingsMessages {
  saveFailed(): void;
  keyFailed(): void;
  /** Headers of before that cannot be sent were left out as the settings were read. */
  headersLeftOut?(): void;
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
  readonly api?: ModelApi;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * A model of a service, as the settings list it: what it is as used (what people set, a catalog
 * filled in, else what pi knows), and whether it is on.
 */
export interface ServiceModel extends ListedModel {
  readonly enabled: boolean;
  /** Everything of it as it is used, see `effectiveValues`. */
  readonly values: ModelValues;
  /** What people set or a catalog filled in, where there is anything. */
  readonly config?: ModelConfig;
  /** What pi knows of it, where pi's catalog has it. */
  readonly live?: ModelValues;
  /** pi's catalog has it: it can be turned off, not taken away. */
  readonly inCatalog: boolean;
  /** People named it themselves. */
  readonly custom: boolean;
  /** The steps of reasoning it takes. */
  readonly levels: readonly ReasoningLevel[];
}

/** Where people take what the catalogs say of a model from, see `AiSettingsStore.sayOf`. */
export interface CatalogOptions {
  /** This device's copy of the open catalog of models. */
  readonly cache?: WorkCache | undefined;
  /** The platform's copy, where the browser cannot read models.dev itself. */
  readonly platform?: (() => Promise<ModelCatalog>) | undefined;
  readonly fetch?: typeof fetch | undefined;
}

/** Where this device keeps its copy of the open catalog of models, see `WorkCache`. */
const CATALOG_CACHE_KEY = "ai.model-catalog";

/** Where the test of one model of a service is kept, see `AiSettingsSnapshot.tests`. */
export const testKey = (service: string, model: string) => `${service}\n${model}`;

const newServiceId = () =>
  `service-${[...crypto.getRandomValues(new Uint32Array(2))].map((n) => n.toString(36)).join("")}`;

const byName = (a: ListedModel, b: ListedModel) =>
  (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { numeric: true, sensitivity: "base" });

/** How a service is talked to: as people chose for a server of their own, else as its kind is. */
export const protocolOf = (service: Pick<ServiceConfig, "kind" | "api">): Protocol | undefined =>
  service.api ?? kindOf(service.kind)?.protocol;

/** The headers of a model together with those of its service, the model's winning. */
const headersOf = (
  service: Pick<ServiceConfig, "headers">,
  model: Pick<ModelValues, "headers"> | undefined,
): Readonly<Record<string, string>> | undefined => {
  const all = { ...service.headers, ...model?.headers };
  return Object.keys(all).length > 0 ? all : undefined;
};

/** The cheapest of some models, by what their input costs; the first where nothing is known. */
function cheapestOf(models: readonly ListedModel[]): ListedModel | undefined {
  return models.toSorted((a, b) => (a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity))[0];
}

/**
 * The AI services people set up, shared by all windows like every setting, and what is secret of
 * each, which is kept apart in `KeyStore` (`ServiceSecret`: the key, the address, the headers):
 * never in settings, a project or a report. The settings say when that changed (`secretAt`), so
 * that every window reads it again. Settings of before version 4 have the address and headers in
 * them: they go into what is secret as the settings are read, and the settings are saved again
 * without them (`#take`). Keys that this page has
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
  /** What is secret of each service, as this page last read or wrote it. */
  #secrets = new Map<string, ServiceSecret>();
  /** Writes of what is secret, one after the other, each before the settings that go with it. */
  #writing: Promise<unknown> = Promise.resolve();
  /** How many of those are not done yet: while none are, settings are saved at once. */
  #pending = 0;
  #knownSet: ReadonlySet<string> = new Set();
  /** Settings that other windows saved, taken one after the other. */
  #taking: Promise<void> = Promise.resolve();
  /** The kinds whose models pi knows are being loaded, once each. */
  readonly #loading = new Map<string, Promise<readonly ListedModel[]>>();
  readonly #catalogOptions: CatalogOptions | undefined;
  /** The open catalog of models, once this page has it. */
  #catalog: readonly CatalogEntry[] | undefined;
  #catalogLoading: Promise<readonly CatalogEntry[] | undefined> | undefined;

  constructor(
    settings: SettingsStore,
    keys: KeyStore | undefined,
    messages: AiSettingsMessages,
    /** The relay of the platform, where the editor is hosted on one. */
    relay?: AiRelay,
    /** Where the open catalog of models comes from. Without it, only pi's catalog fills in. */
    catalog?: CatalogOptions,
  ) {
    this.#settings = settings;
    this.#keys = keys ?? memoryKeys();
    this.#messages = messages;
    this.#relay = relay;
    this.#catalogOptions = catalog;
    this.#snapshot = {
      ...EMPTY_AI_SETTINGS,
      keyed: new Set(),
      secrets: 0,
      hints: new Map(),
      listings: new Map(),
      known: new Map(),
      keysWhere: this.#keys.where,
      held: undefined,
      resettable: false,
      tests: new Map(),
      pictureTests: new Map(),
      failing: new Map(),
      catalog: { state: "idle" },
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
    if (value !== undefined) await this.#take(value);
    this.#settings.listen(SETTINGS_KEY, (changed) => {
      // One at a time, in the order they came.
      this.#taking = this.#taking.then(async () => {
        if (changed !== undefined) await this.#take(changed);
        await this.#refreshKeyed();
      });
    });
    await this.#refreshKeyed();
  }

  /**
   * Takes settings as saved, or holds them where they cannot be taken. Version 1 where version 2 was
   * written before is a page of before that wrote over them: what it changed goes on top of what
   * version 2 wrote last, which is saved again at once.
   */
  async #take(said: unknown): Promise<void> {
    let value = said;
    const reading = readAiSettings(value);
    if (reading.kind !== "ok") {
      console.warn(`Setting ${SETTINGS_KEY} is ${reading.kind}: left as it is`);
      this.#hold(reading.kind);
      return;
    }
    await this.#readSecrets();
    if (reading.from < 3) {
      // What another window said may be old by now: another page of version 2 may have saved since.
      const saved = await this.#settings.load(SETTINGS_KEY).catch(() => value);
      const current = readAiSettings(saved);
      if (current.kind === "ok" && current.from >= 3) {
        await this.#taken(current);
        return;
      }
      if (current.kind === "ok") value = saved;
      const latest = await this.#settings.load(LATEST_KEY).catch(() => undefined);
      const before = readAiSettings(latest);
      const recovered =
        before.kind === "ok" && before.from >= 3
          ? recoverOldWrite(this.#joined(before.settings), value)
          : undefined;
      if (recovered) {
        this.#own = undefined;
        this.#snapshot = { ...this.#snapshot, ...this.#heldNow() };
        this.#save(recovered);
        return;
      }
    }
    const taken = readAiSettings(value);
    if (taken.kind === "ok") await this.#taken(taken);
  }

  /**
   * Takes settings that were read, with what is secret of each service. Those of before version 4
   * have their addresses and headers, and the header of a key, in them: they go into what is
   * secret, and the settings are saved again without them, once.
   */
  async #taken(reading: Extract<AiSettingsReading, { kind: "ok" }>): Promise<void> {
    const moving = reading.inline === true || reading.keyHeaders !== undefined;
    if (!moving) {
      this.#adopt(this.#joined(reading.settings), undefined);
      // Written back without them at once, so that they are said once, not at every load.
      if (reading.headersLeftOut) {
        this.#messages.headersLeftOut?.();
        this.#save(this.#snapshot);
      }
      return;
    }
    // What is secret of a service already wins: it is what a newer page wrote.
    const settings = withSecrets(reading.settings, (id) => {
      const secret = this.#secrets.get(id);
      return secret?.baseUrl !== undefined || secret?.headers || secret?.models
        ? secret
        : undefined;
    });
    const services = settings.services.map((service) => {
      const header = reading.keyHeaders?.[service.id];
      const key = this.#secrets.get(service.id)?.key;
      if (header === undefined || key === undefined) return service;
      return { ...service, headers: keyIntoHeader(service.headers, header, key) };
    });
    const moved: AiSettings = { ...settings, services };
    if (reading.headersLeftOut) this.#messages.headersLeftOut?.();
    // What is secret goes first, and is read back; only then the settings without it, and only
    // then the key that went into a header goes. Anything of that failing: the settings stay as
    // they are, to move another time, and this page uses them as they are meant.
    const parts = secretsOf(moved);
    try {
      await this.#writing;
      for (const service of services) {
        const own = parts.get(service.id) ?? {};
        const intoHeader = reading.keyHeaders?.[service.id] !== undefined;
        await this.#keys.update(service.id, (before) => {
          const key = intoHeader ? undefined : before?.key;
          return { ...(key !== undefined && { key }), ...own };
        });
        const { key: _key, ...back } = (await this.#keys.read(service.id)) ?? {};
        if (canonical(back) !== canonical(own))
          throw new Error("What is secret of an AI service did not read back as it was written");
      }
    } catch (error) {
      console.warn("The addresses and headers of the AI services could not move yet", error);
      this.#messages.keyFailed();
      this.#adopt(moved, undefined);
      return;
    }
    await this.#readSecrets();
    this.#adopt(moved, undefined);
    this.#save(this.#settingsNow());
    await this.#writing;
  }

  /** The settings with what is secret of each service, as this page last read it. */
  #joined(settings: AiSettings): AiSettings {
    return withSecrets(settings, (id) => this.#secrets.get(id));
  }

  /** Reads what is secret of every service again. What cannot be read is as if there were none. */
  async #readSecrets(): Promise<void> {
    await this.#writing;
    try {
      const ids = await this.#keys.list();
      const secrets = new Map<string, ServiceSecret>();
      for (const id of ids) {
        const secret = await this.#keys.read(id);
        if (secret) secrets.set(id, secret);
      }
      this.#secrets = secrets;
    } catch (error) {
      console.warn("What is secret of the AI services could not be read", error);
    }
  }

  /**
   * Runs a write after those before it, which writes of the settings wait for. One that fails does
   * not stop those after it; whoever waits for it hears of it.
   */
  #after<T>(work: () => Promise<T>): Promise<T> {
    this.#pending += 1;
    const write = this.#writing.then(work).finally(() => {
      this.#pending -= 1;
    });
    this.#writing = write.catch(() => {});
    return write;
  }

  /**
   * Keeps the address and headers of a service with its key as it is kept now, which another window
   * may have changed since this page read it, in one go. Where what is kept cannot be read, nothing
   * is written, and this rejects.
   */
  #writeParts(id: string, parts: Omit<ServiceSecret, "key">): Promise<void> {
    return this.#after(async () => {
      const after = await this.#keys.update(id, (before) => ({
        ...(before?.key !== undefined && { key: before.key }),
        ...parts,
      }));
      if (after) this.#secrets.set(id, after);
      else this.#secrets.delete(id);
    });
  }

  /** Changes the key of a service, leaving what else is secret of it as it is kept now. */
  #writeKey(id: string, key: string | undefined): Promise<void> {
    return this.#after(async () => {
      const after = await this.#keys.update(id, (before) => {
        const { key: _was, ...rest } = before ?? {};
        return { ...rest, ...(key !== undefined && { key }) };
      });
      if (after) this.#secrets.set(id, after);
      else this.#secrets.delete(id);
    });
  }

  #hold(held: SettingsHeld | undefined): void {
    this.#own = held;
    this.#snapshot = { ...this.#snapshot, ...this.#heldNow() };
    this.#emitter.emit();
  }

  /** What holds the settings: what was read of them, or what holds them from outside. */
  #own: SettingsHeld | undefined;
  #outside: SettingsHeld | undefined;
  #heldNow(): Pick<AiSettingsSnapshot, "held" | "resettable"> {
    return { held: this.#own ?? this.#outside, resettable: this.#own !== undefined };
  }

  /**
   * Holds the settings from outside, or lets go of them: while the backend that has them cannot be
   * reached ("offline"), or a newer editor wrote them there ("newer"), nothing changes them here,
   * keys neither.
   */
  holdFor(reason: "offline" | "newer" | undefined): void {
    if (reason === this.#outside) return;
    this.#outside = reason;
    this.#snapshot = { ...this.#snapshot, ...this.#heldNow() };
    this.#emitter.emit();
  }

  /**
   * Keys this page read, and the rest of what is secret of the services (addresses, the values of
   * headers), for whatever must not show them, such as a report.
   */
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
    return {
      baseUrl: service.baseUrl,
      relay: { baseUrl: relayed, headers: this.#relay.headers, passPrefix: RELAY_PASS_PREFIX },
    };
  }

  /**
   * How the chat reaches a model of a service, or why it cannot: at the model's own address and
   * by its own protocol where people gave them, with everything people set of it or a catalog
   * filled in, and the headers of the service and the model.
   */
  endpointOf(
    service: Pick<ServiceConfig, "kind" | "baseUrl" | "route"> &
      Partial<Pick<ServiceConfig, "api" | "headers" | "models">>,
    model: string,
  ): Endpoint | "badUrl" | "relayMissing" | "relayUrl" | undefined {
    const kind = kindOf(service.kind);
    if (!kind) return undefined;
    const config = service.models?.find((each) => each.id === model);
    const baseUrl = config?.baseUrl ?? service.baseUrl;
    if (!baseUrl) return "badUrl";
    const route = this.routeOf({ baseUrl, route: service.route });
    if (typeof route === "string") return route;
    const headers = headersOf(service, config);
    const {
      id: _id,
      added: _added,
      filled: _filled,
      edited: _edited,
      ...values
    } = config ?? {
      id: model,
    };
    const settings: ModelValues = { ...values, ...(headers && { headers }) };
    return {
      service: service.kind,
      protocol: config?.api ?? protocolOf(service) ?? kind.protocol,
      baseUrl: route.baseUrl,
      model,
      catalog: kind.catalog,
      ...(route.relay && { relay: route.relay }),
      ...(Object.keys(settings).length > 0 && { settings }),
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
    this.#own = held;
    this.#snapshot = { ...before, ...settings, ...this.#heldNow() };
    this.#emitter.emit();
  }

  async #refreshKeyed(): Promise<void> {
    await this.#readSecrets();
    const hints = new Map<string, string>();
    const keyed = new Set<string>();
    for (const [id, secret] of this.#secrets) {
      this.#knowSecret(secret);
      const { key } = secret;
      if (key === undefined) continue;
      this.#know(id, key);
      keyed.add(id);
      hints.set(id, key.slice(-HINT_LENGTH));
    }
    this.#snapshot = { ...this.#snapshot, keyed, hints, secrets: this.#secrets.size };
    this.#emitter.emit();
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
      sendWith,
      shotSize,
      lookSize,
      lookWhilePlaying,
      autoCompact,
      askBeforeEdit,
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
      ...(sendWith === "modEnter" && { sendWith }),
      ...(shotSize !== undefined && shotSize !== 1568 && { shotSize }),
      ...(lookSize !== undefined && { lookSize }),
      ...(lookWhilePlaying && { lookWhilePlaying }),
      ...(autoCompact === false && { autoCompact }),
      ...(askBeforeEdit && { askBeforeEdit }),
      ...(kept && { kept }),
    };
  }

  /**
   * Saves settings, with a default that is on. Held settings are not written over. What is secret
   * of a service that changed goes first, apart, and the settings say when it did (`secretAt`).
   */
  #save(changed: AiSettings): boolean {
    if (this.#snapshot.held) return false;
    const secrets = secretsOf(changed);
    const at = Date.now();
    const writes: Promise<void>[] = [];
    const services = changed.services.map((service) => {
      const { key: _key, ...was } = this.#secrets.get(service.id) ?? {};
      const now = secrets.get(service.id) ?? {};
      if (canonical(was) === canonical(now)) return service;
      writes.push(this.#writeParts(service.id, now));
      return { ...service, secretAt: Math.max(at, (service.secretAt ?? 0) + 1) };
    });
    const settings = {
      ...changed,
      services,
      default: settledDefault(services, changed.default),
    };
    this.#adopt(settings, undefined);
    const written = writeAiSettings(settings);
    const write = () =>
      Promise.all([
        this.#settings.save(LATEST_KEY, written),
        this.#settings.save(SETTINGS_KEY, written),
      ]);
    // After what is secret of it, where any is on its way; at once otherwise. Where what is secret
    // could not be kept, the settings without it are not written either: what is saved stays, and
    // the next save tries again (this page still has it all).
    const saving =
      writes.length > 0
        ? Promise.allSettled(writes).then((results) => {
            if (results.some((result) => result.status === "rejected")) {
              this.#messages.keyFailed();
              throw new Error("What is secret of an AI service could not be kept");
            }
            return this.#after(write);
          })
        : this.#pending > 0
          ? this.#after(write)
          : write();
    saving.catch((error: unknown) => {
      console.warn("The AI services could not be saved", error);
      if (!(error instanceof Error && error.message.startsWith("What is secret")))
        this.#messages.saveFailed();
    });
    return true;
  }

  /** What is secret of a service changed on its own, as its key: the settings say so. */
  #secretChanged(id: string): void {
    const now = this.#settingsNow();
    if (!now.services.some((service) => service.id === id)) return;
    this.#save({
      ...now,
      services: now.services.map((service) =>
        service.id === id
          ? { ...service, secretAt: Math.max(Date.now(), (service.secretAt ?? 0) + 1) }
          : service,
      ),
    });
  }

  /**
   * Starts again from nothing, over settings that are held: what was there is gone. Keys stay, as
   * they are kept apart.
   */
  reset(): void {
    if (!this.#own) return;
    this.#own = undefined;
    this.#snapshot = { ...this.#snapshot, ...this.#heldNow() };
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
      readonly api?: ModelApi | undefined;
      readonly headers?: Readonly<Record<string, string>> | undefined;
      /** What the service listed, for the models it starts with that pi does not know. */
      readonly listed?: readonly ListedModel[] | undefined;
    } = {},
  ): string | undefined {
    const found = kindOf(kind);
    if (!found || this.#snapshot.held) return undefined;
    const id = newServiceId();
    const enabled = [...new Set(options.enabled ?? [])];
    const known = new Set((this.#snapshot.known.get(kind) ?? []).map((model) => model.id));
    // The models it starts with that the service listed and pi does not know get a record, which
    // the catalogs fill in; pi's own need none.
    const listed = new Set((options.listed ?? []).map((model) => model.id));
    const models = enabled
      .filter((model) => listed.has(model) && !known.has(model))
      .map((model): ModelConfig => ({ id: model, added: "service" }));
    const service: ServiceConfig = {
      id,
      kind,
      name,
      baseUrl: options.baseUrl ?? found.baseUrl,
      // Where there is no relay, straight is all there is.
      route: this.#relay ? (options.route ?? found.route) : "direct",
      ...(found.custom && options.api && { api: options.api }),
      ...(options.headers &&
        Object.keys(options.headers).length > 0 && { headers: options.headers }),
      enabled,
      ...(models.length > 0 && { models }),
    };
    const now = this.#settingsNow();
    this.#save({ ...now, services: [...now.services, service] });
    if (options.listed) this.#setListing(id, { state: "ok", models: options.listed });
    if (models.length > 0)
      void this.fillModels(
        id,
        models.map((model) => model.id),
      );
    return id;
  }

  update(
    id: string,
    changes: Partial<Pick<ServiceConfig, "name" | "baseUrl" | "route" | "api" | "headers">>,
  ): void {
    const before = this.serviceOf(id);
    this.#changeService(id, (service) => {
      const next: Record<string, unknown> = { ...service, ...changes };
      for (const [name, value] of Object.entries(changes)) {
        if (
          value === undefined ||
          value === "" ||
          (name === "headers" && Object.keys(value).length === 0)
        )
          delete next[name];
      }
      return next as unknown as ServiceConfig;
    });
    // What it listed and how it was tested was of where it was and how it was talked to.
    if (
      before &&
      (("baseUrl" in changes && changes.baseUrl !== before.baseUrl) ||
        ("api" in changes && changes.api !== before.api) ||
        ("headers" in changes &&
          JSON.stringify(changes.headers) !== JSON.stringify(before.headers)) ||
        ("route" in changes && changes.route !== before.route))
    )
      this.#forgetListing(id);
  }

  /** Moves a service to another place in the list, which is also the order of the chat's picker. */
  moveService(id: string, to: number): void {
    const now = this.#settingsNow();
    const from = now.services.findIndex((service) => service.id === id);
    if (from < 0) return;
    const services = [...now.services];
    const [moved] = services.splice(from, 1);
    if (!moved) return;
    services.splice(Math.max(0, Math.min(to, services.length)), 0, moved);
    this.#save({ ...now, services });
  }

  /**
   * Turns every model of a service off, or on again: those that were on as it went off, else its
   * first model. The last model on anywhere stays on ("last").
   */
  setServiceOn(id: string, on: boolean): "last" | undefined {
    const service = this.serviceOf(id);
    if (!service) return undefined;
    if (!on) {
      if (service.enabled.length === 0) return undefined;
      if (enabledCountOf(this.#snapshot) - service.enabled.length < 1) return "last";
      this.#changeService(id, (each) => ({ ...each, enabled: [], paused: each.enabled }));
      return undefined;
    }
    const first = this.modelsFor(id)[0]?.id;
    const enabled = service.paused?.length ? service.paused : first ? [first] : [];
    this.#changeService(id, (each) => {
      const { paused: _was, ...rest } = each;
      return { ...rest, enabled: [...new Set([...each.enabled, ...enabled])] };
    });
    return undefined;
  }

  /** Takes a service away, and all that is secret of it with it. */
  async remove(id: string): Promise<void> {
    const now = this.#settingsNow();
    if (!this.#save({ ...now, services: now.services.filter((service) => service.id !== id) })) {
      return;
    }
    this.#forgetTests(id);
    this.#forgetListing(id);
    await this.#after(() => this.#keys.remove(id))
      .then(() => this.#secrets.delete(id))
      .catch((error: unknown) => {
        console.warn("What is secret of an AI service could not be taken away", error);
        this.#messages.keyFailed();
      });
    await this.#refreshKeyed();
  }

  /**
   * Turns a model of a service on or off. The last model that is on anywhere stays on: "last" says
   * that is why nothing changed. Off, the default goes to another model that is on.
   */
  setEnabled(id: string, model: string, on: boolean): "last" | undefined {
    const service = this.serviceOf(id);
    if (!service || service.enabled.includes(model) === on) return undefined;
    if (!on && enabledCountOf(this.#snapshot) <= 1) return "last";
    this.#changeService(id, (each) => {
      const { paused: _was, ...rest } = each;
      return {
        ...rest,
        enabled: on ? [...each.enabled, model] : each.enabled.filter((name) => name !== model),
      };
    });
    return undefined;
  }

  /**
   * Moves a model that is on to another place among those on: the order of the list, and of the
   * chat's picker. `to` counts among the models that are on.
   */
  moveModel(id: string, model: string, to: number): void {
    const service = this.serviceOf(id);
    if (!service?.enabled.includes(model)) return;
    const enabled = service.enabled.filter((each) => each !== model);
    enabled.splice(Math.max(0, Math.min(to, enabled.length)), 0, model);
    this.#changeService(id, (each) => ({ ...each, enabled }));
  }

  /** Puts the models that are on in the order of their names. */
  sortModels(id: string): void {
    const service = this.serviceOf(id);
    if (!service) return;
    const rows = new Map(this.modelsFor(id).map((row) => [row.id, row]));
    const enabled = service.enabled.toSorted((a, b) =>
      byName(rows.get(a) ?? { id: a }, rows.get(b) ?? { id: b }),
    );
    this.#changeService(id, (each) => ({ ...each, enabled }));
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
   * Models to add to a service, turned on: named by hand, or picked from what the service listed.
   * Each is filled in from the catalogs right away (only what is empty, see `fillModels`).
   */
  addModels(
    id: string,
    models: readonly (Pick<ModelConfig, "id"> & { readonly added: "hand" | "service" })[],
  ): void {
    const ids = [...new Set(models.map((model) => model.id.trim()).filter(Boolean))];
    if (ids.length === 0 || !this.serviceOf(id)) return;
    const how = new Map(models.map((model) => [model.id.trim(), model.added]));
    this.#changeService(id, (service) => {
      const have = new Set((service.models ?? []).map((model) => model.id));
      const known = new Set((this.#snapshot.known.get(service.kind) ?? []).map((m) => m.id));
      const fresh = ids
        .filter((model) => !have.has(model) && !known.has(model))
        .map((model): ModelConfig => ({ id: model, added: how.get(model) ?? "hand" }));
      const records = (service.models?.length ?? 0) + fresh.length > 0 && {
        models: [...(service.models ?? []), ...fresh],
      };
      // A service turned off stays off: what is added goes with the models it turns on again.
      if (service.enabled.length === 0 && service.paused?.length)
        return { ...service, paused: [...new Set([...service.paused, ...ids])], ...records };
      const { paused: _was, ...rest } = service;
      return { ...rest, enabled: [...new Set([...service.enabled, ...ids])], ...records };
    });
    void this.fillModels(id, ids);
  }

  /**
   * Takes a model away: one of pi's catalog only goes off (it stays on the list); any other goes,
   * with all people set of it. One that is on stays, if it is the last one on.
   */
  removeModel(id: string, model: string): "last" | undefined {
    const service = this.serviceOf(id);
    if (!service) return undefined;
    if (service.enabled.includes(model) && this.setEnabled(id, model, false) === "last")
      return "last";
    this.#changeService(id, (each) => {
      const paused = each.paused?.filter((name) => name !== model);
      const { paused: _paused, ...kept } = each;
      const after = paused?.length ? { ...kept, paused } : kept;
      if (this.modelOf(id, model)?.inCatalog) return after;
      const models = (each.models ?? []).filter((custom) => custom.id !== model);
      const { models: _was, ...rest } = after;
      return models.length > 0 ? { ...rest, models } : rest;
    });
    return undefined;
  }

  /** The record of a model, or a new one for a model that has none yet. */
  #configOf(service: ServiceConfig, model: string): ModelConfig {
    return service.models?.find((each) => each.id === model) ?? { id: model };
  }

  /** Changes the record of a model of a service, which is made where there is none. */
  changeModel(id: string, model: string, change: (config: ModelConfig) => ModelConfig): void {
    this.#changeService(id, (service) => {
      const before = this.#configOf(service, model);
      const after = change(before);
      const others = (service.models ?? []).filter((each) => each.id !== model);
      const empty = Object.keys(after).length === 1;
      const models = empty ? others : [...others, after];
      const { models: _was, ...rest } = service;
      return models.length > 0 ? { ...rest, models } : rest;
    });
  }

  /** People set a cell of a model (see `editField`): it is theirs from now on. */
  editModel(id: string, model: string, field: ModelField, value: unknown): void {
    const live = this.modelOf(id, model)?.live;
    this.changeModel(id, model, (config) =>
      editField(config, field, value, live?.thinkingLevelMap ?? {}),
    );
  }

  /** Sets what a model has that no catalog fills: its own address, protocol, headers, switches. */
  setModelOwn<K extends "imageMaxBytes" | "baseUrl" | "api" | "headers" | "compat">(
    id: string,
    model: string,
    field: K,
    value: ModelValues[K] | undefined,
  ): void {
    this.changeModel(id, model, (config) => {
      const { [field]: _was, ...rest } = config;
      const empty =
        value === undefined ||
        (typeof value === "object" && value !== null && Object.keys(value).length === 0);
      return (empty ? rest : { ...rest, [field]: value }) as ModelConfig;
    });
  }

  /**
   * A model under another id, as people renamed it: everything that names it follows, the models
   * on, the default, and the choices of a pack and of reasoning (where no other service has a
   * model of the old name).
   */
  renameModel(id: string, from: string, to: string): "taken" | undefined {
    const name = to.trim();
    const service = this.serviceOf(id);
    if (!service || !name || name === from) return undefined;
    if (this.modelsFor(id).some((model) => model.id === name)) return "taken";
    const now = this.#settingsNow();
    const shared = now.services.some(
      (each) =>
        each.id !== id && (each.enabled.includes(from) || each.models?.some((m) => m.id === from)),
    );
    const swap = (ids: readonly string[]) => ids.map((each) => (each === from ? name : each));
    const services = now.services.map((each) => {
      if (each.id !== id) return each;
      const config = this.#configOf(each, from);
      const models = [
        ...(each.models ?? []).filter((model) => model.id !== from),
        { ...config, id: name, added: config.added ?? "hand" },
      ];
      return {
        ...each,
        enabled: swap(each.enabled),
        ...(each.paused && { paused: swap(each.paused) }),
        models,
      };
    });
    const rekey = <T>(map: Readonly<Record<string, T>> | undefined) => {
      if (!map || shared || !(from in map)) return map;
      const { [from]: value, ...rest } = map;
      return { ...rest, [name]: value as T };
    };
    const packFor = rekey(now.packFor);
    const reasoningFor = rekey(now.reasoningFor);
    this.#save({
      ...now,
      services,
      ...(packFor && { packFor }),
      ...(reasoningFor && { reasoningFor }),
      default:
        now.default?.service === id && now.default.model === from
          ? { service: id, model: name }
          : now.default,
    });
    return undefined;
  }

  /**
   * What the catalogs say of a model of a service: what the service listed (where people asked
   * it), pi's catalog, and the open catalog, matched by the name of the service and its address.
   * Loads the open catalog where this page does not have it yet.
   */
  async sayOf(id: string, model: string): Promise<CatalogValues> {
    const service = this.serviceOf(id);
    if (!service) return catalogValues({});
    const listing = this.#snapshot.listings.get(id);
    const known = await this.loadKnown(service.kind);
    const entries = await this.loadCatalog();
    const config = service.models?.find((each) => each.id === model);
    const say: CatalogSay = {
      service:
        listing?.state === "ok" ? listing.models.find((each) => each.id === model) : undefined,
      pi: known.find((each) => each.id === model),
      modelsDev: entries ? this.#fromCatalog(entries, service, model, config) : undefined,
    };
    return catalogValues(say);
  }

  #fromCatalog(
    entries: readonly CatalogEntry[],
    service: ServiceConfig,
    model: string,
    config: ModelConfig | undefined,
  ): CatalogSay["modelsDev"] {
    const kind = kindOf(service.kind);
    const hints = [
      service.name,
      ...(kind && !kind.custom ? [kind.id, kind.catalog ?? "", kind.name] : []),
    ];
    const found = recommendFromCatalog(entries, model, hints, config?.baseUrl ?? service.baseUrl);
    if (found.exactMatches === 0) return undefined;
    return {
      preset: found.preset,
      ...(found.method !== "none" && { by: found.method }),
      ...(found.matchedProviderName !== undefined && { matched: found.matchedProviderName }),
      ...(found.price.status === "unreliable" && { priceDoubt: found.price.reason }),
    };
  }

  /**
   * Fills in what the catalogs say of models of a service, only what is empty; or with `again`
   * also what a catalog filled before (never what people set). What a model was before can be
   * had back with `undoFill`.
   */
  async fillModels(id: string, models: readonly string[], again = false): Promise<void> {
    for (const model of models) {
      const say = await this.sayOf(id, model);
      if (!this.serviceOf(id)) return;
      const config = this.serviceOf(id)?.models?.find((each) => each.id === model);
      // pi's own models need no record: what pi knows of them is read as they are used.
      if (!config && !again) continue;
      this.changeModel(id, model, (each) => fillModel(each, say, again));
    }
  }

  /** Undoes what a catalog filled in last, see `undoFill`. */
  undoFill(id: string, model: string): void {
    this.changeModel(id, model, undoFill);
  }

  /** A cell back to what the catalogs say, no longer people's, see `revertField`. */
  async revertField(id: string, model: string, field: ModelField): Promise<void> {
    const say = await this.sayOf(id, model);
    this.changeModel(id, model, (config) => revertField(config, field, say));
  }

  /**
   * The open catalog of models: this page's copy, else this device's while it is less than an hour
   * old, else models.dev, else the platform's (where the browser cannot read models.dev, and
   * people are signed in). Undefined where none can be had: then only pi's catalog fills in.
   * `fresh` takes it again from models.dev or the platform, whatever there is.
   */
  loadCatalog(fresh = false): Promise<readonly CatalogEntry[] | undefined> {
    const options = this.#catalogOptions;
    if (!options) return Promise.resolve(undefined);
    if (!fresh && this.#catalog) return Promise.resolve(this.#catalog);
    if (this.#catalogLoading) return this.#catalogLoading;
    this.#setCatalog({ state: "loading" });
    const load = (async () => {
      const cache = options.cache;
      if (!fresh && cache) {
        const kept = readModelCatalog(await cache.read(CATALOG_CACHE_KEY).catch(() => undefined));
        if (kept && Date.now() - kept.fetchedAt < MODEL_CATALOG_MAX_AGE_MS)
          return this.#tookCatalog(kept, "device");
      }
      try {
        const send = options.fetch ?? globalThis.fetch.bind(globalThis);
        // Nothing of anyone goes with it: no cookies, no referrer.
        const response = await send(MODELS_DEV_URL, {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
        const catalog = { fetchedAt: Date.now(), entries: flattenModelsDev(await response.json()) };
        if (catalog.entries.length === 0) throw new Error("models.dev answered no models");
        void cache?.write(CATALOG_CACHE_KEY, catalog);
        return this.#tookCatalog(catalog, "models.dev");
      } catch (error) {
        console.warn("The open catalog of models could not be read", error);
      }
      if (options.platform) {
        try {
          const catalog = await options.platform();
          void cache?.write(CATALOG_CACHE_KEY, catalog);
          return this.#tookCatalog(catalog, "platform");
        } catch (error) {
          console.warn("The platform did not give the catalog of models", error);
        }
      }
      this.#setCatalog({ state: "failed" });
      return this.#catalog;
    })().finally(() => {
      this.#catalogLoading = undefined;
    });
    this.#catalogLoading = load;
    return load;
  }

  #tookCatalog(
    catalog: ModelCatalog,
    from: "device" | "models.dev" | "platform",
  ): readonly CatalogEntry[] {
    this.#catalog = catalog.entries;
    this.#setCatalog({
      state: "ok",
      fetchedAt: catalog.fetchedAt,
      from,
      count: catalog.entries.length,
    });
    return catalog.entries;
  }

  #setCatalog(catalog: CatalogState): void {
    this.#snapshot = { ...this.#snapshot, catalog };
    this.#emitter.emit();
  }

  /**
   * The catalogs again: pi's of each kind, and the open one, fresh. Fills in nothing by itself:
   * the details of a model offer to fill in again.
   */
  async refreshCatalog(): Promise<void> {
    await this.loadCatalog(true);
  }

  /** What the open catalog says of a model, without loading it: for lists, as far as it is here. */
  catalogEntryOf(id: string, model: string): CatalogSay["modelsDev"] {
    const service = this.serviceOf(id);
    if (!service || !this.#catalog) return undefined;
    return this.#fromCatalog(this.#catalog, service, model, undefined);
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

  /** Whether a conversation gets a short title from its model after its first turn. */
  setAutoTitle(on: boolean): void {
    this.#save({ ...this.#settingsNow(), autoTitle: on });
  }

  /** Whether thinking shows in full in the chat, rather than its first line. */
  setExpandThinking(on: boolean): void {
    this.#save({ ...this.#settingsNow(), expandThinking: on });
  }

  /** Which key sends a message in the chat; the other makes a new line. */
  /** How large the frames AI renders are where it does not say. */
  setLookSize(size: "small" | "medium" | "large"): void {
    const { lookSize: _was, ...now } = this.#settingsNow();
    this.#save({ ...now, ...(size !== "medium" && { lookSize: size }) });
  }

  /** Whether the earlier conversation is summed up by itself once the context is 80 % full. */
  setAutoCompact(on: boolean): void {
    const { autoCompact: _was, ...now } = this.#settingsNow();
    this.#save({ ...now, ...(!on && { autoCompact: false as const }) });
  }

  /** Whether AI asks before each change of the project, see `AiSettings.askBeforeEdit`. */
  setAskBeforeEdit(on: boolean): void {
    const { askBeforeEdit: _was, ...now } = this.#settingsNow();
    this.#save({ ...now, ...(on && { askBeforeEdit: true as const }) });
  }

  /** Whether AI waits for people to stop playing before it renders frames. */
  setLookWaits(waits: boolean): void {
    const { lookWhilePlaying: _was, ...now } = this.#settingsNow();
    this.#save({ ...now, ...(!waits && { lookWhilePlaying: true as const }) });
  }

  /** How large a frame for the chat is at most, see `ShotSide`. */
  setShotSize(size: ShotSide): void {
    const { shotSize: _was, ...now } = this.#settingsNow();
    this.#save({ ...now, ...(size !== 1568 && { shotSize: size }) });
  }

  setSendWith(key: SendWith): void {
    const { sendWith: _was, ...now } = this.#settingsNow();
    this.#save({ ...now, ...(key === "modEnter" && { sendWith: key }) });
  }

  /** Whether the settings list the model packs that are hidden, see `AiSettings`. */
  setShowHiddenPacks(on: boolean): void {
    const { showHiddenPacks: _was, ...now } = this.#settingsNow();
    this.#save({ ...now, ...(on && { showHiddenPacks: true }) });
  }

  async keyOf(id: string): Promise<string | undefined> {
    try {
      await this.#writing;
      const key = (await this.#keys.read(id))?.key;
      this.#know(id, key);
      return key;
    } catch (error) {
      console.warn("A key could not be read", error);
      this.#messages.keyFailed();
      return undefined;
    }
  }

  async setKey(id: string, key: string): Promise<void> {
    if (this.#outside) return;
    const trimmed = key.trim();
    if (!trimmed) return this.removeKey(id);
    this.#know(id, trimmed);
    this.#forgetTests(id);
    this.#forgetListing(id);
    await this.#changeKey(id, trimmed);
  }

  /** A key of a service, or none, beside what else is secret of it. */
  async #changeKey(id: string, key: string | undefined): Promise<void> {
    try {
      await this.#writeKey(id, key);
      this.#secretChanged(id);
    } catch (error) {
      console.warn("A key could not be kept", error);
      this.#messages.keyFailed();
    }
    await this.#refreshKeyed();
  }

  async removeKey(id: string): Promise<void> {
    if (this.#outside) return;
    this.#forgetTests(id);
    this.#forgetListing(id);
    await this.#changeKey(id, undefined);
  }

  /**
   * Every key in this browser goes, also of services that are no longer set up, with all that was
   * secret of those; services that are keep their addresses and headers.
   */
  async removeAllKeys(): Promise<void> {
    if (this.#outside) return;
    try {
      await this.#writing;
      const ids = new Set(this.#snapshot.services.map((service) => service.id));
      for (const id of await this.#keys.list()) {
        if (!ids.has(id)) await this.#keys.remove(id);
        else if ((await this.#keys.read(id))?.key !== undefined) {
          await this.#writeKey(id, undefined);
          this.#secretChanged(id);
        }
      }
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
    const listed = await listModels(
      protocolOf(service) ?? kind.protocol,
      route.relay?.baseUrl ?? route.baseUrl,
      key,
      { headers: this.#listHeaders(service, route) },
    );
    // Changed meanwhile: what it listed is of what it was, so it is asked again.
    if (this.serviceOf(id) !== service) {
      this.#forgetListing(id);
      if (this.serviceOf(id)) void this.fetchModels(id);
      return;
    }
    this.#setListing(
      id,
      listed.ok
        ? { state: "ok", models: listed.models }
        : { state: "failed", failure: listed.failure },
    );
  }

  /** The headers of a service as its list of models is asked for: through the relay as it takes them. */
  #listHeaders(
    service: Pick<ServiceConfig, "headers">,
    route: Exclude<ServiceRoute, string>,
  ): Record<string, string> {
    if (!route.relay) return { ...service.headers };
    return { ...relayPassHeaders(service.headers), ...route.relay.headers };
  }

  /** What a service listed no longer counts: where it is or how it is talked to changed. */
  #forgetListing(id: string): void {
    if (!this.#snapshot.listings.has(id)) return;
    const listings = new Map(this.#snapshot.listings);
    listings.delete(id);
    this.#snapshot = { ...this.#snapshot, listings };
    this.#emitter.emit();
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
    const live = new Map(catalog.map((model) => [model.id, model]));
    const configs = new Map((service.models ?? []).map((model) => [model.id, model]));
    const ids = [
      ...new Set([...service.enabled, ...catalog.map((model) => model.id), ...configs.keys()]),
    ];
    const enabled = new Set(service.enabled);
    const rows = ids.map((model): ServiceModel => {
      const known = live.get(model);
      const config = configs.get(model);
      const pi = liveOf(known);
      const values = effectiveValues(config, pi);
      return {
        id: model,
        ...(values.name !== undefined && { name: values.name }),
        ...(values.contextWindow !== undefined && { contextWindow: values.contextWindow }),
        ...(values.maxTokens !== undefined && { maxTokens: values.maxTokens }),
        ...(values.cost !== undefined && { cost: values.cost }),
        ...(values.reasoning !== undefined && { reasoning: values.reasoning }),
        ...(values.image !== undefined && { image: values.image }),
        ...(values.thinkingLevelMap !== undefined && { thinkingLevelMap: values.thinkingLevelMap }),
        enabled: enabled.has(model),
        values,
        ...(config && { config }),
        ...(pi && { live: pi }),
        inCatalog: known !== undefined,
        custom: known === undefined && config?.added !== "service",
        levels: supportedLevels(values.reasoning, values.thinkingLevelMap),
      };
    });
    // Those on in their order, which is the order of the chat's picker, then the others by name.
    const order = new Map(service.enabled.map((model, index) => [model, index]));
    return rows.toSorted((a, b) => {
      const at = order.get(a.id);
      const bt = order.get(b.id);
      if (at !== undefined || bt !== undefined) return (at ?? Infinity) - (bt ?? Infinity);
      return byName(a, b);
    });
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
    if (model !== undefined) this.#setPictureTest(where, undefined);
    const key = (await this.keyOf(id)) ?? "";
    const asked = model ?? service.enabled[0] ?? cheapestOf(await this.loadKnown(service.kind))?.id;
    const test =
      asked !== undefined
        ? await this.#test(service, key, asked)
        : (await this.#list(service, kind, key)).test;
    this.#setTest(where, test);
    // A model people say takes pictures is asked about one too: only an answer shows it does.
    if (model !== undefined && test.state === "ok" && this.modelOf(id, model)?.image) {
      const endpoint = this.endpointOf(service, model);
      if (endpoint !== undefined && typeof endpoint !== "string") {
        const said = await testModelPicture(endpoint, key);
        this.#setPictureTest(
          where,
          !said.ok
            ? { state: "failed", failure: failureOf(said.error, [key]) }
            : saysRed(said.text)
              ? { state: "ok" }
              : { state: "wrong", said: said.text },
        );
      }
    }
    return test;
  }

  #setPictureTest(where: string, test: PictureTest | undefined): void {
    const pictureTests = new Map(this.#snapshot.pictureTests);
    if (test) pictureTests.set(where, test);
    else if (!pictureTests.delete(where)) return;
    this.#snapshot = { ...this.#snapshot, pictureTests };
    this.#emitter.emit();
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
    const listed = await listModels(
      draft.api ?? kind.protocol,
      route.relay?.baseUrl ?? route.baseUrl,
      key,
      { headers: this.#listHeaders(draft, route) },
    );
    const ms = Date.now() - started;
    if (!listed.ok) return { test: { state: "failed", ms, failure: listed.failure } };
    return { test: { state: "ok", ms, models: listed.models.length }, models: listed.models };
  }

  /** What tests of a service came to no longer counts once its key changed. */
  #forgetTests(id: string): void {
    if (this.#snapshot.failing.has(id)) this.noteRequest(id, undefined);
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
    const service = where.split("\n")[0] ?? where;
    if (test.state === "ok") this.noteRequest(service, undefined);
    else if (test.state === "failed") this.noteRequest(service, test.failure);
    this.#emitter.emit();
  }

  /**
   * How a request to a service went, a test or one of the chat: one that failed marks the service
   * (`failing`) until one goes through.
   */
  noteRequest(id: string, failure: ServiceFailure | undefined): void {
    const before = this.#snapshot.failing;
    if (failure === undefined && !before.has(id)) return;
    const failing = new Map(before);
    if (failure === undefined) failing.delete(id);
    else failing.set(id, failure);
    this.#snapshot = { ...this.#snapshot, failing };
    this.#emitter.emit();
  }

  /**
   * The rest of what is secret of a service, for reports to leave out too: the values of its
   * headers (a key can be one) and where it is, also of each of its models.
   */
  #knowSecret(secret: ServiceSecret): void {
    const values = [
      secret.baseUrl,
      ...Object.values(secret.headers ?? {}),
      ...Object.values(secret.models ?? {}).flatMap((model) => [
        model.baseUrl,
        ...Object.values(model.headers ?? {}),
      ]),
    ].filter((value): value is string => value !== undefined && value.trim().length >= 8);
    const fresh = values.filter((value) => !this.#knownSet.has(value));
    if (fresh.length > 0) this.#knownSet = new Set([...this.#knownSet, ...fresh]);
  }

  #know(id: string, key: string | undefined): void {
    if (key === undefined || this.#known.get(id) === key) return;
    this.#known.set(id, key);
    // Old keys stay known: a report could still be about something from before.
    this.#knownSet = new Set([...this.#knownSet, key]);
  }
}
