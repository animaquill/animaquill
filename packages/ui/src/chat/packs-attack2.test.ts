/**
 * The second review of model packs (6.5b ⑦): marks for blank in the install dialog, labels (since
 * 2026-11-15 "名字(来源)"), the hidden pack to compare with. What were holes at the second review are fixed, and their cases say
 * how.
 */
import { builtinPacks, checkPack, COMPARISON_PACK_ID, type ModelPack } from "@animaquill/tools";
import type { TFunction } from "i18next";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { visible } from "./PackDialog.tsx";
import { labelParts } from "./packText.ts";

const t = ((key: string, values?: Record<string, unknown>) =>
  `${key}${values ? JSON.stringify(values) : ""}`) as unknown as TFunction;
const marks = (text: string) =>
  visible(t, text)
    .filter((node): node is ReactElement<{ children: string }> => isValidElement(node))
    .map((node) => node.props.children);

describe("对话框的空白标记", () => {
  it("[挡住] ASCII 空格、制表符、空行的长串都标出来", () => {
    expect(marks(`a${" ".repeat(20)}b`)).toEqual(['ai.packs.dialog.spaces{"count":20}']);
    expect(marks("a\n\n\nb")).toEqual(['ai.packs.dialog.emptyLines{"count":2}']);
  });

  it("[挡住] 全角空格、不换行空格，再短也标；单独的组合符号标出来，字上的不标", () => {
    expect(marks(`a${"　".repeat(2)}b`)).toEqual(['ai.packs.dialog.otherSpaces{"count":2}']);
    expect(marks("a b")).toEqual(['ai.packs.dialog.otherSpaces{"count":1}']);
    expect(marks(`a${`${"　".repeat(20)}́`.repeat(3)}b`)).toHaveLength(6);
    expect(marks("é")).toEqual([]);
    expect(marks("a\ń\ń\nb")).toEqual(['ai.packs.dialog.emptyLines{"count":2}']);
  });
});

describe("标签", () => {
  it("[挡住] 来源是单独的一段，和名字多长无关；名字超过 40 个字、两头有空白、有别的空白都装不上", () => {
    const made = (name: string) =>
      checkPack(
        new Map([["pack.json", JSON.stringify({ format: 1, id: "m/p", name, version: "1.0.0" })]]),
      );
    expect(made(`Claude 5${"　".repeat(20)}.`).pack).toBeUndefined();
    expect(made("x".repeat(41)).problems.map(({ code }) => code)).toEqual(["name-long"]);
    expect(made(" Steady").problems.map(({ code }) => code)).toEqual(["name-edge"]);
    const pack = made("x".repeat(40)).pack as ModelPack;
    const parts = labelParts(t, pack, { kind: "github", owner: "pipi", repo: "aq" });
    expect(parts.origin).toBe("pipi");
    expect(parts.name).toBe("x".repeat(40));
  });

  it("[说明] 名字长度、空白这些新规则只管新装的：以前装的照常读出", () => {
    const files = new Map([
      [
        "pack.json",
        JSON.stringify({ format: 1, id: "m/p", name: `${"x".repeat(50)}(内)`, version: "1.0.0" }),
      ],
    ]);
    expect(checkPack(files).pack).toBeUndefined();
    expect(checkPack(files, { mode: "load" }).pack?.name).toBe(`${"x".repeat(50)}(内)`);
  });
});

describe("隐藏的对照包", () => {
  it("[挡住] 只有代码里的那一个，checkPack 装不进同 id 的包", () => {
    const hidden = builtinPacks().filter((pack) => pack.hidden);
    expect(hidden.map(({ id }) => id)).toEqual([COMPARISON_PACK_ID]);
    const { pack, problems } = checkPack(
      new Map([
        [
          "pack.json",
          JSON.stringify({
            format: 1,
            id: COMPARISON_PACK_ID,
            name: "x",
            version: "1.0.0",
            hidden: true,
          }),
        ],
      ]),
    );
    expect(pack).toBeUndefined();
    expect(problems.map(({ code }) => code).toSorted()).toEqual(["unknown-field"]);
  });
});
