import { describe, expect, it } from "vitest";
import { loadPinyin, repositoryNameOf } from "./repository-name.ts";
import { nameProblem } from "./repository-text.ts";

const toPinyin = await loadPinyin();
const day = new Date(2026, 10, 11, 15, 0).getTime();

describe("the name of a new repository, from the name of the project", () => {
  it("takes letters and digits as they are", () => {
    expect(repositoryNameOf("Atom", toPinyin, day)).toBe("atom");
    expect(repositoryNameOf("My Film 2", toPinyin, day)).toBe("my-film-2");
  });

  it("says Chinese in pinyin without tones, a dash between the syllables", () => {
    expect(repositoryNameOf("原子是什么", toPinyin, day)).toBe("yuan-zi-shi-shen-me");
    expect(repositoryNameOf("绿色的重庆", toPinyin, day)).toBe("lv-se-de-chong-qing");
    expect(repositoryNameOf("Atom 原子2号", toPinyin, day)).toBe("atom-yuan-zi-2-hao");
  });

  it("puts a dash for anything else, once, and none at the ends", () => {
    expect(repositoryNameOf("「原子」—— 第一集！", toPinyin, day)).toBe("yuan-zi-di-yi-ji");
    expect(repositoryNameOf("a.b_c", toPinyin, day)).toBe("a-b-c");
  });

  it("is animaquill- and the day where nothing is left", () => {
    expect(repositoryNameOf("🎬！？", toPinyin, day)).toBe("animaquill-20261111");
    expect(repositoryNameOf("", toPinyin, day)).toBe("animaquill-20261111");
    // Before the pinyin is there, Chinese is nothing yet.
    expect(repositoryNameOf("原子", undefined, day)).toBe("animaquill-20261111");
  });

  it("is always a name GitHub takes, and no longer than it takes", () => {
    const long = repositoryNameOf("原子".repeat(80), toPinyin, day);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith("-")).toBe(false);
    for (const name of ["原子是什么", "a--b", "x".repeat(150), "Ä Ö 原"]) {
      expect(nameProblem(repositoryNameOf(name, toPinyin, day))).toBeUndefined();
    }
  });
});
