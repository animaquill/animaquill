# Fix what the check reports

`aq_check_run` lists problems of the project with a code, what they are about, and why: an error stops an export from being right, a warning is something that does not work as written, a check is a reminder.

1. `aq_check_run`, with `severity: ["error"]` first where there are many.
2. For each problem, read what it is about: `aq_object_read` on the clip, track or scene it names, or `aq_file_read` on the file.
3. Change only what the problem is about. Common ones:
   - `asset-missing`, `scene-missing`, `sound-missing`: a clip shows something the project does not have. Point the clip at what it should show (`clip.update` with a new `source`, or `source.replace` for every clip that shows the same missing thing), or remove the clip (`clip.remove`) when the user agrees.
   - `invalid-document` (from `format`): a file of the project does not fit the format, often after it was written by hand. `aq_check_run` says where; the file is fixed as text, then it comes into the project again.
   - `time-off-grid`: times between frames of the project's frame rate. Moving the clips onto frames is a choice for the user, as playing and exporting work as they are.
   - Codes that start with `unsupported-`: the project uses something this version of the editor does not do yet. Nothing in the project is wrong; they stay unless the user wants another way.
4. `aq_check_run` again: the problem is gone when its line is.

Scene code runs only in the editor: errors it throws show in `aq_check_run` there, not through the MCP server. What the code does on screen is for the user to look at in the editor.
