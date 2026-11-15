/**
 * What the editor and a platform keep alike of AI settings that go with an account, see
 * `AiSyncAccess`: nothing of a browser, so that a server can use it too.
 *
 * The settings go as entries, not as one document: each service, each model people set up in one,
 * the default model, each choice of a pack or of how hard a model reasons, each preference, each
 * installed pack is one entry, with
 * when it last changed (`at`), and an entry taken away stays as such (`deleted`), the newest
 * `DELETED_KEPT` of them. Two copies are merged entry by entry, the later wins, so that two devices
 * that each add a service keep both. What an entry holds is the editor's to read: the platform only
 * checks that it is made as such an entry is, see `checkAiEntry`. What is secret of a service (its
 * key, address and headers, `ServiceSecret`) goes apart (`AiSyncKey`), which the platform seals
 * before it goes into its database: the entries have none of it.
 */

/**
 * The format of the entries. One a platform has from a newer editor is not written over. 2 (0.3.65)
 * has each model of a service as an entry of its own (`model:<service>/<model>`): an editor of
 * format 1 makes its settings without them, and would write that back as all there is.
 */
export const AI_SYNC_FORMAT = 3;
/** The first format with entries of models, which an editor gives once it has any. */
export const AI_SYNC_MODELS_FORMAT = 2;
/**
 * The first format whose services and models have their address and headers in their
 * `ServiceSecret` (0.3.72): an editor of format 2 reads a service without an address as none, and
 * would write its settings back without it.
 */
export const AI_SYNC_SECRETS_FORMAT = 3;
/** All entries of a person together, as JSON, at most. */
export const AI_SYNC_BYTES = 512 * 1024;
/** One entry at most: an installed pack can be 256 KB. */
export const AI_ENTRY_BYTES = 300 * 1024;
/** How many entries one change gives at most, and keys. */
export const AI_SYNC_BATCH = 500;
export const AI_SYNC_KEYS = 100;
/** How long a key of a service can be, in characters. */
export const AI_KEY_LENGTH = 8192;
/** All of what is secret of one service, as JSON, at most: its models' headers included. */
export const AI_SECRET_BYTES = 64 * 1024;
/**
 * How many entries taken away a person's settings keep as such, and as many keys, the newest: the
 * oldest beyond go. Each is only a name and a time.
 */
export const DELETED_KEPT = 1000;

/** An entry as it is kept, see the top of this file. */
export type AiEntry =
  | { readonly at: number; readonly value: unknown; readonly deleted?: undefined }
  | { readonly at: number; readonly deleted: true; readonly value?: undefined };

/** Headers people send a service or a model, by their names. */
export type SecretHeaders = Readonly<Record<string, string>>;

/**
 * What is secret of a service people set up, kept apart from its settings and sealed on a platform
 * (docs/design/settings-and-properties.md of AnimaQuill Cloud, 6.5): its key, its address and the
 * headers that go with it, and the same of each of its models that has its own, by the id of the
 * model. All of it goes, and is kept, as one.
 */
export interface ServiceSecret {
  readonly key?: string;
  readonly baseUrl?: string;
  readonly headers?: SecretHeaders;
  readonly models?: Readonly<
    Record<string, { readonly baseUrl?: string; readonly headers?: SecretHeaders }>
  >;
}

/** What is secret of a service as it goes with the account, see `ServiceSecret`. */
export type AiSyncKey =
  | { readonly at: number; readonly secret: ServiceSecret; readonly deleted?: undefined }
  | { readonly at: number; readonly deleted: true; readonly secret?: undefined };

/**
 * The name of an entry: a kind, and after a colon what it is of, such as `service:<id>` or
 * `pack:<model>`. Kinds this editor does not know are kept as they are, for a newer one.
 */
const ENTRY_NAME = /^[a-z][a-z-]{0,39}(?::[^\p{Cc}]{1,300})?$/u;
/** What a service is named by, see `ServiceConfig.id` of the editor. */
export const SERVICE_ID = /^[A-Za-z0-9_-]{1,100}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Names of fields that hold a secret, which never go into an entry: keys go as keys. Whole names
 * only, without case, `-` or `_`. The same rule as the settings of the editor keep (`isSecretName`
 * of `@animaquill/agent`), so that what one keeps the other takes.
 */
const SECRET =
  /^(?:(?:api|access|secret|private|client)?key|(?:access|auth|bearer|refresh|id|session)?token|(?:client)?secret|password|passwd|passphrase|credentials?|authorization|cookie)$/;

export const isSecretName = (name: string): boolean =>
  SECRET.test(name.toLowerCase().replaceAll(/[-_]/g, ""));

/** Whether anything in a value is under the name of a secret, however deep. */
const hasSecret = (value: unknown, depth = 0): boolean => {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((each) => hasSecret(each, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([name, inner]) => isSecretName(name) || hasSecret(inner, depth + 1),
  );
};

/** Names of query parameters that carry a secret, such as `?key=` or `?api_key=`. */
const SECRET_PARAM = /key|token|secret|passw|auth|signature|^sig$|credential/i;

/**
 * Whether an address of a service carries a secret: a user or password (`user:pass@`), or a
 * parameter of the query named like one. Keys go as keys, never in the address.
 */
export function urlHasSecret(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return true;
  return [...url.searchParams.keys()].some((name) => SECRET_PARAM.test(name));
}

const isText = (value: unknown, max = 2000): value is string =>
  typeof value === "string" && value.length <= max;

/** The size of a value as JSON, in bytes as UTF-8. */
export const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value) ?? "").length;

/** Nothing, or names with texts, such as the headers people send to a service. */
const textsOrNothing = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) && Object.values(value).every((each) => isText(each, 4000)));

