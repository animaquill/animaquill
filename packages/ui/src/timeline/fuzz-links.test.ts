import { clipOffset, clipStart, type ClipState } from "@animaquill/core";
import { compare, subtract, type Rational } from "@animaquill/schema";
import type { SettingsStore } from "@animaquill/host";
import { describe, expect, it, vi } from "vitest";
import { MemoryLibrary, memoryAddress, memoryWindow } from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { RULER_HEIGHT, TimelineEditor } from "./editor.ts";
import type { Pointer } from "./gestures.ts";

/**
 * Linked clips taken apart and put together at random, as people do in the editor: Alt drags of
 * one clip, deleting a group, Ctrl+L on what is selected, moving back into step, locking the sound,
 * undo and redo. After each step:
 * 1. a group deleted together is gone together, and an undo brings all of it back as it was;
 * 2. a clip moved back into step has the clock of the one it was measured against, 0 frames apart;
 * 3. linking and unlinking leave no group of one behind, and what is linked is in one group;
 * 4. a group whose clips of one file all line up says nothing, one where some do not says so.
 */

function randomFrom(seed: number) {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    int: (limit: number) => Math.floor(next() * limit),
    pick: <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)],
    chance: (probability: number) => next() < probability,
  };
}

const clockOf = (clip: ClipState): Rational => subtract(clipStart(clip), clipOffset(clip));
const fileOf = (clip: ClipState) =>
  JSON.stringify((clip.source as { readonly media?: unknown }).media);

