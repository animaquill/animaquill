/**
 * What the code of an AnimaQuill scene can use: the global `aq` of the scene runtime, version 1
 * (`"runtime": 1` in scene.json). What each of these does, and what a scene cannot rely on, is in
 * the scene runtime of the manual (`animaquill guide scene-runtime/aq`, or docs/scene-runtime.md
 * of https://github.com/animaquill/animaquill). Use it from the code of a scene with
 * `/// <reference types="animaquill/types/scene" />`, or from jsconfig.json / tsconfig.json.
 */

declare namespace AnimaQuill {
  /** What a property of an object is, see `aq.object`. A bare value is short for its default. */
  type PropertyType =
    | "number"
    | "angle"
    | "boolean"
    | "choice"
    | "text"
    | "asset"
    | "color"
    | "vec2"
    | "vec3"
    | "vec4"
    | "numbers";

  interface PropertySpec {
    readonly type: PropertyType;
    readonly default?: unknown;
    readonly min?: number;
    readonly max?: number;
    /** The range that dragging suggests. */
    readonly softMin?: number;
    readonly softMax?: number;
    /** Such as "world", "deg" or "ratio". */
    readonly unit?: string;
    readonly name?: string;
    /** One level of grouping in the property tree. */
    readonly group?: string;
    /** The names of the parts of a vector, "x", "y", "z", "w" by default. */
    readonly components?: readonly string[];
    /** For "choice". */
    readonly options?: readonly string[];
    /** False: no keyframes. */
    readonly animatable?: boolean;
    /** Names the property had before, whose keyframes it takes. */
    readonly aliases?: readonly string[];
  }

  type Point = readonly [number, number];

  type Handle =
    | {
        readonly kind: "move";
        readonly id: string;
        readonly at: Point;
        readonly bind: { readonly x?: string; readonly y?: string };
      }
    | {
        readonly kind: "rotate";
        readonly id: string;
        readonly at: Point;
        readonly radius: number;
        readonly bind: string;
      }
    | {
        readonly kind: "scale";
        readonly id: string;
        readonly at: Point;
        readonly center: Point;
        readonly bind: string | { readonly x: string; readonly y: string };
      }
    | { readonly kind: "line" | "polyline"; readonly points: readonly Point[] }
    | { readonly kind: "circle"; readonly at: Point; readonly radius: number };

  /** Values of the properties of an object at a moment, by name. */
  type Values = Readonly<Record<string, unknown>>;

  interface ObjectOptions {
    readonly name?: string;
    readonly properties: Readonly<
      Record<string, PropertySpec | number | boolean | string | readonly number[]>
    >;
    /** The object above it in the property tree; only where it shows. */
    readonly parent?: string;
    /** When it is there, on the clock of the clip, in seconds: [[0, 2], [5, 8]]. */
    readonly spans?: readonly (readonly [number, number])[];
    /** A switch or a number of its own: it is there while true or above 0. */
    readonly presence?: string;
    /** Ids it had before, whose keyframes it takes. */
    readonly aliases?: readonly string[];
    /** Where it is on the picture: [x, y, width, height], in scene coordinates. */
    readonly bounds?: (values: Values) => readonly [number, number, number, number];
    /** What people drag on the picture to change it. */
    readonly handles?: (values: Values) => readonly Handle[];
  }

  interface SceneObject {
    /** Every property at that moment, keyframes worked in; now without it. The same object each time. */
    at(seconds?: number): Values;
  }

  interface View {
    readonly width: number;
    readonly height: number;
    readonly pixelRatio: number;
    /** The id of the format the picture is made for. */
    readonly format: string;
    /** The language the picture is made in. */
    readonly language: string;
  }

  interface SceneRuntime {
    /** The version of this interface. */
    readonly runtime: number;
    readonly view: View;
    /** Where the file of an asset is, by its id written as it is in the code; "data:," for none. */
    asset(id: string): string;
    /** Calls back for each frame with the time on the clock of the clip. Returns how to stop. */
    frame(callback: (seconds: number) => void): () => void;
    /** An object whose properties take keyframes, as `object.<id>.<property>`. */
    object(id: string, options: ObjectOptions): SceneObject;
    /** A parameter of scene.json at that moment; now without it. */
    param(id: string, seconds?: number): unknown;
  }
}

declare const aq: AnimaQuill.SceneRuntime;
