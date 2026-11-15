import { PROJECT_LIMITS, compare, parseTime } from "@animaquill/schema";
import { projectFrameRate, type ProjectState } from "../model.ts";
import { withId, type ProjectProblem } from "./model.ts";

/**
 * What animaquill.json says and what the files of the project have, apart: a version or a table of
 * strings of a language or format the manifest does not have (any more), a language other than the
 * master without strings, which two people changing the languages at once can leave behind; and a
 * manifest with more than the project's commands write (`PROJECT_LIMITS`), as a file written by hand
 * can have. The project opens all the same; these are for people to look at.
 */
export const MANIFEST_CODES = [
  "version-unlisted",
  "strings-unlisted",
  "language-without-strings",
  "manifest-over-limit",
] as const;

/** Where a version is about, as its scope says, or its name. */
function scopeOf(
  name: string,
  scope:
    { readonly language?: string | undefined; readonly format?: string | undefined } | undefined,
): { language?: string | undefined; format?: string | undefined } {
  if (scope && (scope.language !== undefined || scope.format !== undefined)) return scope;
  const [kind, first, second] = name.split(".");
  if (kind === "language") return { language: first };
  if (kind === "format") return { format: first };
  if (kind === "version") return { language: first, format: second };
  return {};
}

const isOver = (rate: string): boolean => {
  try {
    return compare(parseTime(rate), parseTime(String(PROJECT_LIMITS.fps))) > 0;
  } catch {
    return false;
  }
};

export function manifestProblems(state: ProjectState): readonly ProjectProblem[] {
  const { manifest } = state;
  const problems: ProjectProblem[] = [];
  const languages = new Set(manifest.languages.map(({ id }) => id));
  const formats = new Set(manifest.formats.map(({ id }) => id));

  for (const [timeline, { overrides }] of Object.entries(state.timelines)) {
    for (const [version, override] of Object.entries(overrides)) {
      const { language, format } = scopeOf(version, override.scope);
      const missing = [
        ...(language !== undefined && !languages.has(language) ? [`language:${language}`] : []),
        ...(format !== undefined && !formats.has(format) ? [`format:${format}`] : []),
      ];
      if (missing.length === 0) continue;
      problems.push(
        withId({
          source: "reference",
          severity: "warning",
          code: "version-unlisted",
          params: { version, missing: missing.join(" ") },
          subject: { kind: "timeline", id: timeline },
          file: `timelines/${timeline}/overrides/${version}.json`,
        }),
      );
    }
  }
  for (const language of Object.keys(state.locales)) {
    if (languages.has(language)) continue;
    problems.push(
      withId({
        source: "reference",
        severity: "warning",
        code: "strings-unlisted",
        params: { language },
        file: `locales/${language}.json`,
      }),
    );
  }
  for (const { id } of manifest.languages.slice(1)) {
    if (Object.hasOwn(state.locales, id)) continue;
    problems.push(
      withId({
        source: "reference",
        severity: "warning",
        code: "language-without-strings",
        params: { language: id },
        file: "animaquill.json",
      }),
    );
  }

  const over = (field: string, value: number | string, limit: number) => {
    if (typeof value === "number" && value <= limit) return;
    problems.push(
      withId({
        source: "format",
        severity: "warning",
        code: "manifest-over-limit",
        params: { field, value, limit },
        file: "animaquill.json",
      }),
    );
  };
  over("formats", manifest.formats.length, PROJECT_LIMITS.formats);
  over("languages", manifest.languages.length, PROJECT_LIMITS.languages);
  over("credits", manifest.credits?.length ?? 0, PROJECT_LIMITS.credits);
  over("description", [...(manifest.description ?? "")].length, PROJECT_LIMITS.description);
  const side = Math.max(0, ...manifest.formats.flatMap(({ width, height }) => [width, height]));
  over("side", side, PROJECT_LIMITS.side);
  const rates = [projectFrameRate(manifest), ...manifest.formats.map(({ fps }) => fps)];
  const fast = rates.find(isOver);
  if (fast !== undefined) over("fps", fast, PROJECT_LIMITS.fps);
  return problems;
}