async function run(seed: number): Promise<void> {
  const random = randomFrom(seed);
  const session = new ProjectSession(new MemoryLibrary(), memoryAddress(), {
    createFailed: vi.fn(),
    notFound: vi.fn(),
    openFailed: vi.fn(),
    tooNew: vi.fn(),
    damaged: vi.fn(),
    saveFailed: vi.fn(),
    saveRecovered: vi.fn(),
  });
  await session.create("联动");
  const store = session.store;
  if (!store) throw new Error("no project");
  const settings: SettingsStore = {
    load: async () => undefined,
    save: async () => {},
    listen: () => () => {},
  };
  const editor = new TimelineEditor(session, memoryWindow(), settings, {
    commandFailed: () => {},
    joinsRemoved: () => {},
  });
  await editor.load();
  editor.setViewport(2000, 400);
  const tracks = Object.values(store.getState().timelines["main"]?.tracks ?? {});
  const video = tracks.find(({ kind }) => kind === "video")?.id as string;
  const audio = tracks.find(({ kind }) => kind === "audio")?.id as string;

  // Pairs of the picture and the sound of a file, some trimmed at the start, some files twice.
  const batch = Array.from({ length: 6 }, (_, index) => {
    const media = { asset: `file${random.int(4)}` };
    const start = String(index * 6);
    const offset = random.chance(0.5) ? { offset: String(random.int(3)) } : {};
    const link = { link: `pair${index}` };
    const clip = (id: string, track: string, kind: string) => ({
      type: "clip.add",
      params: {
        timeline: "main",
        track,
        id,
        start,
        duration: "4",
        source: { kind, media },
        ...offset,
        ...link,
      },
    });
    return [clip(`v${index}`, video, "video"), clip(`s${index}`, audio, "audio")];
  }).flat();
  expect(store.executeBatch(batch).ok).toBe(true);
  editor.zoomToFit();

  const clips = () => store.getState().timelines["main"]?.clips ?? {};
  const groups = () => {
    const byLink = new Map<string, string[]>();
    for (const clip of Object.values(clips())) {
      if (clip.link !== undefined)
        byLink.set(clip.link, [...(byLink.get(clip.link) ?? []), clip.id]);
    }
    return byLink;
  };
  const pointerAt = (id: string, alt: boolean): Pointer | undefined => {
    const box = editor.model?.boxes.get(id);
    const row = editor.model?.rowOfClip.get(id);
    if (!box || !row) return undefined;
    const y = RULER_HEIGHT - editor.scrollY + row.top + row.height / 2;
    return { x: editor.xAt((box.start + box.end) / 2), y, shift: false, alt, mod: false };
  };

  for (let step = 0; step < 40; step++) {
    const ids = Object.keys(clips());
    const id = random.pick(ids);
    const what = random.int(7);
    if (what === 0 && id) {
      // One clip of its group dragged alone, with Alt.
      const from = pointerAt(id, true);
      if (from) {
        const to = { ...from, x: from.x + (random.int(61) - 30) * 3 };
        editor.press(from);
        editor.drag({ ...from, x: (from.x + to.x) / 2 });
        editor.drag(to);
        editor.release(to);
      }
    } else if (what === 1 && id) {
      // A group deleted as one, then maybe brought back.
      editor.selectOnly(id);
      const group = [...editor.getSnapshot().selection];
      const locked = group.filter((each) => editor.model?.rowOfClip.get(each)?.track.locked);
      const before = Object.fromEntries(group.map((each) => [each, clips()[each]]));
      editor.deleteSelection();
      for (const each of group) {
        expect(clips()[each] === undefined, `${each} of ${group} (seed ${seed})`).toBe(
          !locked.includes(each),
        );
      }
      // Nothing went where all of it is locked, and an undo would take back an earlier step.
      if (locked.length < group.length && random.chance(0.6)) {
        store.undo();
        for (const each of group) expect(clips()[each]).toEqual(before[each]);
      }
    } else if (what === 2 && id) {
      // Ctrl+L on a group, a clip alone, or some of them.
      const press = pointerAt(id, random.chance(0.5));
      if (press) {
        editor.press(press);
        editor.release(press);
      }
      const other = random.pick(ids);
      if (other && random.chance(0.5)) editor.addToSelection(other);
      const linkedBefore = new Map(groups());
      const unlinking = editor.canUnlink;
      const linking = editor.canLink;
      const chosen = [...editor.getSnapshot().selection].filter(
        (each) => editor.model?.rowOfClip.get(each)?.track.locked !== true,
      );
      // A link that no other clip has links nothing: it stays, as nothing shows it.
      const grouped = chosen.filter((each) => {
        const link = clips()[each]?.link;
        return link !== undefined && (linkedBefore.get(link)?.length ?? 0) > 1;
      });
      editor.toggleLink();
      const after = groups();
      for (const [link, members] of after) {
        expect(members.length === 1 && (linkedBefore.get(link)?.length ?? 0) > 1).toBe(false);
      }
      if (unlinking) {
        for (const each of grouped) expect(clips()[each]?.link).toBeUndefined();
      } else if (linking) {
        const links = new Set(chosen.map((each) => clips()[each]?.link));
        expect(links.size).toBe(1);
        expect([...links][0]).toBeDefined();
      }
    } else if (what === 3) {
      // Back into step, whichever clip says it is out of it.
      const out = [...(editor.model?.outOfSync.keys() ?? [])];
      const clip = random.pick(out);
      const sync = clip === undefined ? undefined : editor.outOfSync(clip);
      if (clip !== undefined && sync && editor.moveIntoSync(clip)) {
        const moved = clips()[clip] as ClipState;
        const other = clips()[sync.with] as ClipState;
        expect(compare(clockOf(moved), clockOf(other)), `seed ${seed}`).toBe(0);
        if (editor.outOfSync(clip)) expect(editor.outOfSync(clip)?.with).not.toBe(sync.with);
      }
    } else if (what === 4) {
      editor.updateTrack(audio, {
        locked: !store.getState().timelines["main"]?.tracks[audio]?.locked,
      });
    } else if (what === 5) {
      store.undo();
    } else {
      store.redo();
    }

    // What says it is out of step is so, and what is in step says nothing.
    for (const members of groups().values()) {
      if (members.length < 2) continue;
      const byFile = new Map<string, ClipState[]>();
      for (const each of members) {
        const clip = clips()[each] as ClipState;
        byFile.set(fileOf(clip), [...(byFile.get(fileOf(clip)) ?? []), clip]);
      }
      for (const same of byFile.values()) {
        if (same.length < 2) continue;
        const apart = same.some(
          (clip) => compare(clockOf(clip), clockOf(same[0] as ClipState)) !== 0,
        );
        const says = same.filter((clip) => editor.outOfSync(clip.id) !== undefined);
        expect(says.length > 0, `seed ${seed} step ${step}`).toBe(apart);
        for (const clip of says) {
          const sync = editor.outOfSync(clip.id);
          expect(sync?.frames).not.toBe(0);
          const other = clips()[sync?.with ?? ""] as ClipState;
          expect(compare(subtract(clockOf(clip), clockOf(other)), sync?.by as Rational)).toBe(0);
        }
      }
    }
  }
}

describe("linked clips taken apart and together at random", () => {
  // `FUZZ_SEEDS=200` for many more, as on the test machine.
  const count = Number(process.env["FUZZ_SEEDS"] ?? 12);
  for (let seed = 1; seed <= count; seed++) {
    it(`keeps groups whole, and in step where it says so (seed ${seed})`, async () => {
      await run(seed);
    });
  }
});