/** Headers as a secret has them: up to 64, names of up to 200 characters, values of up to 8000. */
function readSecretHeaders(value: unknown): SecretHeaders | undefined | false {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 64) return false;
  for (const [name, each] of entries)
    if (name === "" || name.length > 200 || !isText(each, 8000)) return false;
  return entries.length > 0 ? (value as SecretHeaders) : undefined;
}

/**
 * What is secret of a service as it can be kept, see `ServiceSecret`, or undefined where anything of
 * it is not as it should be, or it is larger than `AI_SECRET_BYTES`. Whatever else it has is left
 * out. What an address or a header is like is the editor's to check, as it is of the settings: here
 * only that each is a text.
 */
export function readServiceSecret(value: unknown): ServiceSecret | undefined {
  if (!isRecord(value)) return undefined;
  const { key, baseUrl, headers, models } = value;
  if (key !== undefined && (typeof key !== "string" || key === "" || key.length > AI_KEY_LENGTH))
    return undefined;
  if (baseUrl !== undefined && !isText(baseUrl)) return undefined;
  const ownHeaders = readSecretHeaders(headers);
  if (ownHeaders === false) return undefined;
  let own: Record<string, { baseUrl?: string; headers?: SecretHeaders }> | undefined;
  if (models !== undefined) {
    if (!isRecord(models) || Object.keys(models).length > 1000) return undefined;
    own = {};
    for (const [id, model] of Object.entries(models)) {
      if (id === "" || id.length > 300 || !isRecord(model)) return undefined;
      if (model.baseUrl !== undefined && !isText(model.baseUrl)) return undefined;
      const modelHeaders = readSecretHeaders(model.headers);
      if (modelHeaders === false) return undefined;
      if (model.baseUrl === undefined && modelHeaders === undefined) continue;
      own[id] = {
        ...(model.baseUrl !== undefined && { baseUrl: model.baseUrl as string }),
        ...(modelHeaders && { headers: modelHeaders }),
      };
    }
  }
  const secret: ServiceSecret = {
    ...(key !== undefined && { key }),
    ...(baseUrl !== undefined && { baseUrl: baseUrl as string }),
    ...(ownHeaders && { headers: ownHeaders }),
    ...(own && Object.keys(own).length > 0 && { models: own }),
  };
  return jsonBytes(secret) > AI_SECRET_BYTES ? undefined : secret;
}

export const isEntryName = (name: unknown): name is string =>
  typeof name === "string" && ENTRY_NAME.test(name);

/**
 * Whether a value can be the entry of that name, as far as the kinds this version knows: the
 * editor reads the rest itself, and leaves what it cannot read. Nothing of it under the name of a
 * secret, and not larger than `AI_ENTRY_BYTES`.
 */
export function checkAiEntry(name: string, value: unknown): boolean {
  if (!isEntryName(name) || value === undefined) return false;
  // The headers an editor of format 2 sent with a service or a model are theirs to name; anything
  // else under the name of a secret is not taken. Format 3 has them in the `ServiceSecret`.
  const named =
    isRecord(value) && isRecord(value.headers) && /^(?:service|model):/.test(name)
      ? { ...value, headers: undefined }
      : value;
  if (hasSecret(named) || jsonBytes(value) > AI_ENTRY_BYTES) return false;
  const colon = name.indexOf(":");
  const kind = colon < 0 ? name : name.slice(0, colon);
  const of = colon < 0 ? undefined : name.slice(colon + 1);
  switch (kind) {
    case "service":
      return (
        of !== undefined &&
        SERVICE_ID.test(of) &&
        isRecord(value) &&
        value.id === of &&
        isText(value.kind, 100) &&
        isText(value.name) &&
        (value.baseUrl === undefined || (isText(value.baseUrl) && !urlHasSecret(value.baseUrl))) &&
        (value.route === "direct" || value.route === "relay") &&
        Array.isArray(value.enabled) &&
        value.enabled.every((model) => isText(model, 300)) &&
        textsOrNothing(value.headers)
      );
    case "model": {
      // `model:<service>/<model>`: one model of a service, as people set it up.
      const slash = of?.indexOf("/") ?? -1;
      const service = of?.slice(0, slash);
      return (
        of !== undefined &&
        slash > 0 &&
        SERVICE_ID.test(service ?? "") &&
        isRecord(value) &&
        isText(value.id, 300) &&
        value.id === of.slice(slash + 1) &&
        (value.baseUrl === undefined || (isText(value.baseUrl) && !urlHasSecret(value.baseUrl))) &&
        textsOrNothing(value.headers)
      );
    }
    case "order":
      return of === undefined && Array.isArray(value) && value.every((id) => isText(id, 100));
    case "default":
      return (
        of === undefined &&
        (value === null ||
          (isRecord(value) && isText(value.service, 100) && isText(value.model, 300)))
      );
    case "pack":
      return of !== undefined && isText(value, 200);
    case "reasoning":
      return of !== undefined && isText(value, 40);
    case "field":
      return of !== undefined && !isSecretName(of);
    case "installed":
      return of !== undefined && isRecord(value) && isRecord(value.files);
    default:
      // A kind of a newer editor: kept as it is.
      return true;
  }
}

/** Whether `incoming` takes the place of `kept`: later, or as late and taking it away. */
export const isLaterEntry = (
  kept: { readonly at: number; readonly deleted?: boolean | undefined } | undefined,
  incoming: { readonly at: number; readonly deleted?: boolean | undefined },
): boolean =>
  kept === undefined ||
  incoming.at > kept.at ||
  (incoming.at === kept.at && incoming.deleted === true && kept.deleted !== true);
