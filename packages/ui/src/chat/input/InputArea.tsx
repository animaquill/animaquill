import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { ListChecks, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { formatCombo } from "../../workbench/keys.ts";
import type { AttachRefusal } from "../attachments.ts";
import { Attachments } from "../AttachmentsView.tsx";
import { ChatInput, type ChatInputHandle } from "../ChatInput.tsx";
import { ModelTag, type ModelTagHandle } from "../model/ModelTag.tsx";
import { WITHHELD } from "../session.ts";
import { useShownChat } from "../shown.ts";
import { CarryLine } from "./CarryLine.tsx";
import { HoldStrip } from "./HoldStrip.tsx";
import styles from "./input.module.css";
import { holdsBack, picturesWhy, PicturesWarn } from "./PicturesWarn.tsx";
import { PlusMenu, type PlusItem, type PlusMenuHandle } from "./PlusMenu.tsx";
import { QueueList } from "./QueueList.tsx";
import { SendButton, sendStateOf } from "./SendButton.tsx";

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
export function InputArea(props: {
  /** Something went out: the list follows the newest again. */
  readonly onSent: () => void;
}) {
  const workbench = useWorkbench();
  const { chat, ai, keybindings, pointing } = workbench;
  const { t } = useTranslation();
  const shown = useShownChat();
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
  // "带上" taken off: for the next message of this conversation only.
  const [carry, setCarry] = useState<{ readonly chat: string | undefined; readonly on: boolean }>({
    chat: id,
    on: true,
  });
  const carrying = carry.chat !== id || carry.on;
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
  // The commands of the palette reach the box through the workbench.
  useEffect(() =>
    workbench.composeWith({
      time: insertTime,
      selection: insertSelection,
      picture: choose,
      plus: () => plus.current?.openFromBox(box.current?.element ?? null),
      models: () => tag.current?.open(),
      effort: () => tag.current?.cycleEffort(),
      focus: () => box.current?.focus(),
    }),
  );

  const hasSomething = text.trim() !== "" || ready.length > 0;
  const send = async () => {
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
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
  ];
  const runItem = (which: PlusItem["id"]) => {
    if (which === "time") insertTime();
    else if (which === "selection") insertSelection();
    else if (which === "shoot") shoot();
    else choose();
  };
  const sendKeys = combo(withMod ? "mod+enter" : "enter") ?? "";

  return (
    <div className={styles.area}>
      <HoldStrip hold={shown.hold} nudge={nudge} onModel={() => tag.current?.open()} />
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
      <div className={styles.card} data-testid="chat-compose">
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
            running ? t("chat.compose.placeholderRunning") : t("chat.compose.placeholder")
          }
          gone={(href) => pointing.stateOf(href) === "gone"}
          onPoint={(href) => workbench.pointAt(href)}
          onOpen={(href) => workbench.goToRef(href)}
        />
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
            state={sendStateOf(running, hasSomething)}
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
}

const NONE: readonly never[] = [];
