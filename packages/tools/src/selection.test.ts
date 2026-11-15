import { USER, type CommandCall } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { messageWords } from "./tools/read.ts";
import { openSample, testHost, toolsOn } from "./test-support.ts";
import type { SelectionFacts, SentMessage } from "./types.ts";

/**
 * aq_selection_read (docs/design/mcp.md of AnimaQuill Cloud, 3): what the editor shows now, or
 * what it showed the moment a message of the user was sent, counted back from the latest; one of
 * them a call, named by the first words of the message.
 */

const at = (clips: string[], playhead = "1"): SelectionFacts => ({
  timeline: "main",
  playhead,
  clips,
});

function withMessages(messages: readonly SentMessage[] | undefined, now?: SelectionFacts) {
  const host = testHost(openSample());
  host.selected = now;
  if (messages) host.sent = () => messages;
  return toolsOn(host);
}

const MESSAGES: readonly SentMessage[] = [
  {
    text: "把[片段「标题」](aq://object/clip_title?timeline=main)放慢一点，再加个淡出",
    selection: at(["clip_title"], "2"),
  },
  { text: "这个也是", selection: at(["clip_logo", "clip_card"], "5") },
];

describe("aq_selection_read", () => {
  it('at "now" gives what the editor shows now, and says so', async () => {
    const { call } = withMessages(MESSAGES, at(["clip_idea"], "12.5"));
    const result = await call("aq_selection_read", { at: "now" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('at "now": what the editor shows now');
    expect(result.text).toContain("timeline=main playhead=12.5 version=master");
    expect(result.text).toContain("selected clips (1): clip_idea");
    expect(result.text).not.toContain("clip_logo");
    expect(result.data).toEqual({ at: "now" });
  });

  it('at "sent" gives the latest message by default, and the ones before it counted back', async () => {
    const { call } = withMessages(MESSAGES, at(["clip_idea"]));
    const latest = await call("aq_selection_read", { at: "sent" });
    expect(latest.text).toContain('at "sent", messages_back 0: as the user sent "这个也是"');
    expect(latest.text).toContain("playhead=5");
    expect(latest.text).toContain("selected clips (2): clip_logo");
    expect(latest.text).toContain("clip_card");
    expect(latest.text).not.toContain("clip_idea");
    expect(latest.data).toEqual({ at: "sent", messages_back: 0, message: "这个也是" });
    const zero = await call("aq_selection_read", { at: "sent", messages_back: 0 });
    expect(zero.text).toBe(latest.text);

    const before = await call("aq_selection_read", { at: "sent", messages_back: 1 });
    // Named by its first words, its links as their labels.
    expect(before.text).toContain('as the user sent "把片段「标题」放慢一点，再加个淡…"');
    expect(before.text).toContain("playhead=2");
    expect(before.text).toContain("selected clips (1): clip_title");
    expect(before.text).not.toContain("clip_logo");
  });

  it("past the first message: an error that says what can be read", async () => {
    const { call } = withMessages(MESSAGES);
    const result = await call("aq_selection_read", { at: "sent", messages_back: 2 });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "error out-of-range: messages_back 2 is before the first message; this conversation has 2 messages of the user, so messages_back goes from 0 to 1.",
    );
    const negative = await call("aq_selection_read", { at: "sent", messages_back: -1 });
    expect(negative.isError).toBe(true);
    expect(negative.text).toContain("error invalid-params");
  });

  it("a message from before the editor kept them: says so, and that now is there", async () => {
    const { call } = withMessages([{ text: "旧的消息" }, ...MESSAGES]);
    const result = await call("aq_selection_read", { at: "sent", messages_back: 2 });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('as the user sent "旧的消息"');
    expect(result.text).toContain(
      'this message has no record of what the editor showed, as it was sent before the editor kept one; at "now" gives what it shows now.',
    );
    expect(result.text).not.toContain("timeline=");
  });

  it("nothing selected: says so, with the playhead", async () => {
    const { call } = withMessages([{ text: "看看这里", selection: at([], "7") }], at([]));
    const sent = await call("aq_selection_read", { at: "sent" });
    expect(sent.text).toContain("timeline=main playhead=7");
    expect(sent.text).toContain("nothing is selected");
    expect(sent.text).not.toContain("selected clips");
    const now = await call("aq_selection_read", { at: "now" });
    expect(now.text).toContain("nothing is selected");
  });

  it("clips selected then and gone now are listed by id, apart from those still there", async () => {
    const store = openSample();
    const host = testHost(store);
    host.sent = () => [
      {
        text: "删掉这两个以外的",
        selection: { ...at(["clip_idea", "clip_logo"]), transition: { join: "join_gone" } },
      },
    ];
    const done = store.execute(
      { type: "clip.remove", params: { timeline: "main", clips: ["clip_idea"] } } as CommandCall,
      { origin: USER },
    );
    expect(done.ok).toBe(true);
    const { call } = toolsOn(host);
    const result = await call("aq_selection_read", { at: "sent" });
    expect(result.text).toContain("selected clips (1): clip_logo");
    expect(result.text).toContain("selected clips that are gone now (1): clip_idea");
    expect(result.text).toContain("selected transition: join join_gone (gone now)");
  });

  it('at "now" with messages_back: refused, with how the call goes', async () => {
    const { call, tools } = withMessages(MESSAGES, at(["clip_idea"]));
    const result = await call("aq_selection_read", { at: "now", messages_back: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'error invalid-params: messages_back goes only with at "sent", which counts back the messages of the user; at "now" is what the editor shows now and goes without it.',
    );
    // Hosts check calls before they run them, with the same words.
    expect(tools.get("aq_selection_read")?.validate({ at: "now", messages_back: 0 })?.text).toBe(
      result.text,
    );
    // at is needed: neither of them is taken for the other.
    const without = await call("aq_selection_read", {});
    expect(without.isError).toBe(true);
    expect(without.text).toContain("error invalid-params");
    expect(without.text).toContain("at");
  });

  it('through MCP, where the conversation is the client\'s: "sent" says only now is there', async () => {
    const { call } = withMessages(undefined, at(["clip_idea"]));
    const result = await call("aq_selection_read", { at: "sent" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      'at "sent": this client does not share its conversation with AnimaQuill, so there is no record of what the editor showed as messages were sent; at "now" gives what it shows now.',
    );
    expect(result.text).not.toContain("clip_idea");
    expect((await call("aq_selection_read", { at: "now" })).text).toContain("clip_idea");
  });

  it("names a message by its first sixteen characters, links as their labels", () => {
    expect(messageWords("  短的  ")).toBe("短的");
    expect(messageWords("Make the second caption a bit slower")).toBe("Make the second …");
    expect(messageWords("[0:01/00](aq://time?timeline=main&t=1) 之后")).toBe("0:01/00 之后");
  });
});
