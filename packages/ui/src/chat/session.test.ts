import type { FakeEndpoint } from "@animaquill/agent";
import { ProblemSet, ProjectStore, withId, type UndoResult } from "@animaquill/core";
import {
  memoryChats,
  memoryKeys,
  type AccountAccess,
  type AccountSnapshot,
  type AiRelay,
  type SettingsStore,
} from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPacks } from "./packs.ts";
import { ChatSession } from "./session.ts";
import { AiSettingsStore } from "./settings.ts";

/** An account that is in whatever state a test says. */
function accountIn(status: AccountSnapshot["status"]): AccountAccess {
  const snapshot = (
    status === "signedIn" ? { status, name: "someone", appInstalled: true } : { status }
  ) as AccountSnapshot;
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    refresh: async () => {},
    takeOutcome: () => undefined,
    signIn: () => {},
    installApp: () => {},
    signOut: async () => {},
  };
}

/** The relay of a platform, as apps/web has one: https on its port only. */
const RELAY: AiRelay = {
  addressOf(baseUrl) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.port) return undefined;
    return `https://platform.example/relay/https/${url.hostname}${url.pathname.replace(/\/$/, "")}`;
  },
  headers: { "x-from-the-page": "1" },
};

function setup(where: { relay?: AiRelay; account?: AccountAccess } = {}) {
  const values = new Map<string, unknown>();
  const settings: SettingsStore = {
    load: async (key) => values.get(key),
    save: async (key, value) => void values.set(key, structuredClone(value)),
    listen: () => () => {},
  };
  const ai = new AiSettingsStore(
    settings,
    memoryKeys(),
    {
      saveFailed: () => {},
      keyFailed: () => {},
    },
    where.relay,
  );
  const chats = memoryChats();
  const first = ProjectStore.create(createProject({ name: "第一个" }));
  let project: { store: ProjectStore; key: string } | undefined = { store: first, key: "p1" };
  const listeners = new Set<() => void>();
  const undone: UndoResult[] = [];
  let fake: FakeEndpoint | undefined;
  const problems = new ProblemSet({ reports: ["runtime"] });
  const packs = new ModelPacks(settings, { saveFailed: () => {} });
  const chat = new ChatSession({
    chats,
    ai,
    packs,
    account: where.account,
    project: () => project,
    subscribeProject: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selection: () => undefined,
    problems: () => problems,
    undone: (result) => undone.push(result),
    fake: () => fake,
  });
  const open = (next: typeof project) => {
    project = next;
    for (const listener of listeners) listener();
  };
  const markers = (store = first) => Object.values(store.getState().timelines.main?.markers ?? {});
  return {
    ai,
    packs,
    chat,
    chats,
    first,
    values,
    undone,
    open,
    markers,
    problems,
    fake: (endpoint: FakeEndpoint) => (fake = endpoint),
  };
}

