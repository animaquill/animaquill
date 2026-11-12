import {
  PROPERTY_CODES,
  UNSUPPORTED_CODES,
  type ProjectProblem,
  type ProjectState,
} from "@animaquill/core";
import { objectText } from "./context.ts";
import { HAS_CHINESE } from "./issues.ts";

/**
 * Problems as AI reads them, one line each: E for errors, W for warnings, C for checks, the code,
 * what it is about and where, in English from its code and parameters. What code threw is data,
 * not words of ours: it comes last, as it was, quoted.
 */

type Params = Readonly<Record<string, string | number>>;

const str = (value: unknown) => String(value ?? "");

/** The words of problems that the project alone tells, by code. */
export const PROBLEM_TEXTS: Readonly<Record<string, (params: Params) => string>> = {
  "unsupported-music-clip": () =>
    "music clips do not play in this editor version yet: no sound in preview or export",
  "unsupported-timeline-clip": (p) =>
    `nested timeline ${str(p.timeline)} does not show in this editor version yet`,
  "unsupported-library": (p) =>
    `uses library ${str(p.library)}, which this editor version cannot read yet: missing from preview and export`,
  "unsupported-caption-display": (p) =>
    `${str(p.count)} captions on this track do not show in this editor version yet, nor in exported video`,
  "unsupported-audio-effect": (p) =>
    p.where === "mix"
      ? "the mix (buses and master) is not applied by this editor version yet"
      : `${str(p.count)} sound effects on this ${str(p.where)} are not applied by this editor version yet`,
  "unsupported-audio-property": (p) =>
    `${str(p.property)} is not applied by this editor version yet; preview and export ignore it`,
  "unsupported-volume-keys": () =>
    "keyframes of the volume are not applied by this editor version yet: the first one holds",
  "unsupported-loop": () =>
    "loop is not applied by this editor version yet: the media does not start again",
  "unsupported-draft": () => "a draft clip still shows and exports in this editor version",
  "unsupported-override": (p) =>
    `the changes of version ${str(p.version ?? p.format ?? p.language)} are not applied by this editor version yet`,
  "property-orphan": (p) =>
    `nothing in the scene takes ${str(p.path)}, so its keyframes do nothing; rename it to a path the scene has, or remove it`,
  "property-orphan-element": (p) =>
    `the scene page has no element for ${str(p.path)} right now, so its keyframes wait for it`,
  "property-renamed": (p) =>
    `${str(p.from)} is now ${str(p.to)}; the keyframes still work under the old path`,
  "property-mismatch": (p) =>
    `the value of ${str(p.path)} is no ${str(p.type)}, so the default applies`,
  "scene-param-id": (p) =>
    `the id of parameter ${JSON.stringify(str(p.name))} cannot be a property path: use letters, digits, _ and -`,
  "scene-registration": (p) =>
    `the scene registers ${str(p.target) || "something"} in a way the editor cannot use (${str(p.problem)})`,
  "scene-error": () => "the code threw an error",
  "scene-rejection": () => "a promise of the code was rejected and nothing handled it",
  "scene-loader": () => "the scene could not load",
  "scene-resource": () => "a file the scene asked for did not load",
  "scene-blocked": () => "the scene asked for something it may not have",
  "scene-api": (p) => `the scene used the runtime in a way it does not take (${str(p.code)})`,
  "scene-stopped": () => "the scene stopped for good and shows nothing",
  "handles-flood": () => "the scene draws too many handles; some are left out",
  "editor-diagnostic": () => "the code editor reports this",
  "folder-file": () => "a file of the project folder could not come in",
  "import-note": () => "the import notes this",
};

/** All codes the project alone tells, which have to have words here. */
export const STATIC_PROBLEM_CODES: readonly string[] = [...UNSUPPORTED_CODES, ...PROPERTY_CODES];

const LETTERS = { error: "E", warning: "W", check: "C" } as const;

/** One problem as one line, with what fixes it on a line of its own. */
export function problemLines(state: ProjectState, problem: ProjectProblem): readonly string[] {
  const { severity, code, params, subject, file, line, column, place, detail, fix } = problem;
  const words = PROBLEM_TEXTS[code]?.(params) ?? code.replaceAll("-", " ");
  const about = subject ? ` ${objectText(state, subject)}` : "";
  const where = file
    ? ` ${file}${line !== undefined ? `:${line}${column !== undefined ? `:${column}` : ""}` : ""}`
    : "";
  const at = place !== undefined && !file ? ` at ${place}` : "";
  // What the code said is data: as it was, unless it is in a language the words here are not.
  const said = detail === undefined ? "" : ` | said: ${JSON.stringify(detail.slice(0, 300))}`;
  const quoted = HAS_CHINESE.test(said) && problem.source !== "runtime" ? "" : said;
  const lines = [`${LETTERS[severity]} ${code}${about}${where}${at}: ${words}${quoted}`];
  if (fix) lines.push(`  fix: ${JSON.stringify({ op: fix.type, ...(fix.params as object) })}`);
  return lines;
}
