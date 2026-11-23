import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestCertificates {
  /** The authority, which whoever connects has to trust. */
  readonly ca: string;
  readonly key: string;
  readonly cert: string;
}

/**
 * An authority of its own, and a certificate from it for these names, for servers that stand in
 * for services on the internet: made new each time with openssl, so that no key is kept anywhere.
 */
export function testCertificates(names: readonly string[]): TestCertificates {
  const folder = mkdtempSync(join(tmpdir(), "aq-certificates-"));
  const run = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: folder, stdio: ["ignore", "ignore", "pipe"] });
  const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  try {
    run(
      "req",
      "-x509",
      ...key,
      "-days",
      "3650",
      "-subj",
      "/CN=AnimaQuill test authority",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
    );
    run("req", ...key, "-subj", `/CN=${names[0]}`, "-keyout", "server.key", "-out", "server.csr");
    writeFileSync(
      join(folder, "server.ext"),
      [
        `subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}`,
        "basicConstraints=CA:FALSE",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=serverAuth",
        "",
      ].join("\n"),
    );
    run(
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "3650",
      "-extfile",
      "server.ext",
      "-out",
      "server.pem",
    );
    const read = (name: string) => readFileSync(join(folder, name), "utf8");
    return { ca: read("ca.pem"), key: read("server.key"), cert: read("server.pem") };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
