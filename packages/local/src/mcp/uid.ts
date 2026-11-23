import { readFile } from "node:fs/promises";

/**
 * Which user of this computer has the other end of a connection to this one, where the system tells
 * (Linux: /proc/net/tcp): the relay takes pages and other `animaquill mcp` of its own user only. On
 * Windows and macOS this takes a tool of the system per connection, so nothing is told there and
 * the identity (`identity.ts`) and `Origin` stand alone (docs/design/mcp.md 13 of AnimaQuill Cloud).
 */

/** "0100007F:B8D4" to its port. */
const portOf = (address: string | undefined) => Number.parseInt(address?.split(":")[1] ?? "", 16);

/** 127.0.0.1 as /proc/net/tcp writes it: the relay listens there, and pages and peers come from it. */
export const LOOPBACK_HEX = "0100007F";

const hostOf = (address: string | undefined) => address?.split(":")[0]?.toUpperCase();

/**
 * The user id of the socket at 127.0.0.1:`remotePort` connected to 127.0.0.1:`localPort`,
 * undefined where it cannot be told: off Linux, or where /proc says nothing of it. The relay listens
 * on IPv4 only, so /proc/net/tcp has every connection to it.
 */
export async function ownerOf(
  localPort: number,
  remotePort: number,
  files: readonly string[] = ["/proc/net/tcp"],
): Promise<number | undefined> {
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid ...
      // Both ends at 127.0.0.1: another loopback address with the same ports is someone else's.
      if (
        portOf(fields[1]) === remotePort &&
        portOf(fields[2]) === localPort &&
        hostOf(fields[1]) === LOOPBACK_HEX &&
        hostOf(fields[2]) === LOOPBACK_HEX
      ) {
        const uid = Number(fields[7]);
        if (Number.isInteger(uid)) return uid;
      }
    }
  }
  return undefined;
}

/** Whether the other end may be let in: its user is ours, or this system does not tell. */
export async function isOwnUser(localPort: number, remotePort: number): Promise<boolean> {
  if (process.platform !== "linux" || typeof process.getuid !== "function") return true;
  const owner = await ownerOf(localPort, remotePort);
  // Linux always tells of a connection on this computer: one it does not know of is refused.
  return owner === process.getuid();
}
