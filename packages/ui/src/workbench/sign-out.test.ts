import { describe, expect, test } from "vitest";
import { signOutThen } from "./sign-out.ts";

/** Conversations that wait here, see `AccountChats`. */
function waitingChats(count: number) {
  const done: string[] = [];
  let left = count;
  return {
    done,
    chats: {
      flush: async () => void done.push("flush"),
      waiting: async () => left,
      dropWaiting: async () => {
        done.push("drop");
        const was = left;
        left = 0;
        return was;
      },
    },
  };
}

describe("signing out of the online mode", () => {
  test("lets go of what waits here only once the backend took the signing out", async () => {
    const { chats, done } = waitingChats(2);
    const asked: number[] = [];
    await expect(
      signOutThen({
        chats,
        confirm: async (count) => (asked.push(count), true),
        signOut: () => Promise.reject(new TypeError("Failed to fetch")),
      }),
    ).rejects.toThrow("Failed to fetch");
    // Still signed in, and nothing of theirs went.
    expect(asked).toEqual([2]);
    expect(done).toEqual(["flush"]);
    expect(await chats.waiting()).toBe(2);

    expect(await signOutThen({ chats, confirm: async () => true, signOut: async () => {} })).toBe(
      "signedOut",
    );
    expect(done).toEqual(["flush", "flush", "drop"]);
  });

  test("stays signed in where people would rather keep what waits", async () => {
    const { chats, done } = waitingChats(1);
    let signedOut = false;
    expect(
      await signOutThen({
        chats,
        confirm: async () => false,
        signOut: async () => void (signedOut = true),
      }),
    ).toBe("stayed");
    expect(signedOut).toBe(false);
    expect(done).toEqual(["flush"]);
  });

  test("asks nothing where nothing waits", async () => {
    const { chats } = waitingChats(0);
    let asked = false;
    expect(
      await signOutThen({
        chats,
        confirm: async () => (asked = true),
        signOut: async () => {},
      }),
    ).toBe("signedOut");
    expect(asked).toBe(false);
  });
});
