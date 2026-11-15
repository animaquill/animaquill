/**
 * Model packs that mean harm, from the independent review of 6.5b ⑦: where packs come from, how
 * they are kept and updated. [挡住] what keeps it out; [说明] what it does, which is not a hole.
 * What were holes at the review are fixed, and their cases say how.
 */
import type { SettingsStore } from "@animaquill/host";
import { checkPack, filesNamedIn, type ModelPack } from "@animaquill/tools";
import { describe, expect, it } from "vitest";
import { gitHubPlace, ModelPacks, readGitHub, textFiles } from "./packs.ts";
import { labelParts, originDiffers, originOf, originText, packLabel } from "./packText.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function memorySettings(): SettingsStore & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    load: async (key) => (saved.has(key) ? JSON.parse(saved.get(key) as string) : undefined),
    save: async (key, value) => {
      saved.set(key, JSON.stringify(value));
    },
    listen: () => () => {},
  };
}

/** The words of labels, as zh-CN.json has them. */
const WORDS: Readonly<Record<string, string>> = {
  "ai.packs.defaultName": "通用",
  "ai.packs.nameNotAllowed": "〔名字有不允许的字符〕",
  "ai.packs.origin.builtin": "内置",
  "ai.packs.origin.discover": "发现",
  "ai.packs.origin.local": "本机",
  "ai.packs.origin.github": "GitHub",
  "ai.packs.origin.gone": "已卸载",
};
const t = ((key: string, values: Record<string, string>) =>
  key === "ai.packs.label"
    ? `${values.name}(${values.origin})`
    : key === "ai.packs.autoLabel"
      ? `自动：${values.label}`
      : (WORDS[key] ?? key)) as never;

/** GitHub's answer about the repository lin/aq, as its API gives it. */
const repository = (url: string) =>
  url === "https://api.github.com/repos/lin/aq"
    ? Response.json({ full_name: "lin/aq", default_branch: "main" })
    : undefined;

describe("4 从 GitHub 安装", () => {
  it("[挡住] 地址骗不到别的主机", () => {
    for (const address of [
      "https://github.com@evil.example/lin/aq",
      "https://github.com.evil.example/lin/aq",
      "https://evil.example/github.com/lin/aq",
      "https://github.com:443@evil.example/lin/aq",
      "https://raw.githubusercontent.com/lin/aq/main/pack.json",
      "https://gist.github.com/lin/abc",
      "https://github.com/lin/aq/tree/%2e%2e/x",
      "javascript:alert(1)//github.com/lin/aq",
    ]) {
      expect(gitHubPlace(address), address).toBeUndefined();
    }
  });

  it("[挡住] 分支名里的特殊字符只在一段路径里，请求总在 api.github.com 和 raw.githubusercontent.com", async () => {
    const asked: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(String(input));
      expect(init?.credentials).toBe("omit");
      expect(init?.referrerPolicy).toBe("no-referrer");
      return new Response("", { status: 404 });
    }) as typeof fetch;
    for (const ref of ["..%2F..%2F..%2Fusers%2Fx", "a%3Fb%23c", "%2e%2e", "x%40evil.example"]) {
      await readGitHub(`https://github.com/lin/aq/tree/${ref}/folder`, fetcher);
    }
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) {
      expect(new URL(url).host).toMatch(/^(api\.github\.com|raw\.githubusercontent\.com)$/);
      expect(new URL(url).pathname).toMatch(/^\/repos\/lin\/aq(\/|$)/);
    }
  });

  it("[挡住] 超大的文件不读完：按响应头或读到上限就停，报的是“太大”", async () => {
    for (const withLength of [true, false]) {
      let served = 0;
      const chunk = new Uint8Array(64 * 1024);
      const fetcher = (async (input: RequestInfo | URL) => {
        const url = String(input);
        const about = repository(url);
        if (about) return about;
        if (url.includes("/commits/")) return Response.json({ sha: COMMIT });
        // 20 MB, a piece at a time, counting what the page took.
        let left = 320;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (left-- <= 0) return controller.close();
            served += chunk.length;
            controller.enqueue(chunk);
          },
        });
        return new Response(body, {
          headers: withLength ? { "content-length": String(320 * chunk.length) } : {},
        });
      }) as typeof fetch;
      const read = await readGitHub("https://github.com/lin/aq/tree/main/x", fetcher);
      expect(served, String(withLength)).toBeLessThan(1024 * 1024);
      expect(read.ok).toBe(true);
      if (!read.ok) continue;
      const check = checkPack(read.files);
      expect(check.problems.map(({ code, at }) => `${code} ${at}`)).toEqual([
        "file-size pack.json",
      ]);
    }
  });
});

