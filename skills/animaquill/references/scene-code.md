# Change the code of a scene

A scene is a folder `scenes/<id>/` with `scene.json` (its name, entry file and parameters) and its HTML, CSS and JavaScript. Code that several scenes share is in `code/`.

1. `aq_file_read` on the entry file (`scenes/<id>/index.html` in most projects) and on the scripts it loads. `aq_guide` with `scene-runtime/...` has what the code gets: `aq.frame` for drawing each frame, `aq.param` for the parameters, and the rules a scene keeps to so that preview and export show the same.
2. Change the code with `aq_file_edit` (exact text, replaced) or your own file tools. A new file of the scene goes in its folder; `aq_file_write` writes a whole file.
3. A new parameter, or a new entry file, is a change of `scene.json`: `scene.update` in `aq_edit`, not an edit of the JSON. A new scene is `scene.add`, with its files in the same operation.
4. `aq_check_run`. The scene runs only in the editor, while one of its clips is in the preview: say so to the user, so that they look at it there.

Scenes run in a sandbox: no network, no storage, no other page. Fonts and pictures come from the project's assets.
