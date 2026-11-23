import { readFile } from "node:fs/promises";

/**
 * Which user of this computer has the other end of a connection to this one, where the system tells
 * (Linux: /proc/net/tcp): the relay takes pages and other `animaquill mcp` of its own user only. On
 * Windows and macOS this takes a tool of the system per connection, so nothing is told there and
 * the identity (`identity.ts`) and `Origin` stand alone (docs/design/mcp.md 13 of AnimaQuill Cloud).
 */

/** "0100007F:B8D4" to its port. */
const portOf = (address: string | undefined) => Number.parseInt(address?.split(":")[1] ?? "", 16);

/**
 * The user id of the socket at `remotePort` connected to `localPort`, undefined where it cannot be
 * told: off Linux, or where /proc says nothing of it.
 */
export async function ownerOf(
  localPort: number,
  remotePort: number,
  files: readonly string[] = ["/proc/net/tcp", "/proc/net/tcp6"],
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
      if (portOf(fields[1]) === remotePort && portOf(fields[2]) === localPort) {
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
