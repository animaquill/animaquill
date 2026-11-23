import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { parseAddress } from "../relay/addresses.ts";

/**
 * A DNS server for tests, over UDP: A and AAAA records from a table, "no such name" for what is not
 * in it, and nothing at all for a name it is told to be silent about, like a server that never
 * answers. Enough of the protocol for Node's resolver (c-ares), nothing more.
 */

export type FakeAnswer =
  | { readonly a?: readonly string[]; readonly aaaa?: readonly string[] }
  /** No answer at all. */
  | "silent"
  /** No such name. */
  | undefined;

export interface FakeDns {
  readonly port: number;
  /** The names asked for, in lower case, each time. */
  readonly asked: string[];
  close(): Promise<void>;
}

const A = 1;
const AAAA = 28;

/** The name of the question, as it is written in a query, and where the question ends. */
const questionOf = (query: Buffer): { name: string; type: number; end: number } | undefined => {
  const labels: string[] = [];
  let at = 12;
  while (at < query.length) {
    const length = query[at]!;
    if (length === 0) break;
    if (length > 63) return undefined;
    labels.push(query.subarray(at + 1, at + 1 + length).toString("latin1"));
    at += 1 + length;
  }
  if (at + 5 > query.length) return undefined;
  const type = query.readUInt16BE(at + 1);
  return { name: labels.join(".").toLowerCase(), type, end: at + 5 };
};

const bytesOf = (address: string, family: 4 | 6): Buffer => {
  const parsed = parseAddress(address);
  if (!parsed || parsed.family !== family)
    throw new Error(`not an IPv${family} address: ${address}`);
  const size = family === 4 ? 4 : 16;
  const out = Buffer.alloc(size);
  let value = parsed.value;
  for (let index = size - 1; index >= 0; index--) {
    out[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
};

export async function startFakeDns(options: {
  readonly answers: (name: string) => FakeAnswer;
  readonly host?: string;
  /** 0 for any. */
  readonly port?: number;
}): Promise<FakeDns> {
  const asked: string[] = [];
  const socket = createSocket("udp4");
  socket.on("message", (query, from) => {
    const question = questionOf(query);
    if (!question || query.length < 12) return;
    asked.push(question.name);
    const answer = options.answers(question.name);
    if (answer === "silent") return;
    const records =
      answer === undefined
        ? []
        : question.type === A
          ? (answer.a ?? []).map((address) => bytesOf(address, 4))
          : question.type === AAAA
            ? (answer.aaaa ?? []).map((address) => bytesOf(address, 6))
            : [];
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2);
    // A response, recursion as asked and available, and "no such name" for a name it does not know.
    const recursion = query[2]! & 0x01;
    header.writeUInt16BE(0x8080 | (recursion << 8) | (answer === undefined ? 3 : 0), 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(records.length, 6);
    const parts: Buffer[] = [header, query.subarray(12, question.end)];
    for (const data of records) {
      const record = Buffer.alloc(12);
      // The name of the question, by where it is in the message.
      record.writeUInt16BE(0xc00c, 0);
      record.writeUInt16BE(data.length === 4 ? A : AAAA, 2);
      record.writeUInt16BE(1, 4);
      record.writeUInt32BE(5, 6);
      record.writeUInt16BE(data.length, 10);
      parts.push(record, data);
    }
    socket.send(Buffer.concat(parts), from.port, from.address);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });
  return {
    port: (socket.address() as AddressInfo).port,
    asked,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}
