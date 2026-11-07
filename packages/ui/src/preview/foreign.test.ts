import { FOREIGN_MESSAGE_RULES } from "@animaquill/scene";
import { describe, expect, it, vi } from "vitest";
import { ForeignMessages } from "./foreign.ts";

/** A compositor with two frames of scenes in it, and in the second one a frame of its own. */
function pages() {
  const compositor = { length: 2 } as unknown as Window & Record<number, unknown>;
  const first = { parent: compositor } as unknown as Window;
  const second = { parent: compositor } as unknown as Window;
  compositor[0] = first;
  compositor[1] = second;
  const inner = { parent: second } as unknown as Window;
  const stranger = {} as unknown as Window;
  (stranger as { parent: Window }).parent = stranger;
  return { compositor, first, second, inner, stranger };
}

const limit = FOREIGN_MESSAGE_RULES.burstMessages;

function flood(foreign: ForeignMessages, source: Window, count: number) {
  for (let message = 0; message < count; message += 1) {
    foreign.note(source as unknown as MessageEventSource, 0);
  }
}

describe("messages from anybody but the compositor", () => {
  it("are forgiven for a while, because a mistake is not an attack", () => {
    const { compositor, first } = pages();
    const evict = vi.fn();
    flood(new ForeignMessages(() => compositor, evict), first, limit);
    expect(evict).not.toHaveBeenCalled();
  });

  it("get the frame they come from taken away, by its index", () => {
    const { compositor, second } = pages();
    const evict = vi.fn();
    flood(new ForeignMessages(() => compositor, evict), second, limit + 1);
    expect(evict).toHaveBeenCalledWith(1, 2);
  });

  it("get a frame reported once, or the next one at that index would go too", () => {
    const { compositor, second } = pages();
    const evict = vi.fn();
    flood(new ForeignMessages(() => compositor, evict), second, limit * 3);
    expect(evict).toHaveBeenCalledTimes(1);
  });

  it("get it reported again if that came to nothing", () => {
    const { compositor, second } = pages();
    const evict = vi.fn();
    const foreign = new ForeignMessages(() => compositor, evict);
    flood(foreign, second, limit * 3);
    for (let message = 0; message < 3; message += 1) {
      foreign.note(second as unknown as MessageEventSource, 1100);
    }
    expect(evict).toHaveBeenCalledTimes(2);
  });

  it("count for the frame of the scene, however deep inside of it they come from", () => {
    const { compositor, second } = pages();
    let deepest = second;
    for (let depth = 0; depth < 40; depth += 1) deepest = { parent: deepest } as unknown as Window;
    const evict = vi.fn();
    flood(new ForeignMessages(() => compositor, evict), deepest, limit + 1);
    expect(evict).toHaveBeenCalledWith(1, 2);
  });

  it("get no new allowance from a new frame inside the same scene", () => {
    const { compositor, second } = pages();
    const evict = vi.fn();
    const foreign = new ForeignMessages(() => compositor, evict);
    for (let message = 0; message <= limit; message += 1) {
      const fresh = { parent: second } as unknown as Window;
      foreign.note(fresh as unknown as MessageEventSource, 0);
    }
    expect(evict).toHaveBeenCalledWith(1, 2);
  });

  it("from nowhere in particular share one allowance, and take nothing away", () => {
    const { compositor, first } = pages();
    const evict = vi.fn();
    const foreign = new ForeignMessages(() => compositor, evict);
    flood(foreign, null as unknown as Window, limit + 1);
    flood(foreign, first, 1);
    expect(evict).not.toHaveBeenCalled();
  });

  it("count for the frame around a page inside of it", () => {
    const { compositor, inner } = pages();
    const evict = vi.fn();
    flood(new ForeignMessages(() => compositor, evict), inner, limit + 1);
    expect(evict).toHaveBeenCalledWith(1, 2);
  });

  it("are counted per sender, so that nobody uses up what a neighbour has", () => {
    const { compositor, first, second } = pages();
    const evict = vi.fn();
    const foreign = new ForeignMessages(() => compositor, evict);
    flood(foreign, first, limit);
    flood(foreign, second, limit);
    expect(evict).not.toHaveBeenCalled();
  });

  it("come back in budget with time", () => {
    const { compositor, first } = pages();
    const evict = vi.fn();
    const foreign = new ForeignMessages(() => compositor, evict);
    for (let second = 0; second < 100; second += 1) {
      foreign.note(first as unknown as MessageEventSource, second * 2000);
    }
    expect(evict).not.toHaveBeenCalled();
  });

  it("leave alone what is not in the compositor", () => {
    const { compositor, stranger } = pages();
    const evict = vi.fn();
    flood(new ForeignMessages(() => compositor, evict), stranger, limit * 3);
    expect(evict).not.toHaveBeenCalled();
  });

  it("change nothing while there is no compositor", () => {
    const { first } = pages();
    const evict = vi.fn();
    flood(new ForeignMessages(() => null, evict), first, limit * 3);
    expect(evict).not.toHaveBeenCalled();
  });

  it("from nobody are nothing to count", () => {
    const { compositor } = pages();
    const foreign = new ForeignMessages(
      () => compositor,
      () => {},
    );
    expect(() => foreign.note(null)).not.toThrow();
  });
});
