import { BRIDGE_PROTOCOL } from "@animaquill/tools";
import { z } from "zod";

/**
 * What the `animaquill mcp` of one user say to each other (docs/design/online-offline.md of
 * AnimaQuill Cloud, 5.1): a peer proves that it can read the key of the user, the relay proves the
 * same back, and then the peer's sessions and calls go to the relay's router. Every message is
 * checked: a peer of another version, or anything else, is let go of, and takes nothing down.
 */

/** What a peer signs to prove the key: the relay's nonce, for this protocol, at this port. */
export const peerProof = (nonce: string, port: number): string =>
  `peer\n${BRIDGE_PROTOCOL}\n${port}\n${nonce}`;

/** What the relay signs back: the peer's nonce, the same way. */
export const relayProof = (nonce: string, port: number): string =>
  `relay\n${BRIDGE_PROTOCOL}\n${port}\n${nonce}`;

const id = z.string().min(1).max(200);
const client = z.object({ name: z.string().max(200), version: z.string().max(200).optional() });
const project = z.object({
  mode: z.enum(["online", "offline"]),
  key: id,
  id: z.string().max(200),
  name: z.string().max(500),
  link: z.string().max(2000).optional(),
});

const target = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("folder"),
    id: z.string().max(200),
    name: z.string().max(500).optional(),
    root: z.string().max(4096),
    probe: z.object({ path: z.string().max(300), nonce: z.string().max(200) }),
  }),
  z.object({ kind: z.literal("link"), origin: z.string().max(2000), project: id }),
  z.object({
    kind: z.literal("front"),
    bound: z.object({ origin: z.string().max(2000), project }).optional(),
  }),
]);

const request = z.object({
  call: id,
  session: id,
  answer: id,
  tool: z.string().max(100),
  args: z.unknown(),
  again: z.boolean().optional(),
});

/** What a peer sends, once both proved the key. */
export const fromPeer = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("session"),
    info: z.object({ session: id, client: client.optional(), target, since: z.number() }),
  }),
  z.object({ t: z.literal("end"), session: id }),
  z.object({ t: z.literal("call"), request }),
  z.object({ t: z.literal("cancel"), call: id }),
]);

export const peerHello = z.object({
  t: z.literal("peer-hello"),
  nonce: z.string().min(16).max(100),
  protocol: z.literal(BRIDGE_PROTOCOL),
});

export const peerAuth = z.object({
  t: z.literal("peer-auth"),
  nonce: z.string().min(16).max(100),
  mac: z.string().max(200),
  protocol: z.literal(BRIDGE_PROTOCOL),
});

export const peerOk = z.object({ t: z.literal("peer-ok"), mac: z.string().max(200) });

/** A message read with a schema, or undefined for anything else. */
export function readPeer<T>(schema: z.ZodType<T>, raw: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const result = z.object({
  text: z.string(),
  isError: z.boolean(),
  images: z.array(z.object({ type: z.string(), data: z.string() })).optional(),
});

/** What the relay says of a peer's call: that it went to a page, and its answer. */
export const toPeer = z.discriminatedUnion("t", [
  z.object({ t: z.literal("dispatched"), call: id }),
  z.object({ t: z.literal("progress"), call: id, message: z.string().max(500) }),
  z.object({
    t: z.literal("answer"),
    call: id,
    answer: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("result"),
        result,
        bound: z.object({ origin: z.string(), project }),
      }),
      z.object({ kind: z.literal("no-page"), gaveUp: z.literal(true).optional() }),
      z.object({
        kind: z.literal("opening"),
        name: z.string().max(500),
        how: z.enum(["opened", "asked"]),
      }),
      z.object({ kind: z.literal("needs-permission"), name: z.string().max(500) }),
      z.object({ kind: z.literal("gone") }),
    ]),
  }),
]);