const addMarker = (time: string) => ({
  name: "aq_edit",
  args: { operations: [{ op: "marker.add", timeline: "main", time }] },
});
const rename = (name: string) => ({
  name: "aq_edit",
  args: { operations: [{ op: "project.rename", name }] },
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the chat", () => {
  it("says what is missing before a message can go out", async () => {
    const { ai, chat } = setup();
    await chat.send("你好");
    expect(chat.getSnapshot().hold).toBe("noService");
    const id = ai.add("deepseek", "DeepSeek") as string;
    await chat.send("你好");
    expect(chat.getSnapshot().hold).toBe("noModel");
    ai.update(id, { model: "deepseek-chat", route: "relay" });
    // Nowhere to relay to, as on this computer.
    await chat.send("你好");
    expect(chat.getSnapshot().hold).toBe("relayMissing");
    expect(chat.getSnapshot().conversation?.getSnapshot().entries).toEqual([]);
  });

  it("goes through the relay of the platform, for whoever is signed in to it", async () => {
    const sent: { url: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers ?? {}) });
      return new Response(
        `data: ${JSON.stringify({
          id: "c",
          object: "chat.completion.chunk",
          created: 1,
          model: "kimi-k2",
          choices: [{ index: 0, delta: { content: "好" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    try {
      const signedOut = setup({ relay: RELAY, account: accountIn("signedOut") });
      const kimi = signedOut.ai.add("moonshot", "Kimi") as string;
      signedOut.ai.update(kimi, { model: "kimi-k2" });
      expect(signedOut.ai.current?.route).toBe("relay");
      await signedOut.chat.send("你好");
      expect(signedOut.chat.getSnapshot().hold).toBe("relaySignIn");
      expect(sent).toEqual([]);

      const { ai, chat } = setup({ relay: RELAY, account: accountIn("signedIn") });
      const id = ai.add("moonshot", "Kimi") as string;
      ai.update(id, { model: "kimi-k2" });
      await ai.setKey(id, "sk-moonshot-0123456789");
      const outcome = await chat.send("你好");
      expect(outcome).toMatchObject({ end: "done", relayed: true });
      expect(sent.map(({ url }) => url)).toEqual([
        "https://platform.example/relay/https/api.moonshot.cn/v1/chat/completions",
      ]);
      expect(sent[0]?.headers.get("x-from-the-page")).toBe("1");
      expect(sent[0]?.headers.get("authorization")).toBe("Bearer sk-moonshot-0123456789");

      // An address the relay does not take: said before anything goes out.
      ai.update(id, { baseUrl: "https://api.moonshot.cn:8443/v1" });
      await chat.send("再来");
      expect(chat.getSnapshot().hold).toBe("relayUrl");
      expect(sent).toHaveLength(1);
      // Straight, the relay has nothing to do with it.
      ai.update(id, { baseUrl: "https://api.moonshot.cn/v1", route: "direct" });
      await chat.send("直连");
      expect(sent.at(-1)?.url).toBe("https://api.moonshot.cn/v1/chat/completions");
      expect(sent.at(-1)?.headers.has("x-from-the-page")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lets people take back what a task changed, and do it again", async () => {
    const { chat, fake, markers, undone } = setup();
    fake({ fake: [{ calls: [addMarker("1"), addMarker("2")] }, { text: "加好了" }] });
    const outcome = await chat.send("加两个标记");
    expect(outcome?.end).toBe("done");
    expect(markers()).toHaveLength(2);
    const task = outcome?.task as string;
    expect(chat.undoState(task)).toBe("undo");

    chat.undoTask(task);
    expect(markers()).toHaveLength(0);
    expect(undone.at(-1)?.ok).toBe(true);
    expect(chat.undoState(task)).toBe("redo");
    chat.redoTask(task);
    expect(markers()).toHaveLength(2);
  });

  it("keeps conversations by project, and comes back to the last one", async () => {
    const { chat, chats, fake, open, first } = setup();
    fake({ fake: [{ text: "第一个项目的回答" }] });
    await chat.send("第一个项目");
    await chat.flush();
    expect((await chats.list("p1")).map(({ title }) => title)).toEqual(["第一个项目"]);

    const second = ProjectStore.create(createProject({ name: "第二个" }));
    open({ store: second, key: "p2" });
    expect(chat.getSnapshot().conversation?.getSnapshot().entries).toEqual([]);

    open({ store: first, key: "p1" });
    await vi.waitFor(() =>
      expect(chat.getSnapshot().conversation?.getSnapshot().entries).toHaveLength(2),
    );
    chat.newConversation();
    expect(chat.getSnapshot().conversation?.getSnapshot().entries).toEqual([]);
    expect(chat.getSnapshot().saved).toHaveLength(1);
  });

  it("keeps what AI read with the conversation, and goes on from it when it is opened again", async () => {
    const { chat, chats, fake, first } = setup();
    fake({ fake: [{ calls: [{ name: "aq_project_status", args: {} }] }, { text: "看过了" }] });
    await chat.send("看看项目");
    await chat.flush();
    const id = chat.getSnapshot().id as string;
    const kept = await chats.load("p1", id);
    expect(kept?.caller).toMatchObject({ version: 1, lastRead: expect.any(String) });

    // A new conversation has read nothing: a change of what is there is refused.
    chat.newConversation();
    fake({ fake: [{ calls: [rename("新名字")] }, { text: "x" }] });
    await chat.send("改名");
    expect(first.getState().manifest.name).toBe("第一个");
    const results = [
      ...(chat
        .getSnapshot()
        .conversation?.resultsOf(chat.getSnapshot().conversation?.tasks.at(-1) ?? "")
        .values() ?? []),
    ];
    expect(results[0]?.text).toContain("error not-read");

    // The one from before has: it goes on.
    await chat.open(id);
    fake({ fake: [{ calls: [rename("新名字")] }, { text: "改好了" }] });
    await chat.send("改名");
    expect(first.getState().manifest.name).toBe("新名字");
  });

  it("has what scene code threw only in aq_check_run, after the code changed", async () => {
    const { chat, fake, problems } = setup();
    let written = "";
    let checked = "";
    fake({
      fake: [
        {
          calls: [
            { name: "aq_file_write", args: { path: "code/move.js", text: "export const a = ;\n" } },
          ],
        },
        (results) => {
          written = results.at(-1)?.text ?? "";
          // The editor ran the code meanwhile, and it threw.
          problems.report("runtime", "scenes", [
            withId({
              source: "runtime",
              severity: "error",
              code: "scene-error",
              params: {},
              file: "code/move.js",
              line: 1,
              detail: "SyntaxError: Unexpected token ';'",
            }),
          ]);
          return { calls: [{ name: "aq_check_run", args: {} }] };
        },
        (results) => ((checked = results.at(-1)?.text ?? ""), { text: "查过了" }),
      ],
    });
    await chat.send("写一段代码");
    expect(written).toContain("wrote code/move.js");
    expect(written).not.toContain("scene-error");
    expect(checked).toContain("scene-error");
    expect(checked).toContain("SyntaxError: Unexpected token");
    // A list of what is wrong: nothing in it tells the model what to do about it.
    expect(checked).not.toMatch(/\bfix (the|it|them)\b|\byou should\b/i);
  });

  it("keeps the last answer as soon as the task ends, for people who leave right after", async () => {
    // Nothing that waits gets to run: what is kept, is kept when the task ends.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { chat, chats, fake } = setup();
      fake({ fake: [{ calls: [addMarker("1")] }, { text: "加好了" }] });
      await chat.send("加一个标记");
      const kept = await chats.load("p1", chat.getSnapshot().id as string);
      expect(kept?.entries.at(-1)).toMatchObject({ role: "assistant", text: "加好了" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a task when the project goes, and does not touch the next one", async () => {
    const { chat, fake, open, markers } = setup();
    const second = ProjectStore.create(createProject({ name: "第二个" }));
    let switched = false;
    fake({
      fake: [
        { text: "先说点什么", calls: [addMarker("1")] },
        () => {
          if (!switched) {
            switched = true;
            open({ store: second, key: "p2" });
          }
          return { calls: [addMarker("2")] };
        },
        { text: "x" },
      ],
    });
    const outcome = await chat.send("加标记");
    expect(outcome?.end).toBe("stopped");
    expect(markers()).toHaveLength(1);
    expect(markers(second)).toHaveLength(0);
  });
});

describe("AI services", () => {
  it("keep keys apart from settings, and know them only to leave them out of reports", async () => {
    const { ai, values } = setup();
    const id = ai.add("anthropic", "Anthropic") as string;
    await ai.setKey(id, "  sk-ant-secret-0123456789  ");
    expect(ai.getSnapshot().keyed.has(id)).toBe(true);
    expect(await ai.keyOf(id)).toBe("sk-ant-secret-0123456789");
    expect(ai.knownKeys.has("sk-ant-secret-0123456789")).toBe(true);
    expect(JSON.stringify([...values])).not.toContain("secret");
    expect(JSON.stringify(ai.getSnapshot().services)).not.toContain("secret");

    await ai.remove(id);
    expect(ai.getSnapshot().keyed.has(id)).toBe(false);
    expect(ai.getSnapshot().services).toEqual([]);
  });

  it("show the hidden model packs and hide them again", () => {
    const { ai } = setup();
    ai.setShowHiddenPacks(true);
    expect(ai.getSnapshot().showHiddenPacks).toBe(true);
    ai.setShowHiddenPacks(false);
    expect(ai.getSnapshot().showHiddenPacks).toBeUndefined();
  });

  it("start straight where there is no relay, also those that need one", () => {
    const withRelay = setup({ relay: RELAY }).ai;
    withRelay.add("zhipu", "智谱");
    expect(withRelay.current?.route).toBe("relay");
    expect(withRelay.canRelay).toBe(true);
    const here = setup().ai;
    here.add("zhipu", "智谱");
    expect(here.current?.route).toBe("direct");
    expect(here.canRelay).toBe(false);
  });

  it("start with what their kind has, and the first one is the one in use", () => {
    const { ai } = setup();
    const id = ai.add("google", "Gemini") as string;
    ai.add("deepseek", "DeepSeek");
    expect(ai.current).toMatchObject({
      id,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      route: "direct",
      model: "",
    });
    ai.setMaxToolCalls(9999);
    expect(ai.getSnapshot().maxToolCalls).toBe(500);
  });
});

/** A pack someone else wrote for a model, as one pack.json. */
const PACK = {
  format: 1,
  id: "someone/deepseek",
  name: "DeepSeek steady",
  version: "1.0.0",
  author: "Someone",
  models: ["deepseek-*"],
  call: { reasoning: "low" },
  system: { extra: "Keep batches small." },
};

const packFiles = (manifest: object = PACK) => new Map([["pack.json", JSON.stringify(manifest)]]);

describe("the model pack of a conversation", () => {
  const answers = (chat: ChatSession) =>
    (chat.getSnapshot().conversation?.getSnapshot().entries ?? []).filter(
      (entry) => entry.role === "assistant",
    );

  it("is the one for its model, recorded with every answer, with no pack the default", async () => {
    const { chat, fake } = setup();
    fake({ model: "claude-opus-5-5", fake: [{ text: "好" }] });
    await chat.send("你好");
    expect(answers(chat).at(-1)).toMatchObject({
      model: "claude-opus-5-5",
      texts: { id: "animaquill/claude-5", version: "1.0.0" },
      pack: { name: "Claude 5", builtin: true, by: "matched" },
    });
    chat.newConversation();
    fake({ model: "deepseek-chat", fake: [{ text: "好" }] });
    await chat.send("你好");
    expect(answers(chat).at(-1)).toMatchObject({
      texts: { id: "animaquill/default" },
      pack: { by: "fallback" },
    });
  });

  it("stays while the model does, and is chosen again when the model changes", async () => {
    const { chat, fake, ai, packs } = setup();
    fake({ model: "deepseek-chat", fake: [{ text: "一" }] });
    await chat.send("一");
    expect(answers(chat).at(-1)?.texts?.id).toBe("animaquill/default");
    // A pack installed or chosen meanwhile comes with the next conversation, not this one.
    packs.install(packFiles(), { kind: "file", name: "pack.json" });
    ai.choosePack(["deepseek-chat"], "someone/deepseek");
    fake({ model: "deepseek-chat", fake: [{ text: "二" }] });
    await chat.send("二");
    expect(answers(chat).at(-1)?.texts?.id).toBe("animaquill/default");
    expect(chat.choiceFor("deepseek-chat").pack.id).toBe("someone/deepseek");
    // Another model: chosen again, here the pack for Claude 5.
    fake({ model: "claude-sonnet-5-5", fake: [{ text: "三" }] });
    await chat.send("三");
    expect(answers(chat).at(-1)).toMatchObject({
      model: "claude-sonnet-5-5",
      texts: { id: "animaquill/claude-5" },
    });
    // And back: the one people chose for it now.
    fake({ model: "deepseek-chat", fake: [{ text: "四" }] });
    await chat.send("四");
    expect(answers(chat).at(-1)).toMatchObject({
      texts: { id: "someone/deepseek", version: "1.0.0" },
      pack: { name: "DeepSeek steady", author: "Someone", by: "chosen" },
    });
  });

  it("keeps the version it began with when the pack is updated meanwhile", async () => {
    const { chat, fake, packs } = setup();
    packs.install(packFiles(), { kind: "file", name: "pack.json" });
    fake({ model: "deepseek-chat", fake: [{ text: "一" }] });
    await chat.send("一");
    const first = answers(chat).at(-1)?.texts;
    expect(first).toMatchObject({ id: "someone/deepseek", version: "1.0.0" });
    packs.install(packFiles({ ...PACK, version: "1.0.1", system: { extra: "Other words." } }), {
      kind: "file",
      name: "pack.json",
    });
    fake({ model: "deepseek-chat", fake: [{ text: "二" }] });
    await chat.send("二");
    expect(answers(chat).at(-1)?.texts).toEqual(first);
    // The next conversation has the update.
    chat.newConversation();
    fake({ model: "deepseek-chat", fake: [{ text: "三" }] });
    await chat.send("三");
    expect(answers(chat).at(-1)?.texts).toMatchObject({
      id: "someone/deepseek",
      version: "1.0.1",
    });
  });

  it("is chosen again when it is gone, and the history still goes as it was", async () => {
    const { chat, fake, packs, ai } = setup();
    packs.install(packFiles(), { kind: "file", name: "pack.json" });
    fake({ model: "deepseek-chat", fake: [{ calls: [addMarker("1")] }, { text: "一" }] });
    await chat.send("一");
    expect(answers(chat).at(-1)?.texts?.id).toBe("someone/deepseek");
    packs.remove("someone/deepseek");
    ai.forgetPack("someone/deepseek");
    const endpoint: FakeEndpoint = { model: "deepseek-chat", fake: [{ text: "二" }] };
    fake(endpoint);
    expect((await chat.send("二"))?.end).toBe("done");
    expect(answers(chat).at(-1)).toMatchObject({
      texts: { id: "animaquill/default" },
      pack: { by: "fallback" },
    });
  });

  it("is the words to compare with only for a model people chose them for, to the end", async () => {
    const { chat, fake, ai } = setup();
    fake({ model: "claude-opus-5-5", fake: [{ text: "好" }] });
    await chat.send("你好");
    expect(answers(chat).at(-1)?.texts?.id).toBe("animaquill/claude-5");
    chat.newConversation();
    chat.choosePack("claude-opus-5-5", "animaquill/eval-directive");
    fake({ model: "claude-opus-5-5", fake: [{ text: "好" }] });
    await chat.send("你好");
    expect(answers(chat).at(-1)).toMatchObject({
      texts: { id: "animaquill/eval-directive", version: "2026.1" },
      pack: { by: "chosen", builtin: true },
    });
    // Back to the one recommended: the conversation keeps them; a new one does not.
    chat.choosePack("claude-opus-5-5", undefined);
    expect(ai.getSnapshot().packFor).toBeUndefined();
    fake({ model: "claude-opus-5-5", fake: [{ text: "再" }] });
    await chat.send("再");
    expect(answers(chat).at(-1)?.texts?.id).toBe("animaquill/eval-directive");
    chat.newConversation();
    fake({ model: "claude-opus-5-5", fake: [{ text: "新" }] });
    await chat.send("新");
    expect(answers(chat).at(-1)?.texts?.id).toBe("animaquill/claude-5");
  });

  it("chosen where the model is picked, comes with the next answer; from the settings, the next conversation", async () => {
    const { chat, fake, packs, ai } = setup();
    packs.install(packFiles({ ...PACK, models: ["nothing-*"] }), {
      kind: "file",
      name: "pack.json",
    });
    fake({ model: "claude-opus-5-5", fake: [{ text: "一" }] });
    await chat.send("一");
    expect(answers(chat).at(-1)?.texts?.id).toBe("animaquill/claude-5");
    // From the settings: this conversation keeps its pack.
    ai.choosePack(["claude-opus-5-5"], "someone/deepseek");
    fake({ model: "claude-opus-5-5", fake: [{ text: "二" }] });
    await chat.send("二");
    expect(answers(chat).at(-1)?.texts?.id).toBe("animaquill/claude-5");
    // Where the model is picked: the next answer has it, and the ones after.
    chat.choosePack("claude-opus-5-5", "someone/deepseek", "now");
    fake({ model: "claude-opus-5-5", fake: [{ text: "三" }] });
    await chat.send("三");
    expect(answers(chat).at(-1)).toMatchObject({
      texts: { id: "someone/deepseek" },
      pack: { by: "chosen" },
    });
    fake({ model: "claude-opus-5-5", fake: [{ text: "四" }] });
    await chat.send("四");
    expect(answers(chat).at(-1)?.texts?.id).toBe("someone/deepseek");
    // Back to the one recommended, there too.
    chat.choosePack("claude-opus-5-5", undefined, "now");
    fake({ model: "claude-opus-5-5", fake: [{ text: "五" }] });
    await chat.send("五");
    expect(answers(chat).at(-1)).toMatchObject({
      texts: { id: "animaquill/claude-5" },
      pack: { by: "matched" },
    });
  });

  it("gives where models are picked the packs for a model: recommended, current, chosen", () => {
    const { chat, ai, packs } = setup();
    const ids = (model: string) =>
      chat
        .packOptions(model)
        .packs.map(({ pack, recommended, current }) =>
          [pack.id, recommended ? "recommended" : "", current ? "current" : ""]
            .filter(Boolean)
            .join(" "),
        );
    expect(chat.packOptions("claude-opus-5-5")).toMatchObject({
      chosen: false,
      recommended: { id: "animaquill/claude-5" },
      current: { id: "animaquill/claude-5" },
    });
    // The hidden one is not there until the settings show it.
    expect(ids("claude-opus-5-5")).toEqual([
      "animaquill/default",
      "animaquill/claude-5 recommended current",
    ]);
    packs.install(packFiles(), { kind: "file", name: "pack.json" });
    chat.choosePack("claude-opus-5-5", "someone/deepseek");
    expect(chat.packOptions("claude-opus-5-5")).toMatchObject({
      chosen: true,
      recommended: { id: "animaquill/claude-5" },
      current: { id: "someone/deepseek" },
    });
    expect(ids("claude-opus-5-5")).toEqual([
      "animaquill/default",
      "animaquill/claude-5 recommended",
      "someone/deepseek current",
    ]);
    // Only for that model.
    expect(chat.packOptions("deepseek-chat")).toMatchObject({
      chosen: false,
      current: { id: "someone/deepseek" },
    });
    ai.setShowHiddenPacks(true);
    expect(ids("claude-opus-5-5")).toContain("animaquill/eval-directive");
    ai.setShowHiddenPacks(false);
    chat.choosePack("claude-opus-5-5", "animaquill/eval-directive");
    // Chosen, it stays in the list while hidden.
    expect(ids("claude-opus-5-5")).toContain("animaquill/eval-directive current");
    chat.choosePack("claude-opus-5-5", undefined);
    expect(chat.packOptions("claude-opus-5-5")).toMatchObject({
      chosen: false,
      current: { id: "animaquill/claude-5" },
    });
  });
});

describe("model packs in this browser", () => {
  it("are kept as their files, checked again when read, and forgotten with people's choice", async () => {
    const { packs, ai, values } = setup();
    const check = packs.install(packFiles(), { kind: "file", name: "pack.json" });
    expect(check.pack?.id).toBe("someone/deepseek");
    ai.choosePack(["deepseek-chat"], "someone/deepseek");
    await Promise.resolve();
    const kept = values.get("ai.packs") as { packs: { files: Record<string, string> }[] };
    expect(Object.keys(kept.packs[0]?.files ?? {})).toEqual(["pack.json"]);
    // Another window reads them again as they are, with what this version does not have left out.
    const settings: SettingsStore = {
      load: async (key) => values.get(key),
      save: async () => {},
      listen: () => () => {},
    };
    const other = new ModelPacks(settings, { saveFailed: () => {} });
    await other.load();
    expect(other.getSnapshot().packs.map(({ id }) => id)).toEqual([
      "animaquill/default",
      "animaquill/claude-5",
      "animaquill/eval-directive",
      "someone/deepseek",
    ]);
    // What was changed where it is kept does not pass, and is not used.
    values.set("ai.packs", {
      packs: [
        {
          files: { "pack.json": JSON.stringify({ ...PACK, system: { extra: "a\u200bb" } }) },
          source: { kind: "file", name: "pack.json" },
          installedAt: 1,
        },
      ],
    });
    await other.load();
    expect(other.getSnapshot().installed[0]).toMatchObject({
      id: "someone/deepseek",
      pack: undefined,
    });
    expect(other.getSnapshot().packs.map(({ id }) => id)).not.toContain("someone/deepseek");
    packs.remove("someone/deepseek");
    ai.forgetPack("someone/deepseek");
    expect(ai.getSnapshot().packFor).toBeUndefined();
  });

  it("does not keep a pack that does not pass", () => {
    const { packs } = setup();
    const check = packs.install(packFiles({ ...PACK, scripts: { x: "y" } }), {
      kind: "file",
      name: "pack.json",
    });
    expect(check.problems.map(({ code }) => code)).toEqual(["scripts"]);
    expect(packs.getSnapshot().installed).toEqual([]);
  });
});
