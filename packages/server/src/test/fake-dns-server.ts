import { startFakeDns } from "./fake-dns.ts";

/**
 * The DNS of the browser tests: the relay asks DNS servers itself and does not
 * read /etc/hosts (src/relay/network.ts), so the names it goes to in there are here, as
 * DNS_NAMES="llm.example=11.22.33.44,editor.example.com=127.0.0.1", on port 53 of the loopback,
 * which /etc/resolv.conf names. Everything else is not there at all.
 */

const table = new Map<string, string[]>();
for (const pair of (process.env["DNS_NAMES"] ?? "").split(",").filter(Boolean)) {
  const [name, address] = pair.split("=");
  if (!name || !address) throw new Error(`not a name=address: ${pair}`);
  table.set(name.toLowerCase(), [...(table.get(name.toLowerCase()) ?? []), address]);
}
await startFakeDns({
  port: Number(process.env["DNS_PORT"] ?? "53"),
  answers: (name) => {
    const addresses = table.get(name);
    return addresses && { a: addresses.filter((address) => !address.includes(":")) };
  },
});
console.log(`answering for ${[...table.keys()].join(", ")}`);
