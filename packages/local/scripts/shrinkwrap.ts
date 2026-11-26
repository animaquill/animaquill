import { readFileSync, writeFileSync } from "node:fs";

/**
 * npm-shrinkwrap.json of the package `animaquill`: what npm installs with it, which is only the
 * PostgreSQL of the platform (`optionalDependencies`, of exact versions), with where each comes from
 * and its hash, as the workspace's lockfile has them. npm takes it as it is, for `npx animaquill`
 * too, so that nothing of another version, or of somewhere else, comes with the package. Written
 * again as the package is packed (`prepack`), and a test sees that the one in the repository is
 * this (src/shrinkwrap.test.ts).
 *   node scripts/shrinkwrap.ts
 */

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly bin: Record<string, string>;
  readonly engines: Record<string, string>;
  readonly optionalDependencies: Record<string, string>;
}

/** What the lockfile of pnpm says of a package of a version: its hash, and where it runs. */
function lockedOf(lock: string, name: string, version: string) {
  const start = lock.indexOf(`\n  '${name}@${version}':\n`);
  if (start < 0) throw new Error(`${name}@${version} is not in pnpm-lock.yaml`);
  const block = lock.slice(start + 1, lock.indexOf("\n\n", start + 1));
  const integrity = /integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(block)?.[1];
  const cpu = /\n {4}cpu: \[([^\]]*)\]/.exec(block)?.[1];
  const os = /\n {4}os: \[([^\]]*)\]/.exec(block)?.[1];
  const node = /engines: \{node: '([^']+)'\}/.exec(block)?.[1];
  if (!integrity || !cpu || !os)
    throw new Error(`pnpm-lock.yaml says too little of ${name}@${version}`);
  const list = (text: string) => text.split(",").map((each) => each.trim());
  return { integrity, cpu: list(cpu), os: list(os), node };
}

export function shrinkwrapOf(manifest: Manifest, lock: string): string {
  const packages: Record<string, unknown> = {
    "": {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      optionalDependencies: manifest.optionalDependencies,
      bin: manifest.bin,
      engines: manifest.engines,
    },
  };
  for (const [name, version] of Object.entries(manifest.optionalDependencies).toSorted()) {
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version))
      throw new Error(`${name} has to be of an exact version, not ${version}`);
    const locked = lockedOf(lock, name, version);
    const bare = name.split("/")[1];
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${bare}-${version}.tgz`,
      integrity: locked.integrity,
      cpu: locked.cpu,
      hasInstallScript: true,
      license: "MIT",
      optional: true,
      os: locked.os,
      ...(locked.node && { engines: { node: locked.node } }),
    };
  }
  const shrinkwrap = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };
  return `${JSON.stringify(shrinkwrap, null, 2)}\n`;
}

const here = (path: string) => new URL(path, import.meta.url);

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("shrinkwrap.ts")) {
  const manifest = JSON.parse(readFileSync(here("../package.json"), "utf8")) as Manifest;
  const lock = readFileSync(here("../../../pnpm-lock.yaml"), "utf8");
  writeFileSync(here("../npm-shrinkwrap.json"), shrinkwrapOf(manifest, lock));
}
