import { stringifyDocument } from "./json.ts";
import { MANIFEST_FILE, type ProjectFiles } from "./project.ts";
import { CURRENT_FORMAT_VERSION } from "./version.ts";

/** Takes the files of one format version to the next. Works on text, without today's schemas. */
export interface Migration {
  readonly from: number;
  readonly migrate: (files: Map<string, string>) => void;
}

/** One entry for every format version there has been. Never change an entry that shipped. */
export const MIGRATIONS: readonly Migration[] = [];

export type MigrationResult =
  | { readonly kind: "current" }
  | { readonly kind: "migrated"; readonly from: number; readonly files: Map<string, string> }
  | { readonly kind: "too-new"; readonly version: number }
  | { readonly kind: "no-path"; readonly from: number }
  | { readonly kind: "unreadable" };

function versionIn(files: ProjectFiles): number | undefined {
  try {
    const manifest = JSON.parse(files.get(MANIFEST_FILE) ?? "") as { formatVersion?: unknown };
    return Number.isInteger(manifest.formatVersion)
      ? (manifest.formatVersion as number)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Brings a project to the current format. The result is new files: the input stays untouched. */
export function migrateProject(
  files: ProjectFiles,
  migrations: readonly Migration[] = MIGRATIONS,
  current: number = CURRENT_FORMAT_VERSION,
): MigrationResult {
  const version = versionIn(files);
  if (version === undefined) return { kind: "unreadable" };
  if (version === current) return { kind: "current" };
  if (version > current) return { kind: "too-new", version };

  const result = new Map(files);
  for (let from = version; from < current; from++) {
    const step = migrations.find((migration) => migration.from === from);
    if (!step) return { kind: "no-path", from };
    step.migrate(result);
    const manifest = JSON.parse(result.get(MANIFEST_FILE) ?? "{}") as Record<string, unknown>;
    manifest["formatVersion"] = from + 1;
    result.set(MANIFEST_FILE, stringifyDocument(manifest));
  }
  return { kind: "migrated", from: version, files: result };
}
