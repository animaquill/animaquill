import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import {
  AudioLines,
  Boxes,
  Camera,
  Clock,
  Flag,
  Film,
  Image as ImageIcon,
  ImageOff,
  ListChecks,
  type LucideIcon,
  Minimize2,
  PencilLine,
  Shapes,
  SquarePen,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../../app/context.ts";
import { formatCombo } from "../../workbench/keys.ts";
import type { AttachRefusal } from "../attachments.ts";
import { Attachments } from "../AttachmentsView.tsx";
import { ChatInput, type BoxTrigger, type ChatInputHandle } from "../ChatInput.tsx";
import type { FoundKind } from "../find.ts";
import type { ChatRef } from "../refs.ts";
import { useChatUi } from "../ui.ts";
import { ModelTag, type ModelTagHandle } from "../model/ModelTag.tsx";
import { WITHHELD } from "../session.ts";
import { groupsOf } from "../turns.ts";
import { questionOf } from "../wait/question.ts";
import { useShownChat } from "../shown.ts";
import { CarryLine } from "./CarryLine.tsx";
import {
  Completion,
  optionId,
  type CompletionGroup,
  type CompletionOption,
} from "./Completion.tsx";
import { HoldStrip } from "./HoldStrip.tsx";
import styles from "./input.module.css";
import { holdsBack, picturesWhy, PicturesWarn } from "./PicturesWarn.tsx";
import { PlusMenu, type PlusItem, type PlusMenuHandle } from "./PlusMenu.tsx";
import { QueueList } from "./QueueList.tsx";
import { SendButton, sendStateOf } from "./SendButton.tsx";
import { commandOf, commandsFor, type SlashId } from "./slash.ts";

/** The commands of the box, whose keys people can change (`Workbench`). */
const COMMANDS = {
  time: "chat.insertTime",
  selection: "chat.insertSelection",
  shoot: "chat.sendFrame",
  plus: "chat.openPlus",
  models: "chat.openModels",
} as const;

/**
 * Where people write to AI (docs/design/chat-panel.md of AnimaQuill Cloud, 3): one rounded card
 * with the pictures at its top, the words, and a row of "+", the switch "先出方案" where it is on,
 * the model and one round button to send, stop or queue. Over the card what is queued and why a
 * message cannot go; under it what a message keeps of the editor ("带上").
 *
 * The words: a box that grows with them (1 to about 10 lines), whose draft is kept for each
 * conversation in the memory of the window, with its pictures. Enter sends (or Ctrl+Enter, as
 * people choose in the settings, where Enter is a new line), Shift+Enter is a new line, nothing
 * goes while an input method composes, ↑ in an empty box brings back what people said before.
 * While a task runs, Enter queues the message for after it and Esc stops the task.
 */
export interface InputAreaHandle {
  /** Opens the bubble of the model, on the models that see pictures where asked. */
  openModels(pictures?: boolean): void;
  focus(): void;
}

export const InputArea = forwardRef<
  InputAreaHandle,
  {
    /** Something went out: the list follows the newest again. */
    readonly onSent: () => void;
  }
>(function InputArea(props, handle) {
  const workbench = useWorkbench();
  const { chat, ai, keybindings, pointing } = workbench;
  const { t } = useTranslation();
  const shown = useShownChat();
  const ui = useChatUi();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  // Enter, or Ctrl+Enter (⌘ Enter) where people chose that in the settings: the other is a new line.
  const withMod = settings.sendWith === "modEnter";
  const pointed = useSyncExternalStore(pointing.subscribe, pointing.getSnapshot);
  // The keys of the commands, as people set them.
  useSyncExternalStore(keybindings.subscribe, keybindings.getSnapshot);
  // The timeline and the playhead, for what "+" says it puts in.
  const timelineView = useSyncExternalStore(
    workbench.timeline.subscribe,
    workbench.timeline.getSnapshot,
  );
  const { running, id } = shown;
  const project = chat.projectKey;
  const read = useCallback(
    () => (project === undefined || id === undefined ? "" : chat.drafts.read(project, id)),
    [chat, project, id],
  );
  const text = useSyncExternalStore(chat.drafts.subscribe, read);
  const readPictures = useCallback(
    () => (project === undefined || id === undefined ? NONE : chat.attachments.list(project, id)),
    [chat, project, id],
  );
  const pictures = useSyncExternalStore(chat.attachments.subscribe, readPictures);
  const write = (value: string) => {
    if (project !== undefined && id !== undefined) chat.drafts.write(project, id, value);
  };
  const box = useRef<ChatInputHandle>(null);
  const plus = useRef<PlusMenuHandle>(null);
  const tag = useRef<ModelTagHandle>(null);
  const card = useRef<HTMLDivElement>(null);
  // "带上" taken off: for the next message of this conversation only.
  const [carry, setCarry] = useState<{ readonly chat: string | undefined; readonly on: boolean }>({
    chat: id,
    on: true,
  });
  const carrying = carry.chat !== id || carry.on;
  // Pictures that stayed in the card as words went to AI with "not allowed".
  const [kept, setKept] = useState(false);
  // Pressing send while something holds the message back: that thing shakes.
  const [nudge, setNudge] = useState(0);

  // Which earlier message ↑ brought back, counted from the newest, in which conversation.
  const history = useRef<{ readonly chat: string | undefined; readonly back: number } | undefined>(
    undefined,
  );

  // Whether the model takes pictures: what is known of the models comes with their kind.
  const now = chat.modelNow();
  const kind = now?.service?.kind;
  useEffect(() => {
    if (kind !== undefined) void ai.loadKnown(kind);
  }, [ai, kind]);
  const sees = chat.seesPictures();
  const modelName =
    (now && ai.modelOf(now.ref.service, now.ref.model)?.name) ?? now?.ref.model ?? "";
  const ready = pictures.filter((item) => item.state === "ready");
  const why = picturesWhy({
    ready: ready.length,
    working: pictures.some((item) => item.state === "working"),
    failed: pictures.some((item) => item.state === "failed"),
    sees,
  });

  const insertTime = () => {
    const ref = pointing.timeRef();
    if (ref) box.current?.insert([ref]);
  };
  const insertSelection = () => {
    const refs = pointing.selectedRefs();
    if (refs.length > 0) box.current?.insert(refs);
  };
  const say = (refused: AttachRefusal | undefined) => {
    if (refused) workbench.notifications.push(t(`chat.pictures.${refused}`));
  };
  const shoot = () => {
    if (project === undefined || id === undefined) return;
    void chat.attachments.shoot(project, id, t("chat.pictures.frame")).then(say);
  };
  const addFiles = (files: readonly File[]) => {
    if (project === undefined || id === undefined || files.length === 0) return;
    void chat.attachments.add(project, id, files).then(say);
  };
  const choose = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.addEventListener("change", () => addFiles([...(input.files ?? [])]));
    input.click();
  };
  // The commands of the palette reach the box through the workbench, as it is at the moment.
  const commands = useRef({ insertTime, insertSelection, choose });
  commands.current = { insertTime, insertSelection, choose };
  const compose = useMemo(
    () => ({
      time: () => commands.current.insertTime(),
      selection: () => commands.current.insertSelection(),
      picture: () => commands.current.choose(),
      plus: () => plus.current?.openFromBox(box.current?.element ?? null),
      models: () => tag.current?.toggle(),
      effort: () => tag.current?.cycleEffort(),
      focus: () => box.current?.focus(),
    }),
    [],
  );
  useEffect(() => workbench.composeWith(compose), [workbench, compose]);
  useImperativeHandle(
    handle,
    () => ({
      openModels: (vision) => tag.current?.open(vision),
      focus: () => box.current?.focus(),
    }),
    [],
  );

  const hasSomething = text.trim() !== "" || ready.length > 0;
  // A change waits for people: what they write does not allow it and goes to AI with it. Only
  // words go; pictures stay in the card for later.
  const { approvals, saved } = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const declining = approvals.length > 0;
  const send = async () => {
    // A command written out in full ("/新对话 做个片头") does what it says; it does not go to AI.
    const typed = commandOf(text);
    if (typed) {
      const refused = cannot(typed.command.id) ?? hidden(typed.command.id);
      if (refused !== undefined) {
        workbench.notifications.push(refused);
        return;
      }
      history.current = undefined;
      if (typed.command.id !== "new") write(typed.rest);
      run(typed.command.id, typed.rest);
      return;
    }
    if (declining) {
      if (text.trim() === "" || !chat.declineWith(text)) return;
      write("");
      history.current = undefined;
      // Only words go with "not allowed": pictures stay, and the box says so.
      setKept(pictures.length > 0);
      props.onSent();
      return;
    }
    setKept(false);
    if (project === undefined || id === undefined || !hasSomething) return;
    if (holdsBack(why)) {
      setNudge((count) => count + 1);
      return;
    }
    if (shown.hold) setNudge((count) => count + 1);
    const images = chat.attachments.ready(project, id);
    // A picture the browser lost since it was added goes nowhere: it says so, and nothing goes.
    if (images.length > 0 && !(await chat.attachments.verify(project, id))) {
      workbench.notifications.push(t("chat.pictures.lost"));
      return;
    }
    const selection = carrying ? undefined : WITHHELD;
    write("");
    chat.attachments.clear(project, id);
    history.current = undefined;
    setCarry({ chat: id, on: true });
    props.onSent();
    if (running) chat.queue(text, images, selection);
    else void chat.send(text, images, selection);
  };
  const said = shown.talk.entries.flatMap((entry) => (entry.role === "user" ? [entry] : []));
  // AI asked something at the end of the last turn: the box is where people can answer too.
  const asked =
    !running && questionOf(groupsOf(shown.talk.entries).at(-1)?.entries ?? []) !== undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (completing && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const count = picks.length;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count > 0) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((active + step + count) % count);
        return;
      }
      const picking = (event.key === "Enter" || event.key === "Tab") && !event.shiftKey;
      // Typed faster than the project was looked through: the first of what it has for that now.
      if (picking && query !== undefined && looking !== query) {
        const first = pointing.find(query, 1).find((group) => group.refs.length > 0)?.refs[0];
        if (first) {
          event.preventDefault();
          box.current?.complete([first]);
          return;
        }
      } else if (picking && count > 0) {
        event.preventDefault();
        pick(active);
        return;
      }
      if (event.key === "Escape") {
        // Closed, and what was typed stays as it is; the task, if one runs, goes on.
        event.preventDefault();
        event.stopPropagation();
        setDismissed(triggerKey);
        return;
      }
    }
    const at = history.current?.chat === id ? history.current?.back : undefined;
    if (event.key === "ArrowUp" && !event.shiftKey) {
      // What people said before, newest first, while the box has nothing else in it.
      const back = (at ?? -1) + 1;
      const was = at === undefined ? "" : said[said.length - 1 - at]?.text;
      const entry = said[said.length - 1 - back];
      if (entry && text === (was ?? "")) {
        event.preventDefault();
        history.current = { chat: id, back };
        write(entry.text);
      }
      return;
    }
    if (event.key === "ArrowDown" && !event.shiftKey && at !== undefined) {
      if (text !== said[said.length - 1 - at]?.text) return;
      const next = at - 1;
      event.preventDefault();
      history.current = next < 0 ? undefined : { chat: id, back: next };
      write(next < 0 ? "" : (said[said.length - 1 - next]?.text ?? ""));
      return;
    }
    if (event.key === "Escape" && running) {
      event.preventDefault();
      chat.stop();
    } else if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      (!withMod || (keybindings.platform === "mac" ? event.metaKey : event.ctrlKey))
    ) {
      event.preventDefault();
      void send();
    } else if (
      event.key === "Enter" &&
      withMod &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      // Enter is a new line where Ctrl+Enter sends.
      event.preventDefault();
      document.execCommand("insertLineBreak");
    }
  };
  const takeBack = (index: number) => {
    const queued = chat.unqueue(index);
    if (queued !== undefined && project !== undefined && id !== undefined) {
      chat.drafts.restore(project, id, queued.text);
      chat.attachments.restore(project, id, queued.images ?? []);
      box.current?.focus();
    }
  };
  const removePictures = () => {
    if (project === undefined || id === undefined) return;
    if (why === "failed") {
      for (const item of pictures)
        if (item.state === "failed") chat.attachments.remove(project, id, item.id);
    } else {
      chat.attachments.clear(project, id);
    }
    box.current?.focus();
  };

  const combo = (keys: string | undefined) =>
    keys === undefined ? undefined : formatCombo(keys, keybindings.platform);
  const keysOf = (command: string) => combo(keybindings.keysFor(command)[0]);
  const timeRef = timelineView.model ? pointing.timeRef() : undefined;
  const noTimeline = t("chat.compose.noTimeline");
  const items: readonly PlusItem[] = [
    {
      id: "shoot",
      name: t("chat.compose.shoot"),
      why: timelineView.model ? undefined : noTimeline,
      keys: keysOf(COMMANDS.shoot),
    },
    { id: "picture", name: t("chat.compose.addPicture"), why: undefined, keys: undefined },
    {
      id: "time",
      name: timeRef
        ? t("chat.compose.insertTimeAt", { time: timeRef.label })
        : t("chat.compose.insertTime"),
      why: timeRef ? undefined : noTimeline,
      keys: keysOf(COMMANDS.time),
    },
    {
      id: "selection",
      name:
        pointed.count > 0
          ? t("chat.compose.insertSelectionCount", { count: pointed.count })
          : t("chat.compose.insertSelection"),
      why: pointed.count > 0 ? undefined : t("chat.compose.insertSelectionNone"),
      keys: keysOf(COMMANDS.selection),
    },
    { id: "mention", name: t("chat.compose.mention"), why: undefined, keys: "@" },
  ];
  const runItem = (which: PlusItem["id"]) => {
    if (which === "time") insertTime();
    else if (which === "selection") insertSelection();
    else if (which === "shoot") shoot();
    else if (which === "mention") box.current?.type("@");
    else choose();
  };
  const sendKeys = combo(withMod ? "mod+enter" : "enter") ?? "";

  // `/` and `@` (docs/design/chat-panel.md of AnimaQuill Cloud, 3.3): a menu where the caret is.
  const [trigger, setTrigger] = useState<BoxTrigger>();
  const triggerKey = trigger && `${trigger.kind}/${trigger.start}`;
  // Closed with Esc: it stays closed for what that `/` or `@` started.
  const [dismissed, setDismissed] = useState<string>();
  const [active, setActive] = useState(0);
  // The kinds of the project shown in full, after "还有 N 个".
  const [more, setMore] = useState<ReadonlySet<FoundKind>>(NO_KINDS);
  const onTrigger = (next: BoxTrigger | undefined) => {
    const key = next && `${next.kind}/${next.start}`;
    if (key !== triggerKey) {
      setMore(NO_KINDS);
      if (next === undefined) setDismissed(undefined);
    }
    if (next?.query !== trigger?.query || key !== triggerKey) setActive(0);
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
  const shownOpen = trigger !== undefined && triggerKey !== dismissed;
  // The project, while the menu is open: its blocks follow a name changed, a clip deleted.
  const { store } = useSession();
  const projectState = useProject(shownOpen ? store : undefined);
  const found = useMemo(
    () =>
      shownOpen && looking !== undefined ? pointing.find(looking, FIND_MOST, projectState) : [],
    // What the project has changes the blocks: a name changed, something deleted.
    [shownOpen, looking, pointing, projectState],
  );
  const savedHere = saved.some((each) => each.id === id);
  const compactable = shown.conversation?.compactable === true;
  /** Why a command cannot be used now, which the menu says at it. */
  function cannot(which: SlashId): string | undefined {
    if (which === "frame" && !timelineView.model) return noTimeline;
    if (which === "new" && running) return t("chat.switcher.newWhenDone");
    return undefined;
  }
  /** Why a command is not in the menu now: nothing to do it to. */
  function hidden(which: SlashId): string | undefined {
    if (which === "compact" && !compactable) return t("chat.complete.cannotCompact");
    if (which === "rename" && !savedHere) return t("chat.complete.cannotRename");
    return undefined;
  }
  /** What a command does, from the box. */
  function run(which: SlashId, rest: string) {
    if (which === "plan") chat.setPlanFirst(!shown.planFirst);
    else if (which === "compact") void chat.compact();
    else if (which === "frame") shoot();
    else if (which === "rename") ui.rename();
    else if (which === "new") {
      // What comes after the command goes into the new conversation, to go on writing there.
      write("");
      chat.newConversation();
      const next = chat.getSnapshot().id;
      if (project !== undefined && next !== undefined && next !== id && rest.trim() !== "") {
        chat.drafts.write(project, next, rest.trimStart());
      }
      box.current?.focus();
    }
  }
  const groups: CompletionGroup[] = [];
  const picks: (() => void)[] = [];
  const option = (each: CompletionOption, pick: () => void) => {
    picks.push(pick);
    return each;
  };
  const putIn = (refs: readonly ChatRef[]) => () => box.current?.complete(refs);
  if (shownOpen && trigger.kind === "slash") {
    const options = commandsFor(trigger.query)
      .filter((command) => hidden(command.id) === undefined)
      .map((command) => {
        const notNow = cannot(command.id);
        return option(
          {
            key: command.id,
            kind: command.id,
            icon: SLASH_ICONS[command.id],
            label: `/${command.name}`,
            note:
              command.id === "plan"
                ? t(shown.planFirst ? "chat.complete.planOff" : "chat.complete.planOn")
                : t(`chat.complete.${command.id}`),
            why: notNow,
          },
          () => {
            if (notNow !== undefined) return;
            box.current?.complete([]);
            const rest =
              project === undefined || id === undefined ? "" : chat.drafts.read(project, id);
            run(command.id, rest);
          },
        );
      });
    if (options.length > 0) groups.push({ key: "slash", name: undefined, options });
  } else if (shownOpen && trigger.kind === "at") {
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
      if (timeRef) {
        present.push(
          option(
            {
              key: "time",
              kind: "time",
              icon: Clock,
              label: t("chat.complete.playhead", { time: timeRef.label }),
            },
            putIn([timeRef]),
          ),
        );
      }
      if (present.length > 0) {
        groups.push({ key: "now", name: t("chat.complete.now"), options: present });
      }
    }
    for (const group of found) {
      const all = more.has(group.kind);
      const refs = group.refs.slice(0, all ? FIND_MOST : FIND_SHOWN);
      const options = refs.map((ref) =>
        option(
          { key: ref.href, kind: group.kind, icon: FOUND_ICONS[group.kind], label: ref.label },
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
              if (all) return;
              setMore(new Set([...more, group.kind]));
            },
          ),
        );
      }
      groups.push({ key: group.kind, name: t(`chat.complete.${group.kind}`), options });
    }
  }
  // `/` with nothing it could be is words, not a command: no menu.
  const completing = shownOpen && (trigger.kind === "at" || groups.length > 0);
  const pick = (index: number) => picks[index]?.();
  const listId = useId();

  return (
    <div className={styles.area}>
      <HoldStrip hold={shown.hold} nudge={nudge} onModel={() => tag.current?.open()} />
      {kept && pictures.length > 0 && (
        <p className={styles.strip} role="status" data-testid="chat-pictures-kept">
          <ImageOff size={12} aria-hidden className={styles.stripIcon} />
          <span className={styles.stripText}>{t("chat.compose.picturesKept")}</span>
        </p>
      )}
      <QueueList
        queued={shown.queued}
        running={running}
        onSendNow={() => {
          const next = chat.unqueue(0);
          if (next !== undefined) {
            props.onSent();
            void chat.sendQueued(next);
          }
        }}
        onEdit={takeBack}
        onDrop={(index) => chat.unqueue(index)}
      />
      <div className={styles.card} data-testid="chat-compose" ref={card}>
        {project !== undefined && id !== undefined && pictures.length > 0 && (
          <Attachments
            project={project}
            chat={id}
            items={pictures}
            blind={sees === false ? modelName : undefined}
            end={
              why && (
                <PicturesWarn
                  why={why}
                  model={modelName}
                  nudge={nudge}
                  onPickVision={() => tag.current?.open(true)}
                  onRemoveAll={removePictures}
                />
              )
            }
          />
        )}
        <ChatInput
          ref={box}
          value={text}
          onChange={(value) => {
            history.current = undefined;
            write(value);
          }}
          onKeyDown={onKeyDown}
          onFiles={addFiles}
          // Those who listen hear how it sends; those who see have it on the button.
          label={
            withMod
              ? t("chat.placeholderWith", { send: combo("mod+enter") })
              : t("chat.placeholder")
          }
          placeholder={
            declining
              ? t("chat.compose.placeholderDecline")
              : running
                ? t("chat.compose.placeholderRunning")
                : asked
                  ? t("chat.compose.placeholderAnswer")
                  : t("chat.compose.placeholder")
          }
          gone={(href) => pointing.stateOf(href) === "gone"}
          onPoint={(href) => workbench.pointAt(href)}
          onOpen={(href) => workbench.goToRef(href)}
          // Back in this box, the commands come here again, not to where a message was edited.
          onFocus={() => workbench.composeWith(compose)}
          onTrigger={onTrigger}
          completes={
            completing && picks.length > 0
              ? { list: listId, active: optionId(listId, Math.min(active, picks.length - 1)) }
              : undefined
          }
        />
        {completing && (
          <Completion
            id={listId}
            label={t(trigger.kind === "slash" ? "chat.complete.commands" : "chat.complete.refs")}
            groups={groups}
            empty={
              trigger.query === ""
                ? t("chat.complete.nothing")
                : t("chat.complete.none", { query: trigger.query })
            }
            active={Math.min(active, picks.length - 1)}
            at={trigger.rect}
            within={card.current}
            onActive={setActive}
            onPick={pick}
          />
        )}
        <div className={styles.row}>
          <PlusMenu
            ref={plus}
            items={items}
            planFirst={shown.planFirst}
            onRun={runItem}
            onPlanFirst={() => chat.setPlanFirst(!shown.planFirst)}
            shortcut={keysOf(COMMANDS.plus)}
          />
          {shown.planFirst && (
            <span
              className={styles.mode}
              data-testid="chat-mode-plan"
              title={t("chat.compose.planFirst")}
            >
              <ListChecks size={12} aria-hidden />
              <span className={styles.modeName}>{t("chat.compose.planFirst")}</span>
              <button
                type="button"
                className={styles.modeOff}
                aria-label={t("chat.compose.planFirstOff")}
                title={t("chat.compose.planFirstOff")}
                data-testid="chat-mode-plan-off"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => chat.setPlanFirst(false)}
              >
                <X size={11} aria-hidden />
              </button>
            </span>
          )}
          <span className={styles.grow} />
          <ModelTag
            ref={tag}
            shortcut={keysOf(COMMANDS.models)}
            onDone={() => box.current?.focus()}
          />
          <SendButton
            state={sendStateOf(running, declining ? text.trim() !== "" : hasSomething, declining)}
            keys={sendKeys}
            onSend={() => void send()}
            onStop={() => chat.stop()}
            onEmpty={() => box.current?.focus()}
          />
        </div>
      </div>
      {project !== undefined && (
        <CarryLine on={carrying} onToggle={() => setCarry({ chat: id, on: !carrying })} />
      )}
    </div>
  );
});

const NONE: readonly never[] = [];
const NO_KINDS: ReadonlySet<FoundKind> = new Set();

/** How long typing after `@` settles before the project is looked through. */
const FIND_WAIT_MS = 50;
/** So many of each kind show, and so many after "还有 N 个". */
const FIND_SHOWN = 5;
const FIND_MOST = 50;

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
