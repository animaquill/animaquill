# Put a scene clip on the timeline and animate it

A scene is HTML, CSS and JavaScript that draws the picture of its clips. A clip shows a scene for a while on a video track, and its properties (position, scale, opacity, the scene's own parameters) can change over time with keyframes.

1. `aq_timeline_read` for the timeline: its tracks, and where the clips are. Pick a video track and a start where nothing is in the way, or say which clip the new one covers.
2. `aq_search` with `kinds: ["scene"]` for the scenes the project has. A new scene comes with `scene.add` (see [Change the code of a scene](scene-code.md)).
3. One `aq_edit` batch with the clip and its keys:

   ```json
   [
     {"op": "clip.add", "timeline": "main", "track": "track_video", "id": "clip_headline",
      "start": "31", "duration": "4", "source": {"kind": "scene", "scene": "title"}},
     {"op": "property.edit", "timeline": "main", "edits": [
       {"owner": {"clip": "clip_headline"}, "path": "transform.scale", "op": "set",
        "value": {"keys": [{"time": "0", "value": 0.8, "interp": "bezier", "out": [0.42, 0]},
                           {"time": "1", "value": 1, "in": [0.58, 1]}]}}
     ]}
   ]
   ```

   The ids, track and times are examples. Times of keys are readings of the clip's own clock: `"0"` is where the clip starts, whatever its start on the timeline.
4. For the scene's own parameters, `aq_object_read` on the clip lists the properties the scene describes (`param.<id>`), with their types and ranges. They take keys the same way.
5. `dry_run: true` shows what a batch would do without doing it, which helps when it covers or removes something.

`aq_guide` with `howto/keyframes` has the kinds of keys (`linear`, `bezier`, `hold`) and what comes after the last key.
