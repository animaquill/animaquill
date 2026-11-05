import { z } from "zod";
import {
  Assets,
  Libraries,
  LibrariesLock,
  Locale,
  Notes,
  ProjectManifest,
  SceneManifest,
  SoundManifest,
} from "./documents.ts";
import { Overrides, Timeline } from "./timeline.ts";

const DOCUMENTS: Readonly<Record<string, z.ZodType>> = {
  project: ProjectManifest,
  assets: Assets,
  libraries: Libraries,
  "libraries-lock": LibrariesLock,
  notes: Notes,
  timeline: Timeline,
  overrides: Overrides,
  scene: SceneManifest,
  sound: SoundManifest,
  locale: Locale,
};

/** The public definition of every document, for other tools and for AI tools to check against. */
export function jsonSchemas(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(DOCUMENTS).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", reused: "ref" }),
    ]),
  );
}
