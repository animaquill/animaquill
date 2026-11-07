import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyboardKeeper } from "./keyboard.ts";

type Listener = (event: { target?: unknown }) => void;

function setup() {
  const windowListeners = new Map<string, Listener>();
  const documentListeners = new Map<string, Listener>();
  const page = { activeElement: undefined as unknown };
  const focus = vi.fn();
  vi.stubGlobal("addEventListener", (type: string, listener: Listener) =>
    windowListeners.set(type, listener),
  );
  vi.stubGlobal("removeEventListener", (type: string) => windowListeners.delete(type));
  vi.stubGlobal("window", { focus });
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: Listener) => documentListeners.set(type, listener),
    removeEventListener: (type: string) => documentListeners.delete(type),
    get activeElement() {
      return page.activeElement;
    },
  });
  const frame = { blur: vi.fn() } as unknown as HTMLIFrameElement;
  const ask = vi.fn<(request: number) => void>();
  const keeper = new KeyboardKeeper(frame, ask);
  const input = { isConnected: true, focus: vi.fn() };
  const focusIn = (target: unknown) => documentListeners.get("focusin")?.({ target });
  const blur = () => windowListeners.get("blur")?.({});
  return { keeper, frame, ask, focus, input, page, focusIn, blur, windowListeners };
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("keeping the keyboard", () => {
  it("does nothing when the window loses it to something else", () => {
    const { blur, ask, focus, page, input } = setup();
    page.activeElement = input;
    blur();
    vi.runAllTimers();
    expect(ask).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("asks first, while the frame still has it, and only then takes it back", () => {
    const { blur, ask, keeper, focus, page, frame, focusIn, input } = setup();
    focusIn(input);
    page.activeElement = frame;
    blur();
    expect(ask).toHaveBeenCalledWith(1);
    expect(focus).not.toHaveBeenCalled();
    keeper.checked(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(input.focus).toHaveBeenCalledTimes(1);
  });

  it("does not wait for a compositor that hangs", () => {
    const { blur, focus, page, frame, focusIn, input } = setup();
    focusIn(input);
    page.activeElement = frame;
    blur();
    vi.advanceTimersByTime(29);
    expect(focus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(input.focus).toHaveBeenCalledTimes(1);
  });

  it("takes it back once, whichever comes first", () => {
    const { blur, keeper, focus, page, frame } = setup();
    page.activeElement = frame;
    blur();
    keeper.checked(1);
    vi.runAllTimers();
    keeper.checked(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not go back to what is gone, and lets go of the frame instead", () => {
    const { blur, keeper, page, frame, focusIn, input } = setup();
    focusIn(input);
    input.isConnected = false;
    page.activeElement = frame;
    blur();
    keeper.checked(1);
    expect(input.focus).not.toHaveBeenCalled();
    expect(frame.blur).toHaveBeenCalledTimes(1);
  });

  it("does not take the frame for what the keyboard goes back to", () => {
    const { blur, keeper, page, frame, focusIn, input } = setup();
    focusIn(input);
    focusIn(frame);
    page.activeElement = frame;
    blur();
    keeper.checked(1);
    expect(input.focus).toHaveBeenCalledTimes(1);
  });

  it("keeps listening, however often it happens", () => {
    const { blur, keeper, ask, focus, page, frame } = setup();
    page.activeElement = frame;
    for (let round = 1; round <= 5; round += 1) {
      blur();
      keeper.checked(round);
    }
    expect(ask).toHaveBeenCalledTimes(5);
    expect(focus).toHaveBeenCalledTimes(5);
  });

  it("asks once while it is still busy with the last time", () => {
    const { blur, ask, page, frame } = setup();
    page.activeElement = frame;
    blur();
    blur();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("an answer to an earlier question is not an answer", () => {
    const { blur, keeper, focus, page, frame } = setup();
    page.activeElement = frame;
    blur();
    keeper.checked(1);
    blur();
    keeper.checked(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("stops when it is told to", () => {
    const { keeper, windowListeners } = setup();
    keeper.dispose();
    expect(windowListeners.size).toBe(0);
  });
});
