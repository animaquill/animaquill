import { describe, expect, it } from "vitest";
import { holdsBack, picturesWhy } from "./PicturesWarn.tsx";
import { sendStateOf } from "./SendButton.tsx";

describe("the round button of the box", () => {
  it("is faint with nothing to send, sends, stops what runs, and queues what was typed meanwhile", () => {
    expect(sendStateOf(false, false)).toBe("empty");
    expect(sendStateOf(false, true)).toBe("ready");
    expect(sendStateOf(true, false)).toBe("stop");
    expect(sendStateOf(true, true)).toBe("queue");
  });
});

describe("what holds the pictures back", () => {
  const none = { ready: 0, working: false, failed: false, sees: true };
  it("says the worst first: one that failed, one being made, a model that takes none", () => {
    expect(picturesWhy({ ...none, ready: 1, working: true, failed: true, sees: false })).toBe(
      "failed",
    );
    expect(picturesWhy({ ...none, ready: 1, working: true, sees: false })).toBe("working");
    expect(picturesWhy({ ...none, ready: 1, sees: false })).toBe("blind");
  });

  it("lets pictures go where nobody said whether the model takes them, and says so", () => {
    const why = picturesWhy({ ...none, ready: 2, sees: undefined });
    expect(why).toBe("unsure");
    expect(holdsBack(why)).toBe(false);
    expect(holdsBack("blind")).toBe(true);
    expect(holdsBack("working")).toBe(true);
    expect(holdsBack("failed")).toBe(true);
  });

  it("is nothing without pictures, or with a model that takes them", () => {
    expect(picturesWhy(none)).toBeUndefined();
    expect(picturesWhy({ ...none, sees: false })).toBeUndefined();
    expect(picturesWhy({ ...none, ready: 3 })).toBeUndefined();
  });
});
