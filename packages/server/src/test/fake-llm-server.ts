import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { testCertificates } from "./certificates.ts";
import { startFakeLlm } from "./fake-llm.ts";

/**
 * The pretend AI service of fake-llm.ts as a server, for the browser tests of the relay:
 * they start it on an address of its own, which the API finds by the name in
 * /etc/hosts there and connects to as to any service on the internet. Its certificate authority is
 * new each time, written to CA_OUT once the service listens, for the API to trust
 * (NODE_EXTRA_CA_CERTS). Tests see what it got at http://127.0.0.1:<CONTROL_PORT>:
 *
 * - `GET /_fake/state`: every request, with its headers and whether it was cut short.
 * - `POST /_fake/reset`: forgets them.
 */

const names = (process.env["LLM_NAMES"] ?? "llm.example").split(",");
const certificates = testCertificates(names);
const fake = await startFakeLlm({
  key: certificates.key,
  cert: certificates.cert,
  host: process.env["LLM_ADDRESS"] ?? "127.0.0.1",
  port: Number(process.env["LLM_PORT"] ?? "443"),
});

const control = createServer((request, response) => {
  if (request.url === "/_fake/state") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ seen: fake.seen, connections: fake.connections }));
  } else if (request.url === "/_fake/reset" && request.method === "POST") {
    fake.seen.length = 0;
    response.writeHead(204);
    response.end();
  } else {
    response.writeHead(404);
    response.end();
  }
});
control.listen(Number(process.env["CONTROL_PORT"] ?? "8401"), "127.0.0.1", () => {
  // All of it at once: whoever waits for the file reads it as soon as it is there.
  const out = process.env["CA_OUT"] ?? "/tmp/llm-ca.pem";
  writeFileSync(`${out}.part`, certificates.ca);
  renameSync(`${out}.part`, out);
});
