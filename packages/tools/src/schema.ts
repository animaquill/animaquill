import { OPERATIONS, PropertyEdit, PropertyRename, type Operation } from "@animaquill/core";
import {
  Animation,
  ClipSource,
  Color,
  Duration,
  ExtensionName,
  Handle,
  Id,
  Key,
  MediaRef,
  PropertyPath,
  PropertyValue,
  SceneManifest,
  SoundManifest,
  Time,
  Transition,
  TransitionCurve,
  Value,
} from "@animaquill/schema";
import { z } from "zod";
import { paramWords } from "./docs/params.ts";
import type { JsonSchema } from "./types.ts";

/** The operations AI can use, in the order of the registry. */
export const AI_OPERATIONS: readonly Operation[] = (OPERATIONS as readonly Operation[]).filter(
  (op) => op.ai === "yes",
);

/** Where the types that several operations share sit: in the schema of `operations` itself. */
export const DEFS_AT = "#/properties/operations/$defs/";

/**
 * Types that several operations share, by a name that says what they are. They go into `$defs` of
 * the parameter `operations`, not of the whole schema: pi gives Anthropic only `type`, `properties`
 * and `required` of the top of a schema, and references to `$defs` there would point at nothing.
 */
const SHARED: readonly (readonly [z.ZodType, string, string])[] = [
  [
    ExtensionName,
    "TypeName",
    'The name of a kind of effect or transition, such as "blur" or "plugin.effect".',
  ],
  [PropertyPath, "PropertyPath", 'The path of a property, such as "transform.x" or "param.title".'],
  [
    MediaRef,
    "MediaRef",
    'A file: {"asset":"<asset id>"}, or {"library":"<library id>","path":"…"}.',
  ],
  [Value, "Value", "A plain value: a number, a string, true or false, numbers, text or a file."],
  [Handle, "Handle", "A bezier handle [x, y], x from 0 to 1."],
  [
    Key,
    "Key",
    'A keyframe: {"time":"<seconds from the start of the clip>","value":…}, with how it goes on to the next one.',
  ],
  [Animation, "Animation", 'Keyframes: {"keys":[…]}.'],
  [
    TransitionCurve,
    "SpeedCurve",
    "How it speeds up and slows down: [x1, y1, x2, y2] as in CSS cubic-bezier().",
  ],
  [ClipSource, "ClipSource", "What a clip shows or plays."],
  [
    Transition,
    "Transition",
    'A transition at the edge of a clip, such as {"type":"fade","duration":"0.5"}.',
  ],
  [
    PropertyValue,
    "PropertyValue",
    'A value of a property, or {"keys":[{"time":"0","value":0},…]} with keyframes.',
  ],
  [PropertyEdit, "PropertyEdit", "One edit of a property of a clip."],
  [PropertyRename, "PropertyRename", "Another path for properties of a clip."],
  [SceneManifest, "SceneManifest", "What a scene is, as its scene.json says."],
  [SoundManifest, "SoundManifest", "What a sound is, as its sound.json says."],
];

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Strings that the descriptions of parameters say how to write: their patterns would only take room,
 * and the tools check them anyway, saying how they go.
 */
const PLAIN_STRINGS: ReadonlySet<z.ZodType> = new Set([Id, Time, Duration, Color]);

/** Limits of strings and lists, which the tools check and say, and which take room here. */
const LIMITS: ReadonlySet<string> = new Set(["minLength", "maxLength", "maxItems"]);

/**
 * Moves references to `$defs` at the top to where they are now, and leaves out what only takes room:
 * a type next to a constant, and that objects take no other fields below the operations themselves,
 * which the tools check and say.
 */
function rehome(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((item) => rehome(item, depth));
  if (!isNode(value)) return value;
  const node: Node = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "additionalProperties" && item === false && depth > 0) continue;
    if (key === "type" && value.const !== undefined) continue;
    if (LIMITS.has(key) || (key === "propertyNames" && isNode(item) && item.type === "string")) {
      continue;
    }
    if ((key === "maximum" || key === "minimum") && Math.abs(Number(item)) >= 2 ** 50) continue;
    node[key] =
      key === "$ref" && typeof item === "string" && item.startsWith("#/$defs/")
        ? `${DEFS_AT}${item.slice("#/$defs/".length)}`
        : rehome(item, depth + 1);
  }
  return node;
}

/** Takes a parameter out of a schema, by its path such as `changes.path`. */
function withoutParam(schema: Node, path: readonly string[]): void {
  const [name, ...rest] = path;
  const properties = schema.properties as Record<string, Node> | undefined;
  if (name === undefined || !properties) return;
  if (rest.length > 0) {
    const inner = properties[name];
    if (inner) withoutParam(inner, rest);
    return;
  }
  delete properties[name];
  if (Array.isArray(schema.required)) {
    schema.required = (schema.required as string[]).filter((key) => key !== name);
  }
}

