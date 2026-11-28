import type { FakeEndpoint } from "@animaquill/agent";
import { ProblemSet, ProjectStore } from "@animaquill/core";
import {
  memoryChats,
  memoryKeys,
  type AgentPost,
  type AgentRoom,
  type AgentRoomEvents,
  type ChatStore,
  type PostedMail,
  type SettingsStore,
} from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPacks } from "./packs.ts";
import { ChatSession } from "./session.ts";
import { AiSettingsStore } from "./settings.ts";

/**
 * The conversations of one project in several tabs of a browser (docs/design/ai-teamwork.md of
 * AnimaQuill Cloud, 3; chat6 technical design, 6.2): each tab sees what the others have, and
 * messages go to the tab that has the one they are for, or wait for it while no tab has it. The
 * browser is a pretend one here, as `AgentPost` says it behaves: one tab at a time has each, the
 * others wait in turn, and what a tab had goes with it; `agents-browser.test.ts` tests the real one.
 */

/** A browser of several tabs, with what they share. */
class Browser {
  readonly holders = new Map<string, number>();
  readonly queues = new Map<string, number[]>();
  readonly cards = new Map<string, { tab: number; card: unknown; at: number }>();
  mail: (PostedMail & { claimedBy?: number | undefined })[] = [];
  watches: { target: string; watcher: string; until: number }[] = [];
  budget = 0;
  readonly rooms = new Map<number, { events: AgentRoomEvents; open: boolean }>();
  readonly waiting = new Map<string, (outcome: unknown) => void>();

