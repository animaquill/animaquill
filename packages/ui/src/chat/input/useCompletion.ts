import {
  AudioLines,
  Boxes,
  Camera,
  Clock,
  Film,
  Flag,
  Image as ImageIcon,
  ListChecks,
  MessagesSquare,
  type LucideIcon,
  Minimize2,
  PencilLine,
  Shapes,
  SquarePen,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { formatAddress } from "@animaquill/tools";
import { useProject, useSession, useWorkbench } from "../../app/context.ts";
import type { BoxTrigger, ChatInputHandle } from "../ChatInput.tsx";
import type { FoundGroup, FoundKind, FoundPlace } from "../find.ts";
import type { ChatRef } from "../refs.ts";
import { optionId, type CompletionGroup, type CompletionOption } from "./Completion.tsx";
import { commandsFor, type SlashId } from "./slash.ts";

/** What the commands of `/` do in the box, and why one cannot be used now. */
export interface SlashCommands {
  readonly planFirst: boolean;
  /** Why a command cannot be used now, which the menu says at it; undefined where it can. */
  readonly whyNot: (which: SlashId) => string | undefined;
  /** Does it, with what is left in the box after it. */
  readonly run: (which: SlashId, rest: string) => void;
  /** What is in the box now. */
  readonly text: () => string;
}

/** The menu of `/` and `@` as the box shows it, see `Completion`. */
export interface CompletionView {
  readonly id: string;
  readonly kind: BoxTrigger["kind"];
  readonly query: string;
  readonly groups: readonly CompletionGroup[];
  readonly active: number;
  readonly at: DOMRect;
  readonly onActive: (index: number) => void;
  readonly onPick: (index: number) => void;
}

export interface Completing {
  /** For the box: the caret went into or out of what `/` or `@` started. */
  readonly onTrigger: (trigger: BoxTrigger | undefined) => void;
  /** Keys of the box while the menu is open; true where the menu took the key. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean;
  /** For the box: its menu and the option chosen in it, for those who listen. */
  readonly completes: { readonly list: string; readonly active: string } | undefined;
  /** The menu to show, where there is one. */
  readonly view: CompletionView | undefined;
}

/** How long typing after `@` settles before the project is looked through. */
const FIND_WAIT_MS = 50;
/** So many of each kind show, and so many after "还有 N 个". */
const FIND_SHOWN = 5;
const FIND_MOST = 50;

const NO_KINDS: ReadonlySet<FoundKind> = new Set();

const SLASH_ICONS: Record<SlashId, LucideIcon> = {
  plan: ListChecks,
  new: SquarePen,
  compact: Minimize2,
  frame: Camera,
  rename: PencilLine,
};

const FOUND_ICONS: Record<FoundKind, LucideIcon> = {
  clip: Film,
  asset: ImageIcon,
  scene: Shapes,
  sound: AudioLines,
  marker: Flag,
};

/** Where one of several of the same name is: on another timeline, else when. */
const placeText = (place: FoundPlace | undefined): string | undefined =>
  place?.timeline ?? place?.time;

/**
 * `/` and `@` in the input box (docs/design/chat-panel.md of AnimaQuill Cloud, 3.3): what the menu
 * has where the caret is, and the keys it takes while it is open. ↑ ↓ go through it, Tab picks,
 * Enter picks once something was typed or chosen (a `/` alone is not a command yet), Esc closes it
 * for what that `/` or `@` started; keys while an input method composes are the input method's.
 */
export function useCompletion(
  box: RefObject<ChatInputHandle | null>,
  commands: SlashCommands,
): Completing {
  const workbench = useWorkbench();
  const { pointing } = workbench;
  const { t } = useTranslation();
  const pointed = useSyncExternalStore(pointing.subscribe, pointing.getSnapshot);
  const timeline = useSyncExternalStore(
    workbench.timeline.subscribe,
    workbench.timeline.getSnapshot,
  );
  const [trigger, setTrigger] = useState<BoxTrigger>();
  const triggerKey = trigger && `${trigger.kind}/${trigger.start}`;
  // Closed with Esc: it stays closed for what that `/` or `@` started.
  const [dismissed, setDismissed] = useState<string>();
  // Which option is chosen: by its key, so that it stays chosen as what was found changes.
  const [active, setActiveState] = useState<{
    readonly index: number;
    readonly key?: string | undefined;
  }>({
    index: 0,
  });
  // Chosen with ↑ ↓: Enter picks it, also where nothing was typed yet.
  const [moved, setMoved] = useState(false);
  // The kinds of the project shown in full, after "还有 N 个".
  const [more, setMore] = useState<ReadonlySet<FoundKind>>(NO_KINDS);
  const onTrigger = (next: BoxTrigger | undefined) => {
    const key = next && `${next.kind}/${next.start}`;
    if (key !== triggerKey) {
      setMore(NO_KINDS);
      if (next === undefined) setDismissed(undefined);
    }
    if (key !== triggerKey) {
      setActiveState({ index: 0 });
      setMoved(false);
    } else if (next?.query !== trigger?.query) {
      // More typed: the first of what it finds, unless the one chosen with ↑ ↓ is still there.
      setActiveState((was) => ({ index: 0, key: was.key }));
    }
    setTrigger(next);
  };
  const query = trigger?.kind === "at" ? trigger.query : undefined;
  // Each key does not look through the project again: what was typed settles first.
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), FIND_WAIT_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const looking = query === "" ? "" : settled;
  const open = trigger !== undefined && triggerKey !== dismissed;
  // The project, while the menu is open: its blocks follow a name changed, a clip deleted.
  const { store } = useSession();
  const state = useProject(open ? store : undefined);
  const found = useMemo<readonly FoundGroup[]>(
    () => (open && looking !== undefined ? pointing.find(looking, FIND_MOST, state) : []),
    [open, looking, pointing, state],
  );
  const listId = useId();

  /** The menu for what was found in the project, and what picking each of its options does. */
  const build = (groupsFound: readonly FoundGroup[]) => {
    const groups: CompletionGroup[] = [];
    const picks: (() => void)[] = [];
    const keys: string[] = [];
    const option = (each: CompletionOption, pick: () => void) => {
      picks.push(each.why === undefined ? pick : () => {});
      // The same option, whatever else was found: by what it is; "还有 N 个" by its place.
      keys.push(each.key === "more" ? `more/${groups.length}` : `${each.kind}/${each.key}`);
      return each;
    };
    const putIn = (refs: readonly ChatRef[]) => () => box.current?.complete(refs);
    if (open && trigger.kind === "slash") {
      const options = commandsFor(trigger.query).map((command) =>
        option(
          {
            key: command.id,
            kind: command.id,
            icon: SLASH_ICONS[command.id],
            label: `/${command.name}`,
            note:
              command.id === "plan"
                ? t(commands.planFirst ? "chat.complete.planOff" : "chat.complete.planOn")
                : t(`chat.complete.${command.id}`),
            why: commands.whyNot(command.id),
          },
          () => {
            box.current?.complete([]);
            commands.run(command.id, commands.text());
          },
        ),
      );
      if (options.length > 0) groups.push({ key: "slash", name: undefined, options });
    } else if (open && trigger.kind === "at") {
      if (trigger.query === "") {
        const present: CompletionOption[] = [];
        const selected = pointed.count > 0 ? pointing.selectedRefs() : [];
        if (selected.length > 0) {
          present.push(
            option(
              {
                key: "selection",
                kind: "selection",
                icon: Boxes,
                label:
                  pointed.from === "timeline"
                    ? t("chat.complete.selectedClips", { count: pointed.count })
                    : pointed.from === "keys"
                      ? t("chat.complete.selectedKeys", { count: pointed.count })
                      : t("chat.complete.selected", {
                          what: selected[0]?.label ?? "",
                          interpolation: { escapeValue: false },
                        }),
              },
              putIn(selected),
            ),
          );
        }
        const time = timeline.model ? pointing.timeRef() : undefined;
        if (time) {
          present.push(
            option(
              {
                key: "time",
                kind: "time",
                icon: Clock,
                label: t("chat.complete.playhead", { time: time.label }),
              },
              putIn([time]),
            ),
          );
        }
        if (present.length > 0) {
          groups.push({ key: "now", name: t("chat.complete.now"), options: present });
        }
      }
      for (const group of groupsFound) {
        const all = more.has(group.kind);
        const refs = group.refs.slice(0, all ? FIND_MOST : FIND_SHOWN);
        // Several of the same name: each says where it is, the others nothing.
        const named = new Map<string, number>();
        for (const ref of refs) named.set(ref.label, (named.get(ref.label) ?? 0) + 1);
        const options = refs.map((ref, at) =>
          option(
            {
              key: ref.href,
              kind: group.kind,
              icon: FOUND_ICONS[group.kind],
              label: ref.label,
              note: (named.get(ref.label) ?? 0) > 1 ? placeText(group.places[at]) : undefined,
            },
            putIn([ref]),
          ),
        );
        const left = group.total - refs.length;
        if (left > 0) {
          options.push(
            option(
              {
                key: "more",
                kind: "more",
                icon: undefined,
                label: t("chat.refs.more", { count: left }),
                note: all ? t("chat.complete.typeMore") : undefined,
              },
              () => {
                if (!all) setMore(new Set([...more, group.kind]));
              },
            ),
          );
        }
        groups.push({ key: group.kind, name: t(`chat.complete.${group.kind}`), options });
      }
      // Other conversations of the project, to ask by name (docs/design/ai-teamwork.md of
      // AnimaQuill Cloud, 3): those that run first.
      const chats = conversationsFor(trigger.query);
      if (chats.length > 0) {
        groups.push({
          key: "agent",
          name: t("chat.agents.group"),
          options: chats.slice(0, FIND_SHOWN).map(({ id, title, running }) =>
            option(
              {
                key: `aq://agent/${id}`,
                kind: "agent",
                icon: MessagesSquare,
                label: t("chat.complete.conversation", {
                  title,
                  interpolation: { escapeValue: false },
                }),
                note: running ? t("chat.agents.running") : undefined,
              },
              putIn([
                {
                  label: t("chat.complete.conversation", {
                    title,
                    interpolation: { escapeValue: false },
                  }),
                  href: formatAddress({ kind: "agent", id }),
                },
              ]),
            ),
          ),
        });
      }
    }
    return { groups, picks, keys };
  };
  /** The other conversations of the project called something like `typed`, those that run first. */
  function conversationsFor(typed: string) {
    const snapshot = workbench.chat.getSnapshot();
    const running = new Set(
      snapshot.runs.filter((run) => run.state === "running").map((run) => run.id),
    );
    const wanted = typed.trim().toLowerCase();
    return snapshot.saved
      .filter((each) => each.id !== snapshot.id && each.title.toLowerCase().includes(wanted))
      .map((each) => ({ id: each.id, title: each.title, running: running.has(each.id) }))
      .toSorted((a, b) => Number(b.running) - Number(a.running));
  }
  const { groups, picks, keys } = build(found);
  // `/` with nothing it could be is words, not a command: no menu.
  const showing = open && (trigger.kind === "at" || groups.length > 0);
  /** Which of these options is chosen: the one with the key chosen, where it is still there. */
  const chosenIn = (these: readonly string[]) => {
    const at = active.key === undefined ? -1 : these.indexOf(active.key);
    return at >= 0 ? at : Math.min(active.index, these.length - 1);
  };
  const chosen = chosenIn(keys);
  const setActive = (index: number) => setActiveState({ index, key: keys[index] });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    // An input method composes: its keys pick its words, never what the menu has.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (!showing || event.altKey || event.ctrlKey || event.metaKey) return false;
    // Typed faster than the project was looked through: it is looked through now, and the key
    // goes to what it has for what was typed, not to what it had a moment ago.
    const pending = query !== undefined && looking !== query && query !== "";
    const now = pending ? build(pointing.find(query, FIND_MOST, state)) : { picks, keys };
    if (pending) setSettled(query);
    const at = pending ? chosenIn(now.keys) : chosen;
    const count = now.picks.length;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count > 0) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = (at + step + count) % count;
      setActiveState({ index: next, key: now.keys[next] });
      setMoved(true);
      return true;
    }
    if (event.key === "Escape") {
      // Closed, and what was typed stays as it is; the task, if one runs, goes on.
      event.preventDefault();
      event.stopPropagation();
      setDismissed(triggerKey);
      return true;
    }
    if ((event.key !== "Enter" && event.key !== "Tab") || event.shiftKey) return false;
    // A `/` alone is not a command yet: Enter does nothing, not even send it.
    if (event.key === "Enter" && trigger.kind === "slash" && trigger.query === "" && !moved) {
      event.preventDefault();
      return true;
    }
    if (count === 0) return false;
    // One that cannot be used now says why in its line; nothing goes to AI meanwhile.
    event.preventDefault();
    now.picks[at]?.();
    return true;
  };

  return {
    onTrigger,
    onKeyDown,
    completes:
      showing && picks.length > 0 ? { list: listId, active: optionId(listId, chosen) } : undefined,
    view: showing
      ? {
          id: listId,
          kind: trigger.kind,
          query: trigger.query,
          groups,
          active: chosen,
          at: trigger.rect,
          onActive: setActive,
          onPick: (index) => picks[index]?.(),
        }
      : undefined,
  };
}
