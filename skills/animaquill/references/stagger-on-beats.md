# Space clips out on the beats

Clips that come in one after another, such as the words of a title or a row of pictures, look right when each starts on a beat of the music, or a fixed share of a beat after the one before.

1. `aq_object_read` with the id of the timeline and `fields: ["beatGrid", "markers"]`. The beat grid is a list of segments, each with a `start`, a `bpm` and a `meter`; a beat lasts `60 / bpm` seconds from the start of its segment. A timeline without a grid may still have markers where the music has its accents, or the user says the tempo.
2. `aq_timeline_read` for the clips to space out, in the order they are to come.
3. Work out each start: the first on the beat the user names, each next one a beat (or half a beat) later. Times are strings in seconds, exact: write `"10.5"`, or a fraction such as `"20/3"` where a beat is no round number.
4. One `aq_edit` batch with `clip.move` for all of them, so that it is one step to undo:

   ```json
   [{"op": "clip.move", "timeline": "main", "clips": [
     {"clip": "clip_word1", "start": "10"},
     {"clip": "clip_word2", "start": "10.5"},
     {"clip": "clip_word3", "start": "11"}
   ]}]
   ```

   The ids and times are examples. Clips in the way make the batch fail with `overlap`; the result says which.
5. Keys inside each clip move with it: their times are on the clip's own clock.

`aq_guide` with `howto/times` has how times are written and which clock each time is on.