  #grant(id: string) {
    const next = this.queues.get(id)?.shift();
    if (next === undefined) return;
    this.holders.set(id, next);
    const room = this.rooms.get(next);
    queueMicrotask(() => room?.open && room.events.owned(id, true));
  }

  #release(id: string, tab: number) {
    if (this.holders.get(id) === tab) {
      this.holders.delete(id);
      this.#grant(id);
    }
    const queue = this.queues.get(id);
    if (queue)
      this.queues.set(
        id,
        queue.filter((each) => each !== tab),
      );
  }

  /** A tab that crashed, or that people closed: what it held goes, what it said stays. */
  crash(tab: number) {
    const room = this.rooms.get(tab);
    if (room) room.open = false;
    for (const [id, holder] of Array.from(this.holders)) if (holder === tab) this.#release(id, tab);
    for (const [id, queue] of this.queues)
      this.queues.set(
        id,
        queue.filter((each) => each !== tab),
      );
  }

  tab(tab: number): AgentPost {
    return {
      enter: (_project, events): AgentRoom => {
        const room = { events, open: true };
        this.rooms.set(tab, room);
        const mine = new Set<string>();
        const take = (id: string) => {
          mine.add(id);
          if (!this.holders.has(id)) {
            this.holders.set(id, tab);
            queueMicrotask(() => room.open && events.owned(id, false));
          } else if (this.holders.get(id) !== tab) {
            const queue = this.queues.get(id) ?? [];
            if (!queue.includes(tab)) queue.push(tab);
            this.queues.set(id, queue);
            queueMicrotask(() => room.open && events.queued?.(id));
          }
        };
        const giveBack = async (ids: readonly string[]) => {
          this.mail = this.mail.map((each) =>
            ids.includes(each.id) && each.claimedBy === tab
              ? { ...each, claimedBy: undefined, left: true }
              : each,
          );
        };
        return {
          serve: (ids) => {
            if (!room.open) return;
            for (const id of Array.from(mine)) {
              if (ids.includes(id)) continue;
              mine.delete(id);
              if (this.cards.get(id)?.tab === tab && this.holders.get(id) === tab) {
                this.cards.delete(id);
              }
              this.#release(id, tab);
            }
            for (const id of ids) if (!mine.has(id)) take(id);
          },
          tryServe: async (id) => {
            if (this.holders.has(id)) return this.holders.get(id) === tab;
            take(id);
            return true;
          },
          owns: (id) => this.holders.get(id) === tab,
          held: async (id) => this.holders.has(id),
          publish: async (cards) => {
            for (const { id, card } of cards) {
              if (this.holders.get(id) === tab) this.cards.set(id, { tab, card, at: Date.now() });
            }
          },
          roster: async () =>
            [...this.cards]
              .filter(([id]) => this.holders.get(id) !== tab)
              .map(([id, { card, at }]) => ({ id, card, at, live: this.holders.has(id) })),
          post: async (mail, { most, repeatMs }) => {
            const waits = this.mail.filter((each) => each.to === mail.to);
            if (
              waits.some(
                (each) =>
                  each.from === mail.from &&
                  each.text === mail.text &&
                  mail.at - each.at < repeatMs,
              )
            ) {
              return "repeat";
            }
            if (waits.length >= most) return "full";
            this.mail.push(structuredClone(mail));
            const holder = this.rooms.get(this.holders.get(mail.to) ?? -1);
            if (holder?.open) queueMicrotask(() => holder.events.mail(mail.to));
            return "posted";
          },
          claim: async (to) => {
            const free = (each: { claimedBy?: number | undefined }) =>
              each.claimedBy === undefined ||
              (each.claimedBy !== tab && this.rooms.get(each.claimedBy)?.open !== true);
            const taken = this.mail.filter((each) => each.to === to && free(each));
            this.mail = this.mail.map((each) =>
              taken.includes(each) ? { ...each, claimedBy: tab } : each,
            );
            return taken.map(({ claimedBy: _claimedBy, ...each }) => each);
          },
          done: async (ids) => {
            this.mail = this.mail.filter((each) => !ids.includes(each.id));
          },
          back: giveBack,
          want: (id, asked) => {
            const holder = this.rooms.get(this.holders.get(id) ?? -1);
            if (holder?.open && this.holders.get(id) !== tab) {
              queueMicrotask(() => holder.events.wanted?.(id, asked));
            }
          },
          yieldTo: (id) => {
            if (this.holders.get(id) !== tab) return;
            this.#release(id, tab);
            take(id);
          },
          gone: (id) => {
            for (const [other, each] of this.rooms) {
              if (other !== tab && each.open) queueMicrotask(() => each.events.gone?.(id));
            }
          },
          answer: (mail, outcome) => {
            const done = this.waiting.get(mail);
            if (done) queueMicrotask(() => done(structuredClone(outcome)));
          },
          outcome: (mail, ms) =>
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve(undefined), ms);
              this.waiting.set(mail, (outcome) => {
                clearTimeout(timer);
                resolve(outcome);
              });
            }),
          watch: async (target, watcher, until) => {
            this.watches.push({ target, watcher, until });
          },
          watchers: async (target) => {
            const taken = this.watches.filter((each) => each.target === target);
            this.watches = this.watches.filter((each) => each.target !== target);
            return taken;
          },
          forget: async (id) => {
            this.cards.delete(id);
            this.mail = this.mail.filter((each) => each.to !== id);
            this.watches = this.watches.filter((each) => each.target !== id);
          },
          budget: {
            get: () => this.budget,
            add: (count) => {
              this.budget = Math.max(0, this.budget + count);
              this.#told(tab);
            },
            reset: () => {
              this.budget = 0;
              this.#told(tab);
            },
          },
          close: () => {
            for (const id of Array.from(mine)) this.#release(id, tab);
            void giveBack(
              this.mail.filter((each) => each.claimedBy === tab).map((each) => each.id),
            );
            room.open = false;
          },
        };
      },
    };
  }

  #told(from: number) {
    for (const [tab, room] of this.rooms) {
      if (tab !== from && room.open) room.events.budget();
    }
  }
}

/** A tab of the browser, with the project open and the conversations of the browser. */
function openTab(browser: Browser, number: number, chats: ChatStore) {
  const values = new Map<string, unknown>();
  const settings: SettingsStore = {
    load: async (key) => values.get(key),
    save: async (key, value) => void values.set(key, structuredClone(value)),
    listen: () => () => {},
  };
  const ai = new AiSettingsStore(settings, memoryKeys(), {
    saveFailed: () => {},
    keyFailed: () => {},
  });
  const store = ProjectStore.create(createProject({ name: "一个项目" }));
  let fake: FakeEndpoint | undefined;
  const problems = new ProblemSet({ reports: ["runtime"] });
  const chat = new ChatSession({
    chats,
    ai,
    packs: new ModelPacks(settings, { saveFailed: () => {} }),
    account: undefined,
    project: () => ({ store, key: "p1" }),
    subscribeProject: () => () => {},
    selection: () => undefined,
    problems: () => problems,
    undone: () => {},
    fake: () => fake,
    post: browser.tab(number),
    ask: async () => ({ ok: false }),
  });
  return { ai, chat, fake: (endpoint: FakeEndpoint) => (fake = endpoint) };
}

