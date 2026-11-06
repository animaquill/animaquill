import { BUILT_IN_PROPERTIES, type PropertySpec } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import { NumberEdit, type NumberEditProps } from "./number-edit.ts";

const POINTER = 1;
const plain = { shift: false, alt: false };

function setup(props: Partial<NumberEditProps> = {}) {
  const onPreview = vi.fn<(value: number) => void>();
  const onCommit = vi.fn<(value: number) => void>();
  const onCancel = vi.fn<() => void>();
  const all: NumberEditProps = {
    spec: BUILT_IN_PROPERTIES["transform.x"] as PropertySpec,
    value: 100,
    automatic: false,
    readOnly: false,
    onPreview,
    onCommit,
    onCancel,
    ...props,
  };
  const field = new NumberEdit(all);
  const drag = (...places: readonly number[]) => {
    field.press(POINTER, 0);
    for (const x of places) field.move(POINTER, x, plain);
  };
  return { field, onPreview, onCommit, onCancel, drag, all };
}

describe("dragging", () => {
  it("shows every step, and writes once when it ends", () => {
    const { field, drag, onPreview, onCommit } = setup();
    drag(10, 20, 30);
    expect(onPreview.mock.calls.map(([value]) => value)).toEqual([110, 120, 130]);
    expect(field.getSnapshot().dragged).toBe(130);
    expect(onCommit).not.toHaveBeenCalled();
    expect(field.release(POINTER)).toBe(false);
    expect(onCommit.mock.calls).toEqual([[130]]);
    expect(field.getSnapshot().dragged).toBeUndefined();
  });

  it("does not show the same value twice", () => {
    const { drag, onPreview } = setup();
    drag(10, 10);
    expect(onPreview).toHaveBeenCalledOnce();
  });

  it("is a click until it moves far enough", () => {
    const { field, drag, onPreview, onCommit, onCancel } = setup();
    drag(1, -2, 3);
    expect(onPreview).not.toHaveBeenCalled();
    expect(field.release(POINTER)).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("does not jump back into being a click once it left", () => {
    const { field, drag, onCommit } = setup();
    drag(10, 1);
    expect(field.release(POINTER)).toBe(false);
    expect(onCommit.mock.calls).toEqual([[101]]);
  });

  it("writes nothing when it ends where it started", () => {
    const { field, drag, onCommit, onCancel } = setup();
    drag(10, 0);
    field.release(POINTER);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("takes everything back on Escape, and letting go then does nothing", () => {
    const { field, drag, onCommit, onCancel } = setup();
    drag(10, 20);
    field.cancelDrag();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(field.getSnapshot().dragged).toBeUndefined();
    expect(field.release(POINTER)).toBe(false);
    field.move(POINTER, 50, plain);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("has nothing to take back before it moved", () => {
    const { field, onCancel } = setup();
    field.press(POINTER, 0);
    field.cancelDrag();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("listens to the pointer that started it", () => {
    const { field, drag, onPreview } = setup();
    drag(10);
    field.move(2, 90, plain);
    expect(field.release(2)).toBe(false);
    expect(onPreview).toHaveBeenCalledOnce();
    expect(field.getSnapshot().dragged).toBe(110);
  });

  it("starts from the value it had when it started, whatever happens meanwhile", () => {
    const { field, drag, all, onPreview } = setup();
    drag(10);
    field.update({ ...all, value: 500 });
    field.move(POINTER, 20, plain);
    expect(onPreview).toHaveBeenLastCalledWith(120);
  });

  it("tells whoever is there by the end of it", () => {
    const { field, drag, all, onCommit } = setup();
    const later = vi.fn<(value: number) => void>();
    drag(10);
    field.update({ ...all, onCommit: later });
    field.release(POINTER);
    expect(onCommit).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledWith(110);
  });

  it("does not start on what cannot be changed", () => {
    const { field, onPreview } = setup({ readOnly: true });
    expect(field.press(POINTER, 0)).toBe(false);
    field.move(POINTER, 50, plain);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("starts from the value something automatic stands at", () => {
    const { drag, onPreview } = setup({ automatic: true, value: 1920 });
    drag(-10);
    expect(onPreview).toHaveBeenCalledWith(1910);
  });

  it("goes by the keys that are down right now", () => {
    const { field, onPreview } = setup();
    field.press(POINTER, 0);
    field.move(POINTER, 10, { shift: true, alt: false });
    expect(onPreview).toHaveBeenLastCalledWith(200);
    field.move(POINTER, 10, { shift: false, alt: true });
    expect(onPreview).toHaveBeenLastCalledWith(101);
  });
});

describe("typing", () => {
  it("starts with what is shown", () => {
    const { field } = setup();
    field.startTyping();
    expect(field.getSnapshot().typed).toBe("100");
  });

  it("starts empty on something automatic, because that is no number of its own", () => {
    const { field, onCommit } = setup({ automatic: true, value: 1920 });
    field.startTyping();
    expect(field.getSnapshot().typed).toBe("");
    field.finishTyping();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("writes what was typed, once", () => {
    const { field, onCommit } = setup();
    field.startTyping();
    field.type("250");
    field.finishTyping();
    field.finishTyping();
    expect(onCommit.mock.calls).toEqual([[250]]);
    expect(field.getSnapshot().typed).toBeUndefined();
  });

  it("writes nothing when nothing was changed", () => {
    const { field, onCommit } = setup();
    field.startTyping();
    field.finishTyping();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("writes nothing when the text is back to what it was", () => {
    const { field, onCommit } = setup();
    field.startTyping();
    field.type("7");
    field.type("100");
    field.finishTyping();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("writes nothing for what is no number, and says so on the way", () => {
    const { field, onCommit } = setup();
    field.startTyping();
    expect(field.isInvalid).toBe(false);
    field.type("很多");
    expect(field.isInvalid).toBe(true);
    field.type("");
    expect(field.isInvalid).toBe(false);
    field.type("很多");
    field.finishTyping();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("takes it back on Escape, and leaving then writes nothing", () => {
    const { field, onCommit } = setup();
    field.startTyping();
    field.type("250");
    field.discardTyping();
    field.finishTyping();
    expect(onCommit).not.toHaveBeenCalled();
    expect(field.getSnapshot().typed).toBeUndefined();
  });

  it("does not start on what cannot be changed", () => {
    const { field } = setup({ readOnly: true });
    field.startTyping();
    expect(field.getSnapshot().typed).toBeUndefined();
  });

  it("does not start over while it goes on, which would lose what was typed", () => {
    const { field } = setup();
    field.startTyping();
    field.type("7");
    field.startTyping();
    expect(field.getSnapshot().typed).toBe("7");
  });

  it("is what a press is for while it goes on, so there is no drag", () => {
    const { field } = setup();
    field.startTyping();
    expect(field.press(POINTER, 0)).toBe(false);
  });

  it("ignores text from nowhere", () => {
    const { field } = setup();
    field.type("7");
    expect(field.getSnapshot().typed).toBeUndefined();
  });
});

describe("going away", () => {
  it("still writes what was typed, to the clip it was typed for", () => {
    const { field, onCommit } = setup();
    field.startTyping();
    field.type("250");
    field.dispose();
    expect(onCommit.mock.calls).toEqual([[250]]);
  });

  it("takes a drag back", () => {
    const { field, drag, onCommit, onCancel } = setup();
    drag(10);
    field.dispose();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("is quiet when nothing was going on", () => {
    const { field, onCommit, onCancel } = setup();
    field.dispose();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