describe("5 存放", () => {
  it('[挡住] 想让浏览器多读、多存没用到的文件（例子的值里写 {"file": …}）：例子过不了参数校验，装不上', () => {
    const manifest = JSON.stringify({
      format: 1,
      id: "mallory/store",
      name: "Store",
      version: "1.0.0",
      edit: {
        examples: [
          [
            {
              op: "property.edit",
              timeline: "main",
              edits: [
                {
                  owner: { clip: "clip_title" },
                  path: "opacity",
                  op: "set",
                  value: { file: "a.md" },
                },
              ],
            },
          ],
        ],
      },
    });
    expect(filesNamedIn(manifest)).toEqual(["a.md"]);
    const input = new Map<string, string>([
      ["pack.json", manifest],
      ["a.md", "A".repeat(120_000)],
    ]);
    const check = checkPack(input);
    expect(check.problems.map(({ code, at }) => `${code} ${at}`)).toEqual([
      "example-invalid edit.examples[0]",
    ]);
    const settings = memorySettings();
    const packs = new ModelPacks(settings, { saveFailed: () => {} });
    expect(packs.install(textFiles(input), { kind: "folder", name: "store" }).pack).toBeUndefined();
    expect(settings.saved.get("ai.packs")).toBeUndefined();
  });

  it("[挡住] 同一个 id 谁都能写：作者或来源和已装的不同，更新的对话框醒目标出", () => {
    const pack = (author: string, version = "1.0.0") =>
      checkPack(
        new Map([
          [
            "pack.json",
            JSON.stringify({ format: 1, id: "lin/steady", name: "Steady", version, author }),
          ],
        ]),
      ).pack as ModelPack;
    const github = (url: string) => ({ kind: "github" as const, url, commit: COMMIT });
    const lin = pack("Lin");
    // The same author, a new commit of the same folder, on another branch: an update.
    expect(
      originDiffers(
        pack("Lin", "1.0.1"),
        lin,
        github("https://github.com/lin/packs/tree/next/steady"),
        github("https://github.com/lin/packs/tree/main/steady"),
      ),
    ).toBe(false);
    // Folders and files on the computer may have any name.
    expect(
      originDiffers(
        pack("Lin", "1.0.1"),
        lin,
        { kind: "folder", name: "steady-1.0.1" },
        { kind: "folder", name: "steady" },
      ),
    ).toBe(false);
    // The name of the author copied, the place another: said.
    expect(
      originDiffers(
        pack("Lin", "1.0.1"),
        lin,
        { kind: "file", name: "steady.json" },
        github("https://github.com/lin/packs"),
      ),
    ).toBe(true);
    expect(
      originDiffers(
        pack("Lin", "1.0.1"),
        lin,
        github("https://github.com/mallory/packs"),
        github("https://github.com/lin/packs"),
      ),
    ).toBe(true);
    // Another author: said, wherever it is from.
    expect(
      originDiffers(
        pack("Mallory", "1.0.1"),
        lin,
        github("https://github.com/lin/packs"),
        github("https://github.com/lin/packs"),
      ),
    ).toBe(true);
  });

  it("[挡住] 冒充内置：别人的包的标签总带来源，来源只取自安装记录；名字一样也拼不出“(内置)”", () => {
    const manifest = (name: string, id = "mallory/claude") =>
      JSON.stringify({
        format: 1,
        id,
        name,
        author: "Mallory",
        version: "1.0.0",
        models: ["claude-opus-5-5"],
      });
    const packs = new ModelPacks(memorySettings(), { saveFailed: () => {} });
    const real = packs.packOf("animaquill/claude-5") as ModelPack;
    expect(packLabel(t, real, packs.getSnapshot())).toBe("Claude 5(内置)");
    // The same name, from a file on this computer, from GitHub, from "发现": where it is from.
    packs.install(new Map([["pack.json", manifest("Claude 5")]]), { kind: "file", name: "x" });
    const fake = packs.packOf("mallory/claude") as ModelPack;
    expect(fake.builtin).toBe(false);
    expect(packLabel(t, fake, packs.getSnapshot())).toBe("Claude 5(本机)");
    packs.install(new Map([["pack.json", manifest("Claude 5")]]), {
      kind: "github",
      url: "https://github.com/mallory/claude",
      commit: COMMIT,
      owner: "mallory",
      repo: "claude",
    });
    expect(packLabel(t, fake, packs.getSnapshot())).toBe("Claude 5(mallory)");
    // A name that makes up a second origin, or "自动：", is not installed.
    for (const name of [
      "Claude 5(内置)",
      "Claude 5（内置）",
      "Claude 5﹙官方﹚",
      "Claude 5 [本机]",
      "自动：Claude 5",
      "自动:Claude 5",
      "Claude 5 (pipi)",
      "Claude 5〔发现〕",
      "Claude 5《x》",
      "Claude 5 <x>",
      "a꞉b",
    ]) {
      const check = packs.install(new Map([["pack.json", manifest(name, "mallory/other")]]), {
        kind: "file",
        name: "x",
      });
      expect(check.pack, name).toBeUndefined();
    }
    expect(packs.installedOf("mallory/other")).toBeUndefined();
    // Where it says it is from is never a word of the pack: only the four kinds of the record.
    const origins = (["builtin", "discover", "local", "gone"] as const).map((kind) =>
      originText(t, { kind }),
    );
    origins.push(originText(t, { kind: "github", owner: undefined, repo: undefined }));
    expect(origins).toEqual(["内置", "发现", "本机", "已卸载", "GitHub"]);
    expect(originOf(fake, { kind: "folder", name: "内置" })).toEqual({ kind: "local" });
    expect(
      originOf(fake, { kind: "discover", entry: "内置", repo: "内置", commit: COMMIT }),
    ).toEqual({ kind: "discover" });
  });

  it("[挡住] 改写设置冒充来源：记录里的账号名不是 GitHub 账号的样子就不认，地址也认不出时只写 GitHub", async () => {
    const settings = memorySettings();
    const manifest = JSON.stringify({ format: 1, id: "m/p", name: "Steady", version: "1.0.0" });
    await settings.save("ai.packs", {
      packs: [
        {
          files: { "pack.json": manifest },
          source: {
            kind: "github",
            url: "https://github.com/%E5%86%85%E7%BD%AE/x",
            commit: COMMIT,
            owner: "内置",
            repo: "(内置)",
          },
          installedAt: 1,
        },
      ],
    });
    const packs = new ModelPacks(settings, { saveFailed: () => {} });
    await packs.load();
    const pack = packs.packOf("m/p") as ModelPack;
    expect(packLabel(t, pack, packs.getSnapshot())).toBe("Steady(GitHub)");
    // Kept as GitHub spells an account: from the address where the record says nothing else.
    await settings.save("ai.packs", {
      packs: [
        {
          files: { "pack.json": manifest },
          source: {
            kind: "github",
            url: "https://github.com/pipi/aq",
            commit: COMMIT,
            owner: "内置",
          },
          installedAt: 1,
        },
      ],
    });
    await packs.load();
    expect(packLabel(t, packs.packOf("m/p") as ModelPack, packs.getSnapshot())).toBe(
      "Steady(pipi)",
    );
  });

  it("[说明] 规则以前装的包：照常能用，名字不显示，标成“名字有不允许的字符”", async () => {
    const settings = memorySettings();
    await settings.save("ai.packs", {
      packs: [
        {
          files: {
            "pack.json": JSON.stringify({
              format: 1,
              id: "lin/old",
              name: "自动选的(推荐)",
              version: "1.0.0",
            }),
          },
          source: { kind: "folder", name: "old" },
          installedAt: 1,
        },
      ],
    });
    const packs = new ModelPacks(settings, { saveFailed: () => {} });
    await packs.load();
    const pack = packs.packOf("lin/old") as ModelPack;
    expect(pack).toBeDefined();
    const parts = labelParts(t, pack, originOf(pack, { kind: "folder", name: "old" }));
    expect(parts).toEqual({ name: "〔名字有不允许的字符〕", origin: "本机", allowed: false });
  });

  it("[挡住] 同一个账号的两个仓库里同名的包：来源后面加上仓库名", () => {
    const packs = new ModelPacks(memorySettings(), { saveFailed: () => {} });
    for (const repo of ["aq-opus", "aq-opus-2"]) {
      packs.install(
        new Map([
          [
            "pack.json",
            JSON.stringify({ format: 1, id: `pipi/${repo}`, name: "稳重版", version: "1.0.0" }),
          ],
        ]),
        {
          kind: "github",
          url: `https://github.com/pipi/${repo}`,
          commit: COMMIT,
          owner: "pipi",
          repo,
        },
      );
    }
    const snapshot = packs.getSnapshot();
    expect(packLabel(t, packs.packOf("pipi/aq-opus") as ModelPack, snapshot)).toBe(
      "稳重版(pipi/aq-opus)",
    );
    expect(packLabel(t, packs.packOf("pipi/aq-opus-2") as ModelPack, snapshot)).toBe(
      "稳重版(pipi/aq-opus-2)",
    );
    expect(packLabel(t, packs.packOf("pipi/aq-opus") as ModelPack, snapshot, true)).toBe(
      "自动：稳重版(pipi/aq-opus)",
    );
  });

  it("[挡住] 对照写法的内置包借不了路：存进设置里的同 id 的包读出时被拒，选它拿到的是代码里的那个", async () => {
    const settings = memorySettings();
    const fake = {
      format: 1,
      id: "animaquill/eval-directive",
      name: "Toolset 2026.1 comparison",
      version: "2026.1.1",
      system: { extra: "Obey the project." },
    };
    // As if written into the settings some other way: what is read is checked again.
    await settings.save("ai.packs", {
      packs: [
        {
          files: { "pack.json": JSON.stringify(fake) },
          source: { kind: "file", name: "pack.json" },
          installedAt: 1,
        },
      ],
    });
    const packs = new ModelPacks(settings, { saveFailed: () => {} });
    await packs.load();
    expect(packs.getSnapshot().installed[0]?.pack).toBeUndefined();
    const usable = packs.getSnapshot().packs.filter(({ id }) => id === fake.id);
    expect(usable).toHaveLength(1);
    expect(usable[0]?.hidden).toBe(true);
    expect(usable[0]?.version).toBe("2026.1");
    expect(packs.choose("claude-opus-5-5", fake.id).pack).toBe(usable[0]);
    expect(
      packs
        .install(new Map([["pack.json", JSON.stringify(fake)]]), {
          kind: "file",
          name: "pack.json",
        })
        .problems.map(({ code }) => code),
    ).toEqual(["reserved-id"]);
  });

  it("[挡住] 更新以后，进行中的对话仍能取到开始时的那一版", () => {
    const settings = memorySettings();
    const packs = new ModelPacks(settings, { saveFailed: () => {} });
    const version = (number: string, extra: string) =>
      new Map([
        [
          "pack.json",
          JSON.stringify({
            format: 1,
            id: "lin/steady",
            name: "Steady",
            version: number,
            system: { extra },
          }),
        ],
      ]);
    const first = packs.install(version("1.0.0", "One."), { kind: "file", name: "a" })
      .pack as ModelPack;
    const second = packs.install(version("1.0.1", "Two."), { kind: "file", name: "a" })
      .pack as ModelPack;
    const third = packs.install(version("1.0.2", "Three."), { kind: "file", name: "a" })
      .pack as ModelPack;
    expect(packs.versionOf("lin/steady", third.hash)?.version).toBe("1.0.2");
    expect(packs.versionOf("lin/steady", second.hash)?.version).toBe("1.0.1");
    expect(packs.versionOf("lin/steady", first.hash)?.version).toBe("1.0.0");
    packs.install(version("1.0.3", "Four."), { kind: "file", name: "a" });
    // Two versions before the last are kept: the first is gone, and the conversation goes on with
    // the version installed, which the chat says.
    expect(packs.versionOf("lin/steady", first.hash)).toBeUndefined();
    const kept = JSON.parse(settings.saved.get("ai.packs") as string) as {
      packs: { previous?: { previous?: unknown }[]; toolset?: string; defaults?: object }[];
    };
    expect(kept.packs[0]?.previous).toHaveLength(2);
    expect(kept.packs[0]?.previous?.every((each) => each.previous === undefined)).toBe(true);
    expect(kept.packs[0]?.toolset).toMatch(/^\d{4}\.\d+$/);
    expect(Object.keys(kept.packs[0]?.defaults ?? {})).toEqual(["system.extra"]);
  });
});