const sendTo = (to: string, message: string) => ({ name: "aq_send", args: { to, message } });
const entriesOf = (chat: ChatSession, id: string) =>
  chat.conversationOf(id)?.getSnapshot().entries ?? [];
const resultOf = (chat: ChatSession, id: string, name: string) =>
  entriesOf(chat, id).findLast((entry) => entry.role === "tool" && entry.name === name);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Two tabs: B in the second, with one turn; the first shows a new conversation. */
async function twoTabs() {
  const browser = new Browser();
  const chats = memoryChats();
  const one = openTab(browser, 1, chats);
  const two = openTab(browser, 2, chats);
  await settle();
  two.fake({ fake: [{ text: "我管配乐" }] });
  await two.chat.send("配乐");
  const b = two.chat.getSnapshot().id as string;
  await settle();
  return { browser, chats, one, two, b };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("conversations in several tabs of a browser (chat6 technical design, 6.2)", () => {
  it("sees one of another tab, and it answers there in a turn of its own", async () => {
    const { one, two, b } = await twoTabs();
    await vi.waitFor(async () => {
      const cards = await one.chat.agentsFor("mcp:s", () => "工具").list();
      expect(cards).toContainEqual(
        expect.objectContaining({ id: b, name: "配乐", state: "idle", where: "tab" }),
      );
    });
    two.fake({ fake: [{ text: "不换了" }] });
    one.fake({ fake: [{ calls: [sendTo("配乐", "配乐还换吗")] }, { text: "问过了" }] });
    await one.chat.send("剪开场");
    const a = one.chat.getSnapshot().id as string;
    expect(resultOf(one.chat, a, "aq_send")).toMatchObject({
      ok: true,
      data: { to: { id: b }, outcome: { sent: "turn" } },
    });
    await vi.waitFor(() => expect(entriesOf(two.chat, b).at(-1)).toMatchObject({ text: "不换了" }));
    expect(
      entriesOf(two.chat, b)
        .filter((entry) => entry.role === "user")
        .at(-1),
    ).toMatchObject({
      text: "配乐还换吗",
      from: { id: a, name: "剪开场", kind: "chat" },
    });
    // The tab that sent does not open it as well: one tab has it.
    expect(one.chat.conversationOf(b)).toBeUndefined();
  });

  it("leaves a message for one whose tab went away, which it gets once a tab opens it again", async () => {
    const { browser, chats, one, b } = await twoTabs();
    await vi.waitFor(async () => {
      expect(await one.chat.agentsFor("mcp:s", () => "工具").list()).toContainEqual(
        expect.objectContaining({ id: b, where: "tab" }),
      );
    });
    browser.crash(2);
    expect(await one.chat.agentsFor("mcp:s", () => "工具").list()).toContainEqual(
      expect.objectContaining({ id: b, state: "away" }),
    );
    one.fake({ fake: [{ calls: [sendTo("配乐", "回来后看看配乐")] }, { text: "留了言" }] });
    await one.chat.send("剪开场");
    const a = one.chat.getSnapshot().id as string;
    expect(resultOf(one.chat, a, "aq_send")).toMatchObject({
      data: { outcome: { sent: "waits", until: "away" } },
    });
    expect((resultOf(one.chat, a, "aq_send") as { text?: string } | undefined)?.text).toContain(
      "its tab was closed",
    );
    // Nothing of it runs here meanwhile.
    expect(one.chat.conversationOf(b)).toBeUndefined();
    const three = openTab(browser, 3, chats);
    three.fake({ fake: [{ text: "看到留言了" }] });
    await three.chat.open(b);
    await vi.waitFor(() =>
      expect(entriesOf(three.chat, b).at(-1)).toMatchObject({ text: "看到留言了" }),
    );
    expect(
      entriesOf(three.chat, b)
        .filter((entry) => entry.role === "user")
        .at(-1),
    ).toMatchObject({
      text: "回来后看看配乐",
      from: { id: a },
    });
    expect(browser.mail).toEqual([]);
  });

  it("an AI tool's message left so, or one left long ago, waits for people as a card", async () => {
    const { browser, chats, one, b } = await twoTabs();
    await vi.waitFor(() => expect(browser.cards.has(b)).toBe(true));
    browser.crash(2);
    expect(await one.chat.agentsFor("mcp:s", () => "Claude Code").send(b, "在吗")).toEqual({
      sent: "waits",
      until: "away",
    });
    expect(await one.chat.agentsFor("mcp:s", () => "Claude Code").send(b, "在吗")).toEqual({
      refused: "repeat",
    });
    const fromA = one.chat.agentsFor("mcp:t", () => "Codex");
    expect(await fromA.send(b, "隔了很久的话")).toEqual({ sent: "waits", until: "away" });
    browser.mail = browser.mail.map((each) =>
      each.text === "隔了很久的话"
        ? {
            ...each,
            from: "chat-old",
            body: {
              ...(each.body as object),
              from: { id: "chat-old", name: "以前的对话", kind: "chat" },
              at: Date.now() - 13 * 60 * 60 * 1000,
            },
          }
        : each,
    );
    const three = openTab(browser, 3, chats);
    await three.chat.open(b);
    await vi.waitFor(() => expect(three.chat.getSnapshot().mail).toHaveLength(2));
    expect(three.chat.getSnapshot().mail).toEqual([
      expect.objectContaining({ text: "在吗", from: expect.objectContaining({ kind: "tool" }) }),
      expect.objectContaining({
        text: "隔了很久的话",
        from: expect.objectContaining({ kind: "chat" }),
      }),
    ]);
    expect(three.chat.runningCount).toBe(0);
    expect(entriesOf(three.chat, b).filter((entry) => entry.role === "user")).toHaveLength(1);
  });

  it(
    "a tab that has one too takes over once the tab that had it crashes, with what waited",
    {
      timeout: 15_000,
    },
    async () => {
      const { browser, one, two, b } = await twoTabs();
      await one.chat.open(b);
      await settle();
      expect(browser.holders.get(b)).toBe(2);
      // The second tab goes on with it meanwhile.
      two.fake({ fake: [{ text: "第二轮" }] });
      await two.chat.send("再来一轮");
      // The second tab is busy and does not take it yet: the message waits for it.
      browser.rooms.get(2)!.open = false;
      expect(await one.chat.agentsFor("mcp:s", () => "工具").send(b, "接着做")).toEqual({
        sent: "waits",
        until: "tab",
      });
      one.fake({ fake: [{ text: "我接着做" }] });
      browser.crash(2);
      await vi.waitFor(
        () => expect(entriesOf(one.chat, b).at(-1)).toMatchObject({ text: "我接着做" }),
        {
          timeout: 5_000,
        },
      );
      expect(browser.holders.get(b)).toBe(1);
      // What this tab had of it was older: it read it again before it went on, so nothing of the
      // other tab's turn is lost.
      expect(
        entriesOf(one.chat, b).flatMap((entry) => (entry.role === "assistant" ? [entry.text] : [])),
      ).toEqual(["我管配乐", "第二轮", "我接着做"]);
    },
  );

  it("counts the turns nobody was there for in all tabs; people saying something in one lets all go on", async () => {
    const { browser, one, two, b } = await twoTabs();
    browser.budget = 10;
    expect(await one.chat.agentsFor("mcp:s", () => "工具").send(b, "先等等")).toMatchObject({
      sent: "waits",
    });
    await settle();
    expect(two.chat.getSnapshot().held).toBe(true);
    expect(entriesOf(two.chat, b).filter((entry) => entry.role === "user")).toHaveLength(1);
    two.fake({ fake: [{ text: "等到了" }] });
    one.fake({ fake: [{ text: "好" }] });
    await one.chat.send("人说了一句");
    await vi.waitFor(() => expect(entriesOf(two.chat, b).at(-1)).toMatchObject({ text: "等到了" }));
    expect(two.chat.getSnapshot().held).toBe(false);
  });

  it("forgets what waits for one deleted, and who waits for it to be idle", async () => {
    const { browser, one, two, b } = await twoTabs();
    browser.rooms.get(2)!.open = false;
    await one.chat.agentsFor("mcp:s", () => "工具").send(b, "给删掉的");
    expect(browser.mail).toHaveLength(1);
    browser.rooms.get(2)!.open = true;
    await two.chat.remove(b);
    expect(browser.mail).toEqual([]);
    expect(browser.cards.has(b)).toBe(false);
  });

  it("keeps a message a tab took and did not get to: once that tab crashes, the next one gets it", async () => {
    const { browser, chats, one, two, b } = await twoTabs();
    two.ai.setFromAgents("ask");
    const tool = one.chat.agentsFor("mcp:s", () => "Claude Code");
    expect(await tool.send(b, "在吗")).toMatchObject({ sent: "waits" });
    await vi.waitFor(() => expect(two.chat.getSnapshot().mail).toHaveLength(1));
    // Still kept, as taken by the second tab, which waits for people.
    expect(browser.mail).toHaveLength(1);
    browser.crash(2);
    const three = openTab(browser, 3, chats);
    three.ai.setFromAgents("ask");
    await three.chat.open(b);

    await vi.waitFor(() =>
      expect(three.chat.getSnapshot().mail).toEqual([expect.objectContaining({ text: "在吗" })]),
    );
    // Answered: it goes.
    three.chat.answerMail(three.chat.getSnapshot().mail[0]?.id ?? "", false);
    await vi.waitFor(() => expect(browser.mail).toEqual([]));
  });

  it("one tab at a time has a conversation: another that opens it reads it, and takes it here when asked", async () => {
    const { browser, one, two, b } = await twoTabs();
    await one.chat.open(b);
    await vi.waitFor(() => expect(one.chat.getSnapshot().elsewhere).toBe(true));
    // Nothing goes on in it here.
    expect(await one.chat.send("这里能说吗")).toBeUndefined();
    expect(entriesOf(one.chat, b).filter((entry) => entry.role === "user")).toHaveLength(1);
    // The second tab shows it: it lets go only where people here ask for it.
    await settle();
    expect(browser.holders.get(b)).toBe(2);
    one.chat.takeHere();
    await vi.waitFor(() => expect(browser.holders.get(b)).toBe(1));
    await vi.waitFor(() => expect(one.chat.getSnapshot().elsewhere).toBe(false));
    expect(two.chat.getSnapshot().elsewhere).toBe(true);
    one.fake({ fake: [{ text: "这边接着" }] });
    await one.chat.send("这里接着");
    expect(entriesOf(one.chat, b).at(-1)).toMatchObject({ text: "这边接着" });
    expect(await two.chat.send("那边还能说吗")).toBeUndefined();
  });

  it("a tab that keeps one only for messages lets go of it for a tab that opens it", async () => {
    const { browser, one, two, b } = await twoTabs();
    // B is no longer shown in the second tab, which keeps it.
    two.chat.newConversation();
    await settle();
    expect(browser.holders.get(b)).toBe(2);
    await one.chat.open(b);
    await vi.waitFor(() => expect(browser.holders.get(b)).toBe(1));
    await vi.waitFor(() => expect(one.chat.getSnapshot().elsewhere).toBe(false));
    expect(two.chat.conversationOf(b)).toBeUndefined();
  });

  it("writes nothing of a conversation another tab has: taking it over loses nothing of that tab", async () => {
    const { browser, chats, one, two, b } = await twoTabs();
    await one.chat.open(b);
    await vi.waitFor(() => expect(one.chat.getSnapshot().elsewhere).toBe(true));
    // People change something of it here meanwhile: it is not written over the other tab's.
    one.chat.setPlanFirst(true);
    two.fake({ fake: [{ text: "那边又说了一轮" }] });
    await two.chat.send("再来");
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const kept = await chats.load("p1", b);
    expect(kept?.entries.at(-1)).toMatchObject({ text: "那边又说了一轮" });
    browser.crash(2);
    await vi.waitFor(() => expect(one.chat.getSnapshot().elsewhere).toBe(false));
    await vi.waitFor(() =>
      expect(entriesOf(one.chat, b).at(-1)).toMatchObject({ text: "那边又说了一轮" }),
    );
  });

  it("deleted in one tab: the tab that has it stops and lets go, and does not write it again", async () => {
    const { chats, one, two, b } = await twoTabs();
    await one.chat.remove(b);
    await vi.waitFor(() => expect(two.chat.conversationOf(b)).toBeUndefined());
    expect(two.chat.getSnapshot().id).not.toBe(b);
    two.fake({ fake: [{ text: "新的" }] });
    await two.chat.send("新对话");
    await two.chat.flush();
    expect((await chats.list("p1")).map((each) => each.id)).not.toContain(b);
  });
});
