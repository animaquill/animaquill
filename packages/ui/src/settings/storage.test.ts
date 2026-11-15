import { memoryChatImages, memoryChats } from "@animaquill/host";
import { describe, expect, it } from "vitest";
import { clearLocalChats, usageOfChats } from "./storage.ts";

const blob = (byte: number) =>
  new Blob([new Uint8Array([byte, byte, byte])], { type: "image/jpeg" });

describe("the conversations of this browser", () => {
  it("count their pictures, and take away with them those nothing else has", async () => {
    const chatStore = memoryChats();
    const chatImages = memoryChatImages();
    const size = { width: 4, height: 3 };
    const [gone, shared, draft, loose] = await Promise.all(
      [1, 2, 3, 4].map((byte) => chatImages.save(blob(byte), size)),
    );
    const said = (images: readonly { image: string }[]) => ({
      role: "user",
      text: "看",
      at: 1,
      task: "t",
      images: images.map((ref) => ({
        ...ref,
        type: "image/jpeg",
        width: 4,
        height: 3,
        bytes: 3,
        note: "[image]",
      })),
    });
    await chatStore.save({
      id: "a",
      project: "local",
      title: "a",
      updatedAt: 1,
      entries: [said([gone!, shared!])],
    });
    await chatStore.save({
      id: "b",
      project: "cloud",
      title: "b",
      updatedAt: 1,
      entries: [said([shared!])],
    });
    const place = {
      chatStore,
      chatImages,
      cloud: { linkOf: async (project: string) => (project === "cloud" ? {} : undefined) },
      chat: {
        projectKey: undefined,
        running: false,
        newConversation: () => {},
        reloadList: async () => {},
        attachments: { draftImages: () => new Set([draft!.image]) },
      },
    };
    expect((await usageOfChats(place)).images).toEqual({ count: 4, bytes: 12 });
    expect(await clearLocalChats(place)).toEqual({ cleared: 1, kept: 0 });
    // The cloud project's conversation and the draft keep theirs.
    expect((await chatImages.keys()).map(({ image }) => image).toSorted()).toEqual(
      [shared!.image, draft!.image].toSorted(),
    );
    void loose;
  });
});
