import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

/**
 * What the npm package has of other people's code, with their licenses: the server and the command
 * line are one file that holds what they take from other packages, and MIT, Apache-2.0 and the like
 * ask that their notices go along with it. Next to that file, as THIRD_PARTY_LICENSES.txt.
 */

export const LICENSES_FILE = "THIRD_PARTY_LICENSES.txt";

/** A package that went into the bundle. */
export interface BundledPackage {
  readonly name: string;
  readonly version: string;
  /** As its package.json says. */
  readonly license: string;
  /** Its LICENSE, NOTICE and the like, by file name. */
  readonly texts: readonly { readonly file: string; readonly text: string }[];
}

const NOTICE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** The package a module is of, from its file up: undefined for code of this workspace. */
function packageOf(module: string, known: Map<string, string | undefined>): string | undefined {
  if (!module.includes("/node_modules/")) return undefined;
  let folder = dirname(module);
  const seen: string[] = [];
  for (;;) {
    const cached = known.get(folder);
    if (cached !== undefined || known.has(folder)) {
      for (const each of seen) known.set(each, cached);
      return cached;
    }
    seen.push(folder);
    const manifest = join(folder, "package.json");
    if (existsSync(manifest)) {
      const { name, version } = JSON.parse(readFileSync(manifest, "utf8")) as Record<
        string,
        unknown
      >;
      if (typeof name === "string" && typeof version === "string") {
        for (const each of seen) known.set(each, folder);
        return folder;
      }
    }
    const up = dirname(folder);
    if (up === folder || folder.endsWith("/node_modules")) {
      for (const each of seen) known.set(each, undefined);
      return undefined;
    }
    folder = up;
  }
}

const MIT = (holder: string) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/**
 * The license of a package that brings no file of it, written out from what its package.json says:
 * MIT with its author, the text of Apache-2.0 (licenses/Apache-2.0.txt). Others stay as they are
 * said.
 */
function writtenOut(license: string, author: unknown, name: string) {
  const holder =
    typeof author === "string"
      ? author
      : typeof (author as { name?: unknown } | undefined)?.name === "string"
        ? (author as { name: string }).name
        : `the authors of ${name}`;
  const file = "LICENSE (as its package.json says; the package has no file of it)";
  if (license === "MIT") return [{ file, text: MIT(holder) }];
  if (license === "Apache-2.0")
    return [
      {
        file,
        text: readFileSync(new URL("../licenses/Apache-2.0.txt", import.meta.url), "utf8").trim(),
      },
    ];
  return [];
}

/** The packages of these modules, with their licenses, by name. */
export function bundledPackages(modules: Iterable<string>): BundledPackage[] {
  const known = new Map<string, string | undefined>();
  const folders = new Set<string>();
  for (const module of modules) {
    if (module.startsWith("\0")) continue;
    const folder = packageOf(module.split("?")[0] as string, known);
    if (folder) folders.add(folder);
  }
  const packages = [...folders].map((folder) => {
    const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as {
      name: string;
      version: string;
      license?: unknown;
      author?: unknown;
    };
    const found = readdirSync(folder)
      .filter((file) => NOTICE_FILE.test(file))
      .toSorted()
      .map((file) => ({ file, text: readFileSync(join(folder, file), "utf8").trim() }));
    const license = typeof manifest.license === "string" ? manifest.license : "UNKNOWN";
    const texts = found.length > 0 ? found : writtenOut(license, manifest.author, manifest.name);
    return {
      name: manifest.name,
      version: manifest.version,
      license,
      texts,
    };
  });
  const unique = new Map(packages.map((each) => [`${each.name}@${each.version}`, each]));
  return [...unique.values()].toSorted((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
}

/** The file itself. */
export function licensesText(packages: readonly BundledPackage[]): string {
  const head = [
    "The files of this package hold code of the following packages, under their own licenses.",
    "AnimaQuill itself is under AGPL-3.0-only, see LICENSE.",
    "",
  ];
  const parts = packages.map(({ name, version, license, texts }) =>
    [
      `${"=".repeat(78)}`,
      `${name}@${version} (${license})`,
      `${"=".repeat(78)}`,
      ...(texts.length === 0
        ? [`No license file comes with this package; its package.json says ${license}.`]
        : texts.flatMap(({ file, text }) => [`--- ${file} ---`, text, ""])),
    ].join("\n"),
  );
  return `${[...head, ...parts].join("\n")}\n`;
}

/**
 * What comes with the package besides the bundle, written out as it is: the PostgreSQL that npm
 * installs next to it (licenses/postgresql.txt), whose packages do not say all of it.
 */
const BESIDES = [new URL("../licenses/postgresql.txt", import.meta.url)];

/** Writes THIRD_PARTY_LICENSES.txt for every chunk of the build. */
export function thirdPartyLicenses(): Plugin {
  return {
    name: "animaquill-third-party-licenses",
    generateBundle(_options, bundle) {
      const modules = Object.values(bundle).flatMap((output) =>
        output.type === "chunk" ? output.moduleIds : [],
      );
      this.emitFile({
        type: "asset",
        fileName: LICENSES_FILE,
        source: [
          licensesText(bundledPackages(modules)),
          ...BESIDES.map((file) => readFileSync(file, "utf8")),
        ].join("\n"),
      });
    },
  };
}
