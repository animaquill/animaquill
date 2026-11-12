/**
 * The second review of model packs (6.5b ⑦): marks for blank in the install dialog, labels, the
 * hidden pack to compare with. What were holes at the second review are fixed, and their cases say
 * how.
 */
import { builtinPacks, checkPack, COMPARISON_PACK_ID, type ModelPack } from "@animaquill/tools";
import type { TFunction } from "i18next";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { visible } from "./PackDialog.tsx";
import { packLabel } from "./packText.ts";

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
  it("[挡住] “第三方 · id”在名字前面，长名字挤不掉；名字里不能有别的空白", () => {
    const made = (name: string) =>
      checkPack(
        new Map([["pack.json", JSON.stringify({ format: 1, id: "m/p", name, version: "1.0.0" })]]),
      );
    expect(made(`Claude 5${"　".repeat(20)}.`).pack).toBeUndefined();
    const pack = made(`Claude 5 ${"x".repeat(40)}`).pack as ModelPack;
    expect(packLabel(t, pack).startsWith("ai.packs.labelThirdParty")).toBe(true);
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
