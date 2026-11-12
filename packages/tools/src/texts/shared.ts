import type { TextTable } from "./table.ts";

/** What the types that several operations share are, by the name they have in `$defs`. */
export const TYPE_TEXTS = {
  "types.Animation": 'Keyframes: {"keys":[…]}.',
  "types.ClipSource": "What a clip shows or plays.",
  "types.Handle": "A bezier handle [x, y], x from 0 to 1.",
  "types.Key":
    'A keyframe: {"time":"<seconds>","value":…}, with how it goes on to the next one. time is on the clip\'s clock, which reads the clip\'s offset (0 by default) at its first frame.',
  "types.MediaRef": 'A file: {"asset":"<asset id>"}, or {"library":"<library id>","path":"…"}.',
  "types.PropertyEdit":
    "One edit of a property of a clip. Its times (time, times, moves) are on the clip's clock, as the times of keys are: it reads the clip's offset (0 by default) at the clip's first frame.",
  "types.PropertyPath": 'The path of a property, such as "transform.x" or "param.title".',
  "types.PropertyRename": "Another path for properties of a clip.",
  "types.PropertyValue":
    'A value of a property, or {"keys":[{"time":"0","value":0},…]} with keyframes.',
  "types.SceneManifest": "What a scene is, as its scene.json says.",
  "types.SoundManifest": "What a sound is, as its sound.json says.",
  "types.SpeedCurve": "How it speeds up and slows down: [x1, y1, x2, y2] as in CSS cubic-bezier().",
  "types.Transition":
    'A transition at the edge of a clip, such as {"type":"fade","duration":"0.5"}.',
  "types.TypeName":
    'The name of a kind of effect or transition, such as "blur" or "plugin.effect".',
  "types.Value": "A plain value: a number, a string, true or false, numbers, text or a file.",
} satisfies TextTable;