/** The branch of one operation: `op` first, then its parameters, without what AI does not see. */
function branchOf(op: Operation, generated: Node): Node {
  for (const { name } of op.hiddenParams ?? []) withoutParam(generated, name.split("."));
  const properties = (generated.properties ?? {}) as Record<string, Node>;
  for (const [name, schema] of Object.entries(properties)) {
    const words = paramWords(op.name, name);
    if (words !== undefined && schema.description === undefined) {
      properties[name] = { description: words, ...schema };
    }
  }
  const loose = LOOSE[op.name];
  for (const [name, words] of Object.entries(loose ?? {})) {
    properties[name] = { type: "object", description: words };
  }
  const required = (generated.required ?? []) as string[];
  return {
    type: "object",
    properties: { op: { const: op.name }, ...properties },
    required: ["op", ...required],
    additionalProperties: false,
  };
}

/** The schema of `operations`: each item one operation, with the shared types in its `$defs`. */
function operationsSchema(): Node {
  const registry = z.registry<{ id: string; description: string }>();
  for (const [schema, id, description] of SHARED) registry.add(schema, { id, description });
  const union = z.union(AI_OPERATIONS.map((op) => op.params) as [z.ZodType, ...z.ZodType[]]);
  const generated = z.toJSONSchema(z.array(union), {
    target: "draft-2020-12",
    io: "input",
    metadata: registry,
    // Refinements have no form in JSON Schema: the tools check them anyway.
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      if (!PLAIN_STRINGS.has(zodSchema as unknown as z.ZodType)) return;
      for (const key of Object.keys(jsonSchema)) delete (jsonSchema as Node)[key];
      jsonSchema.type = "string";
    },
  }) as Node;
  const items = (generated.items ?? {}) as Node;
  const branches = ((items.anyOf ?? []) as Node[]).map((branch, index) => {
    const op = AI_OPERATIONS[index] as Operation;
    return branchOf(op, { ...(rehome(branch) as Node), additionalProperties: false });
  });
  const defs = rehome(generated.$defs ?? {}) as Record<string, Node>;
  return {
    type: "array",
    description:
      'The operations, run in order as one batch: each one {"op": "<operation>", …its parameters}. 1 to 100.',
    minItems: 1,
    maxItems: MAX_OPERATIONS,
    items: { anyOf: branches },
    $defs: Object.fromEntries(
      Object.keys(defs)
        .toSorted()
        .map((key) => [key, defs[key]]),
    ),
  };
}

/**
 * Parameters that only repeat a type of `$defs` with every field optional: said in words, so that
 * the list of tools stays small. The tools check them as strictly as the rest.
 */
const LOOSE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "scene.update": { changes: "The fields of the SceneManifest to change; the rest stay." },
  "sound.update": { changes: "The fields of the SoundManifest to change; the rest stay." },
};

/** How many operations one batch takes at most: more is for a script. */
export const MAX_OPERATIONS = 100;

let made: Node | undefined;

/** The schema of `operations` of aq_edit, made once: the same every time, for caches of services. */
export function operationsParameter(): JsonSchema {
  made ??= operationsSchema();
  return made;
}

/** A short form of a schema, as signatures show it: `{timeline, clips:[{clip, start?, track?}], overlap?}`. */
function shapeOf(schema: unknown, defs: Readonly<Record<string, unknown>>, depth = 0): string {
  if (!isNode(schema) || depth > 3) return "…";
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const name = ref.slice(DEFS_AT.length);
    return name;
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join("|");
  if (Array.isArray(schema.anyOf)) {
    const parts = schema.anyOf.filter((part) => !(isNode(part) && part.type === "null"));
    return parts.length === 1 ? shapeOf(parts[0], defs, depth) : "…";
  }
  if (schema.type === "array") return `[${shapeOf(schema.items, defs, depth + 1)}]`;
  if (schema.type === "object" && isNode(schema.properties)) {
    const required = new Set((schema.required ?? []) as string[]);
    const fields = Object.entries(schema.properties).map(([name, inner]) => {
      const optional = required.has(name) ? "" : "?";
      const nested = isNode(inner) && (inner.type === "object" || inner.type === "array");
      return nested && depth < 2
        ? `${name}${optional}:${shapeOf(inner, defs, depth + 1)}`
        : `${name}${optional}`;
    });
    return `{${fields.join(", ")}}`;
  }
  return typeof schema.type === "string" ? schema.type : "…";
}

/** What an operation takes, in one line: `clip.move {timeline, clips:[{clip, start?, track?}], overlap?}`. */
export function signatureOf(name: string): string {
  const schema = operationsParameter() as Node;
  const branch = ((schema.items as Node).anyOf as Node[]).find(
    (each) => ((each.properties as Node).op as Node).const === name,
  );
  if (!branch) return name;
  const { op: _op, ...properties } = branch.properties as Node;
  return `${name} ${shapeOf({ ...branch, properties }, (schema.$defs ?? {}) as Node)}`;
}
