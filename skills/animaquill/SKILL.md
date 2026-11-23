---
name: animaquill
description: Work on an AnimaQuill video project (open in the AnimaQuill editor; offline, a folder with animaquill.json) through the aq_ tools of the animaquill MCP server - put scene clips on a timeline and animate them with keyframes, space clips out on the beats, fix what aq_check_run reports, change the HTML, CSS and JavaScript of scenes. Use when the user asks to edit, animate, time or fix an AnimaQuill project.
license: AGPL-3.0-only
---

# Working on an AnimaQuill project

An AnimaQuill project has timelines of clips, HTML scenes, sounds made by code, and the assets they use; offline it is a folder with `animaquill.json` at its top, online it is on a server. The `animaquill` MCP server (`npx -y animaquill@latest mcp`, started in the project folder for an offline one) has the tools for it, which run in the AnimaQuill editor the user has open in the browser. In Claude Code they show as `mcp__animaquill__aq_edit` and so on; this skill calls them by their own names.

## How changes are made

- Timelines, tracks, clips, keyframes, transitions, effects and markers change with `aq_edit`, one batch of operations at a time. Writing the JSON files of the project yourself skips the checks: a file that does not fit the format stays out of the editor, and a change the editor makes at the same time can be lost.
- Code of scenes and sounds, under `scenes/`, `sounds/` and `code/`, is text. `aq_file_edit` changes it by replacing exact text, as your own file tools do.
- `aq_edit` and the file tools check what they change against what you read: read an object (`aq_timeline_read`, `aq_object_read`, `aq_file_read`) before you change it, and again after a result says that somebody else changed it.
- Each batch of `aq_edit` is one step that the user can undo in the editor. Changes that belong together go in one batch.
- `aq_check_run` lists what is wrong with the project after a change. Scene code only runs in the editor: what a scene throws shows there, not here.
- The manual is `aq_guide`: a page for every operation (`ops/clip.add`), how-to pages (`howto/keyframes`, `howto/times`, `howto/scene-code`), the project format (`format/...`) and the scene runtime (`scene-runtime/...`).

## Start

1. `aq_project_status` for what the project is, then `aq_timeline_read` for the timeline you work on.
2. Do the task with the procedure that fits it:
   - [Put a scene clip on the timeline and animate it](references/scene-clip-keyframes.md)
   - [Space clips out on the beats](references/stagger-on-beats.md)
   - [Fix what the check reports](references/fix-check-problems.md)
   - [Change the code of a scene](references/scene-code.md)
3. `aq_check_run`, and tell the user what changed, by the names of the objects.

The project's own `AGENTS.md`, where it has one, says how this project is done: its style, its fonts, what to keep. It goes before the general ways here.
