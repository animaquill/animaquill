import { z } from "zod";
import type { ToolResult } from "./types.ts";

/**
 * What `animaquill mcp` and the editor in the browser say to each other over a WebSocket on this
 * computer (docs/design/online-offline.md of AnimaQuill Cloud, 5.1): the AI tool's calls go to the
 * page that has the project open, and run there with the same tools as the assistant in the browser.
 * The relay (the first `animaquill mcp`) listens on 127.0.0.1; pages connect to it. Every message is
 * one JSON object with a type `t`; both sides check what they get with these schemas.
 */

/** A new version where either side would misread the other. */
export const BRIDGE_PROTOCOL = 1;

/** Where the relay listens: the first port that is free of these. */
export const RELAY_PORTS: { readonly first: number; readonly count: number } = {
  first: 47_300,
  count: 10,
};

/** Larger messages close the connection: pictures of frames are the largest there are. */
export const BRIDGE_MAX_BYTES = 32 * 1024 * 1024;

/** Results larger than this are not sent: the page answers that it was too large instead. */
export const BRIDGE_MAX_RESULT = BRIDGE_MAX_BYTES - 64 * 1024;

/** The words the relay signs, which tie a proof to this connection: see `proofText`. */
export const proofText = (nonce: string, origin: string, port: number): string =>
  `animaquill-relay\n${BRIDGE_PROTOCOL}\n${nonce}\n${origin}\n${port}`;

const id = z.string().min(1).max(200);

/** Who the AI tool is, as MCP says it (`clientInfo`). */
const client = z.object({ name: z.string().max(200), version: z.string().max(200).optional() });
export type BridgeClient = z.infer<typeof client>;

/** A picture of a result, in the bytes MCP takes. */
const image = z.object({ type: z.string().max(100), data: z.string() });

const result = z.object({
  text: z.string(),
  isError: z.boolean(),
  images: z.array(image).max(64).optional(),
});
export type BridgeResult = z.infer<typeof result>;

/** A session of an AI tool, as pages show who is connected. */
const session = z.object({
  session: id,
  client: client.optional(),
  since: z.number(),
  /** The page whose project it works on, once it found one. */
  page: id.optional(),
});
export type BridgeSession = z.infer<typeof session>;

/** A project AI tools wait for, as pages show it: see `ToPage`, "waiting". */
const waitingFor = z.object({
  /** Which project, the same for every session that waits for it. */
  key: z.string().max(500),
  mode: z.enum(["online", "offline"]),
  /** The id in animaquill.json, where it is known. */
  id: z.string().max(200).optional(),
  name: z.string().max(500),
  /** Online: its address. */
  link: z.string().max(2000).optional(),
  clients: z.array(client).max(100),
  /** Pages that have a project with this id open, in another folder: a copy. */
  notHere: z.array(id).max(100).optional(),
});
export type BridgeWaiting = z.infer<typeof waitingFor>;

/** What the relay sends to a page. */
export const toPage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    protocol: z.number(),
    /** The tools as the relay lists them to AI tools: `TOOLSET_VERSION` and a hash of the list. */
    toolset: z.string().max(100),
    list: z.string().max(200),
    /** Its identity: an ECDSA P-256 key, SPKI in base64. */
    key: z.string().max(1000),
    /** The answer to the page's `prove`, which comes in the address: see `proofText`. */
    signature: z.string().max(1000),
  }),
  z.object({
    t: z.literal("call"),
    call: id,
    session: id,
    client: client.optional(),
    /** Which answer of the model the call is of: calls of one answer hold each other back. */
    answer: id,
    tool: z.string().max(100),
    args: z.unknown(),
    /** The project it is for, as the page said it has it open: the page runs it on no other. */
    project: z.object({ mode: z.enum(["online", "offline"]), key: id }),
    /**
     * It comes again, as after the relay changed: it may have run on a page that is gone. A page
     * that has no record of it runs no change for it.
     */
    again: z.boolean().optional(),
  }),
  z.object({ t: z.literal("cancel"), call: id }),
  /** Whether the page's folder has this file with this content, see `BridgeProbe`. */
  z.object({ t: z.literal("probe"), probe: id, path: z.string().max(300), nonce: z.string() }),
  z.object({ t: z.literal("sessions"), sessions: z.array(session).max(1000) }),
  /** The projects AI tools wait for an editor to open, each once however many wait. */
  z.object({ t: z.literal("waiting"), waiting: z.array(waitingFor).max(100) }),
  z.object({ t: z.literal("ping") }),
]);
export type ToPage = z.infer<typeof toPage>;

/** A project as a page has it open. */
const pageProject = z.object({
  mode: z.enum(["online", "offline"]),
  /** What the page keeps it by: the id on the backend online, of the folder's record offline. */
  key: id,
  /** The id in animaquill.json. */
  id: z.string().max(200),
  name: z.string().max(500),
  /** Online: the address of the project, which `--project` takes. */
  link: z.string().max(2000).optional(),
});
export type PageProject = z.infer<typeof pageProject>;

/** What a page sends to the relay. */
export const fromPage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("page"),
    page: id,
    /** The browser, for people: "Chrome", "Edge". */
    browser: z.string().max(100),
    toolset: z.string().max(100),
    list: z.string().max(200),
    /** The project it has open, and whether it takes calls for it: one page in a browser does. */
    project: pageProject.optional(),
    serving: z.boolean(),
    /** It has the project open and cannot run calls on it: the browser does not let it at the folder. */
    blocked: z.literal("needs-permission").optional(),
    hidden: z.boolean(),
    /** When it was last in front, by its clock. */
    frontAt: z.number(),
  }),
  z.object({ t: z.literal("result"), call: id, result }),
  z.object({ t: z.literal("probed"), probe: id, found: z.boolean() }),
  z.object({ t: z.literal("pong") }),
]);
export type FromPage = z.infer<typeof fromPage>;

/** A result as it goes over the bridge, with its pictures in base64. */
export const bridgeResult = (
  done: ToolResult,
  images: readonly { readonly type: string; readonly data: string }[] = [],
): BridgeResult => ({
  text: done.text,
  isError: done.isError,
  ...(images.length > 0 && { images: [...images] }),
});

/** A message as one side reads it, or undefined for one it cannot. */
export function readMessage<T>(schema: z.ZodType<T>, raw: string): T | undefined {
  if (raw.length > BRIDGE_MAX_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A hash of a list of tools, to tell whether two sides list the same: FNV-1a of its JSON. */
export function listHash(list: unknown): string {
  const text = JSON.stringify(list);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${hash.toString(36)}`;
}
