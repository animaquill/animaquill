import type { Value } from "@animaquill/schema";
import type { ObjectHandle } from "./content.ts";

/**
 * What code gives `aq.object` to say where an object is and what of it can be grabbed on the
 * picture: `bounds` and `handles`, as functions of its values. They only ever run here, in the
 * scene. The editor gets what they return, and reads it as data, see `readHandles`.
 */

type Values = Readonly<Record<string, Value>>;

interface Placing {
  readonly object: ObjectHandle;
  readonly bounds?: (values: Values) => unknown;
  readonly handles?: (values: Values) => unknown;
}

/** What one object said about where it is, as it came out of its code. */
export interface RawPlace {
  readonly object: string;
  readonly bounds?: unknown;
  readonly handles?: unknown;
}

const functionIn = <T>(options: unknown, name: string): T | undefined => {
  const value =
    typeof options === "object" && options !== null
      ? (options as Record<string, unknown>)[name]
      : undefined;
  return typeof value === "function" ? (value as T) : undefined;
};

/** The functions of the objects that can say where they are, by the id they registered with. */
export class ObjectPlaces {
  readonly #placing = new Map<string, Placing>();

  /**
   * What `aq.object` was given, for the object it came back with. Code that registers on every frame
   * makes new functions each time, and the latest count. An object without an id that counts has no
   * properties of its own to change, so it has nothing to grab either.
   */
  note(object: ObjectHandle, options: unknown): void {
    if (object.id === "") return;
    const bounds = functionIn<Placing["bounds"]>(options, "bounds");
    const handles = functionIn<Placing["handles"]>(options, "handles");
    if (!bounds && !handles) {
      this.#placing.delete(object.id);
      return;
    }
    this.#placing.set(object.id, {
      object,
      ...(bounds && { bounds }),
      ...(handles && { handles }),
    });
  }

  /**
   * What the objects say at a reading of the clock, in the order they first said anything. A
   * function that throws leaves out what it was for, and `failed` hears why.
   */
  at(seconds: number, failed: (error: unknown) => void): readonly RawPlace[] {
    const places: RawPlace[] = [];
    for (const [id, { object, bounds, handles }] of this.#placing) {
      // A copy, so that code cannot change what `at` hands out to everybody else.
      const values = { ...object.at(seconds) };
      const place: { object: string; bounds?: unknown; handles?: unknown } = { object: id };
      for (const [name, run] of [
        ["bounds", bounds],
        ["handles", handles],
      ] as const) {
        if (!run) continue;
        try {
          place[name] = run(values);
        } catch (error) {
          failed(error);
        }
      }
      places.push(place);
    }
    return places;
  }
}
