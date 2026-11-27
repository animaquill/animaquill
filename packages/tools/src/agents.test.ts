import { describe, expect, it } from "vitest";
import type { AgentCard, AgentDirectory, SendOutcome } from "./agents.ts";
import { AGENTS_FACT, systemPromptOf } from "./texts/index.ts";
import { mcpInstructions } from "./mcp.ts";
import { testHost, toolsOn } from "./test-support.ts";

const card = (id: string, name: string, more: Partial<AgentCard> = {}): AgentCard => ({
  id,
  kind: "chat",
  name,
  state: "idle",
  changed: [],
  accepts: "yes",
  ...more,
});

/** A directory with these others, which keeps what was sent and answers as told. */
function directory(cards: AgentCard[], outcome: SendOutcome = { sent: "turn" }) {
  const sent: { to: string; text: string }[] = [];
  const watched: string[] = [];
  const agents: AgentDirectory = {
    list: async () => cards,
    send: async (to, text) => {
      sent.push({ to, text });
      return outcome;
    },
    notifyWhenIdle: async (target) => {
      watched.push(target);
      return target.startsWith("mcp:") ? { refused: "cannotTell" } : { watching: true };
    },
  };
  return { agents, sent, watched, cards };
}

describe("the tools for the other conversations of the project", () => {
  it("list them, with what each does, what it changed, and whether it takes messages", async () => {
    const { agents } = directory([
      card("c1", "剪开场", {
        state: "running",
        doing: "在改片段「标题」",
        changed: ['clip c3 "标题"'],
      }),
      card("mcp:s1", "Claude Code", { kind: "tool", state: "tool" }),
      card("c2", "配乐", { accepts: "no" }),
    ]);
    const { call } = toolsOn({ ...testHost(), agents });
    const result = await call("aq_agents_list");
    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      '"剪开场" (conversation) running: 在改片段「标题」; last changed clip c3 "标题"',
    );
    expect(result.text).toContain(
      '"Claude Code" (tool) an AI tool on this computer; it cannot be woken',
    );
    expect(result.text).toContain('"配乐" (conversation) idle; it takes no messages');
  });

  it("send by name, by id or by address, and by a name the last list gave after a rename", async () => {
    const { agents, sent, cards } = directory([card("c1", "剪开场")]);
    const { call } = toolsOn({ ...testHost(), agents });
    expect((await call("aq_send", { to: "剪开场", message: "配乐还换吗" })).text).toContain(
      'to "剪开场": sent; it was idle and started a turn with it',
    );
    await call("aq_send", { to: "c1", message: "二" });
    await call("aq_send", { to: "aq://agent/c1", message: "三" });
    await call("aq_agents_list");
    cards[0] = card("c1", "剪一版 30 秒开场");
    await call("aq_send", { to: "剪开场", message: "四" });
    expect(sent).toEqual([
      { to: "c1", text: "配乐还换吗" },
      { to: "c1", text: "二" },
      { to: "c1", text: "三" },
      { to: "c1", text: "四" },
    ]);
    const unknown = await call("aq_send", { to: "没有这个", message: "x" });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.text).toMatch(/^error not-found/);
  });

  it("say why a message did not go, and nothing goes past the limit", async () => {
    for (const [refused, start] of [
      ["declines", "error declined"],
      ["paused", "error paused"],
      ["full", "error busy"],
      ["repeat", "error repeat"],
      ["self", "error invalid-params"],
    ] as const) {
      const { agents } = directory([card("c1", "剪开场")], { refused });
      const { call } = toolsOn({ ...testHost(), agents });
      const result = await call("aq_send", { to: "剪开场", message: "x" });
      expect(result.isError).toBe(true);
      expect(result.text.startsWith(start)).toBe(true);
      expect(result.data).toMatchObject({ to: { id: "c1" }, outcome: { refused } });
    }
    const { agents, sent } = directory([card("c1", "剪开场")]);
    const { call } = toolsOn({ ...testHost(), agents });
    const long = await call("aq_send", { to: "剪开场", message: "长".repeat(4001) });
    expect(long.isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it("are told once another is idle; an AI tool cannot say", async () => {
    const { agents, watched } = directory([
      card("c1", "剪开场"),
      card("mcp:s1", "Claude Code", { kind: "tool", state: "tool" }),
    ]);
    const { call } = toolsOn({ ...testHost(), agents });
    expect((await call("aq_agents_notify", { to: "剪开场" })).text).toContain("within 12 hours");
    const tool = await call("aq_agents_notify", { to: "Claude Code" });
    expect(tool.text).toMatch(/^error not-available/);
    expect(watched).toEqual(["c1", "mcp:s1"]);
  });

  it("are there everywhere, and say so where there are no others", async () => {
    const { call } = toolsOn(testHost());
    expect((await call("aq_agents_list")).text).toMatch(/^error not-available/);
    expect(systemPromptOf({ entry: "browser", agents: true })).toContain(AGENTS_FACT);
    expect(systemPromptOf({ entry: "browser" })).not.toContain(AGENTS_FACT);
    expect(mcpInstructions("editor")).toContain(AGENTS_FACT);
  });
});
