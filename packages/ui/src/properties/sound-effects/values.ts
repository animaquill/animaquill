import type { ObjectDescriptor, PropertySpec, Value } from "@animaquill/schema";
import { useCallback, useSyncExternalStore } from "react";
import { useWorkbench } from "../../app/context.ts";
import { writeEdit } from "../inspect.ts";
import type { PropertyRows } from "../rows.ts";

/** A parameter of an effect by its name within the effect, as `mid2.gain`. */
const shortName = (object: ObjectDescriptor, spec: PropertySpec): string => {
  const prefix = `${object.id}.`;
  return spec.path.startsWith(prefix) ? spec.path.slice(prefix.length) : spec.path;
};

/**
 * What the parameters of an effect are at the playhead, by their names within it, as the rows of the
 * properties tab show them; and how to change some of them at once, where people work (a key at the
 * playhead when there are keys): `preview` while a hand is on something, `commit` as one step.
 */
export function useEffectValues(rows: PropertyRows, clip: string, object: ObjectDescriptor) {
  const { properties } = useWorkbench();
  const signature = () =>
    object.properties.map((spec) => rows.signatureOf(clip, spec)).join("\u0001");
  useSyncExternalStore(rows.subscribe, signature);
  const values: Record<string, Value | undefined> = {};
  let blocked = false;
  for (const spec of object.properties) {
    const inspected = rows.inspect(clip, spec);
    if (inspected?.blocked !== undefined) blocked = true;
    values[shortName(object, spec)] = inspected?.row.value ?? spec.default;
  }
  const editsOf = useCallback(
    (changes: Readonly<Record<string, Value>>) =>
      object.properties.flatMap((spec) => {
        const name = shortName(object, spec);
        if (!Object.hasOwn(changes, name)) return [];
        const now = rows.inspect(clip, spec);
        if (!now || now.blocked !== undefined) return [];
        return [writeEdit(clip, now.row, now.time, changes[name] as Value)];
      }),
    [rows, clip, object],
  );
  const preview = useCallback(
    (changes: Readonly<Record<string, Value>>) => {
      const edits = editsOf(changes);
      if (edits.length > 0) properties.preview(edits);
    },
    [editsOf, properties],
  );
  const commit = useCallback(
    (changes: Readonly<Record<string, Value>>) => {
      const edits = editsOf(changes);
      if (edits.length > 0) properties.commit(edits);
      else properties.cancel();
    },
    [editsOf, properties],
  );
  const cancel = useCallback(() => properties.cancel(), [properties]);
  return { values, blocked, preview, commit, cancel };
}
