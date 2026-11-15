/**
 * The editor's own addresses (`aq:`), as links in what people and AI write in the chat: a moment of
 * a timeline, an object, lines of a code file, or several objects at once. People put them in their
 * words with the buttons of the chat; the tools take them where they take an id, a time or a path,
 * so that a link pasted as it is still finds what it points to.
 *
 *   aq://time?timeline=main&t=73/6            a moment, `t` as times of the project are written
 *   aq://object/clip_7Hq2?timeline=main        an object, by its stable id
 *   aq://keyframe/clip_7Hq2?timeline=main&property=position&t=3   a keyframe of a clip
 *   aq://file/scenes/intro/scene.html#L12-18   lines of a code file
 *   aq://objects?timeline=main&ids=clip_a,clip_b   several objects
 */

export type Address =
  | {
      readonly kind: "time";
      readonly timeline: string | undefined;
      readonly t: string;
      readonly version?: string;
    }
  | {
      readonly kind: "object";
      readonly id: string;
      readonly timeline: string | undefined;
    }
  | {
      readonly kind: "keyframe";
      /** The clip the keyframe is on. */
      readonly id: string;
      readonly timeline: string | undefined;
      readonly property: string;
      readonly t: string;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly from?: number;
      readonly to?: number;
    }
  | {
      readonly kind: "objects";
      readonly ids: readonly string[];
      readonly timeline: string | undefined;
    };

const PREFIX = "aq://";

/** Whether a text is an address of the editor, as far as its scheme goes. */
export const isAddress = (text: string): boolean =>
  text.slice(0, PREFIX.length).toLowerCase() === PREFIX;

const decode = (text: string): string | undefined => {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
};

/** The pairs of a query, as a form writes them: `+` is a space, the rest as `decodeURIComponent`. */
function queryOf(text: string): { get(key: string): string | undefined } {
  const pairs = new Map<string, string>();
  for (const pair of text.split("&")) {
    if (pair === "") continue;
    const at = pair.indexOf("=");
    const key = decode((at < 0 ? pair : pair.slice(0, at)).replace(/\+/g, " "));
    const value = decode((at < 0 ? "" : pair.slice(at + 1)).replace(/\+/g, " "));
    if (key !== undefined && value !== undefined && !pairs.has(key)) pairs.set(key, value);
  }
  return { get: (key) => pairs.get(key) };
}

/** An address, read; nothing where it is none or does not say what it points to. */
export function parseAddress(text: string): Address | undefined {
  const trimmed = text.trim();
  if (!isAddress(trimmed)) return undefined;
  const rest = trimmed.slice(PREFIX.length);
  const hashAt = rest.indexOf("#");
  const hash = hashAt < 0 ? "" : rest.slice(hashAt + 1);
  const beforeHash = hashAt < 0 ? rest : rest.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const path = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryOf(queryAt < 0 ? "" : beforeHash.slice(queryAt + 1));
  const slash = path.indexOf("/");
  const kind = (slash < 0 ? path : path.slice(0, slash)).toLowerCase();
  const tail = slash < 0 ? "" : decode(path.slice(slash + 1));
  if (tail === undefined) return undefined;
  const timeline = query.get("timeline") ?? undefined;
  switch (kind) {
    case "time": {
      const t = query.get("t");
      if (!t) return undefined;
      const version = query.get("version");
      return { kind, timeline, t, ...(version && { version }) };
    }
    case "object":
      return tail ? { kind, id: tail, timeline } : undefined;
    case "keyframe": {
      const property = query.get("property");
      const t = query.get("t");
      return tail && property && t ? { kind, id: tail, timeline, property, t } : undefined;
    }
    case "file": {
      if (!tail) return undefined;
      const lines = /^L(\d+)(?:-L?(\d+))?$/.exec(hash);
      if (!lines) return { kind, path: tail };
      const from = Number(lines[1]);
      const to = lines[2] === undefined ? from : Number(lines[2]);
      return { kind, path: tail, from, to: Math.max(from, to) };
    }
    case "objects": {
      const ids = (query.get("ids") ?? "").split(",").filter((id) => id !== "");
      return ids.length > 0 ? { kind, ids, timeline } : undefined;
    }
    default:
      return undefined;
  }
}

const part = (text: string) =>
  encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);

/** The address of a moment, an object, lines or objects, as `parseAddress` reads it. */
export function formatAddress(address: Address): string {
  const query = (pairs: readonly (readonly [string, string | undefined])[]) => {
    const kept = pairs.filter((pair): pair is [string, string] => pair[1] !== undefined);
    // Ids and times keep their commas and slashes: they read better, and `queryOf` takes them.
    return kept.length === 0
      ? ""
      : `?${kept.map(([key, value]) => `${key}=${part(value).replace(/%2C/g, ",").replace(/%2F/g, "/")}`).join("&")}`;
  };
  switch (address.kind) {
    case "time":
      return `${PREFIX}time${query([
        ["timeline", address.timeline],
        ["t", address.t],
        ["version", address.version],
      ])}`;
    case "object":
      return `${PREFIX}object/${part(address.id)}${query([["timeline", address.timeline]])}`;
    case "keyframe":
      return `${PREFIX}keyframe/${part(address.id)}${query([
        ["timeline", address.timeline],
        ["property", address.property],
        ["t", address.t],
      ])}`;
    case "file": {
      const path = address.path.split("/").map(part).join("/");
      const lines =
        address.from === undefined
          ? ""
          : address.to === undefined || address.to === address.from
            ? `#L${address.from}`
            : `#L${address.from}-${address.to}`;
      return `${PREFIX}file/${path}${lines}`;
    }
    case "objects":
      return `${PREFIX}objects${query([
        ["timeline", address.timeline],
        ["ids", address.ids.join(",")],
      ])}`;
  }
}

/**
 * What a tool takes in place of an address: the id of an object, the time of a moment, the path of
 * a file, the ids of several objects. Nothing for a text that is no address.
 */
export function valueOfAddress(text: string): string | readonly string[] | undefined {
  const address = parseAddress(text);
  if (!address) return undefined;
  switch (address.kind) {
    case "time":
      return address.t;
    case "object":
    case "keyframe":
      return address.id;
    case "file":
      return address.path;
    case "objects":
      return address.ids;
  }
}

/** A text that is one address and nothing else: never a line of code or words that hold one. */
const lone = (text: string): boolean => isAddress(text.trim()) && !/\s/.test(text.trim());

/**
 * The arguments of a call with each address in them replaced by what it stands for, see
 * `valueOfAddress`: in a list, an address of several objects becomes each of them. Anything else
 * stays as it is, the same object where nothing changed.
 */
export function withoutAddresses(value: unknown): unknown {
  if (typeof value === "string") {
    const found = lone(value) ? valueOfAddress(value) : undefined;
    return found === undefined ? value : Array.isArray(found) ? found.join(",") : found;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items: unknown[] = [];
    for (const item of value) {
      if (typeof item === "string" && lone(item)) {
        const found = valueOfAddress(item);
        if (found !== undefined) {
          changed = true;
          if (Array.isArray(found)) items.push(...found);
          else items.push(found);
          continue;
        }
      }
      const next = withoutAddresses(item);
      if (next !== item) changed = true;
      items.push(next);
    }
    return changed ? items : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const next = withoutAddresses(item);
      if (next !== item) changed = true;
      return [key, next] as const;
    });
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}
