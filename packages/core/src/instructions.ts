import { INSTRUCTIONS_FILE } from "./import-file.ts";

/**
 * How AGENTS.md of a new project starts: what the project is, where the manual is, how changes are
 * made and checked. It points the way and says nothing that changes with a version of the editor,
 * so it stays right as it is. Below it go the ways of this project, which people and AI add.
 * English, as everything AnimaQuill says to AI.
 */
export const INSTRUCTIONS_START = `# Instructions for AI

This folder is an AnimaQuill project: a video made of timelines, clips, HTML scenes and code. The project format and the scene runtime are described in the AnimaQuill manual, which the aq_guide tool reads (topics "format/..." and "scene-runtime/...").

- Timelines, clips, keyframes, transitions and effects are changed with the aq_edit tool, not by writing their JSON files: aq_edit checks every change against the format and what others changed, and the user can undo it as one step.
- Code of scenes and sounds (files under scenes/, sounds/ and code/) and this file are text: aq_file_edit changes them, and so do your own file tools where you have them.
- After a change, aq_check_run lists what is wrong with the project.

## This project

`;

/** The files a new project starts with, besides its documents. */
export const startingFiles = (): Readonly<Record<string, string>> => ({
  [INSTRUCTIONS_FILE]: INSTRUCTIONS_START,
});
