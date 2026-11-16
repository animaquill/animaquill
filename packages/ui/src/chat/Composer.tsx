import {
  Boxes,
  Camera,
  Check,
  Clock,
  CornerUpLeft,
  ListChecks,
  Paperclip,
  Plus,
  SendHorizontal,
  Square,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { Tip } from "../app/Tip.tsx";
import { formatCombo } from "../workbench/keys.ts";
import type { AttachRefusal } from "./attachments.ts";
import { Attachments } from "./AttachmentsView.tsx";
import { ChatInput, type ChatInputHandle } from "./ChatInput.tsx";
import styles from "./ChatPanel.module.css";
import { ModelPicker, ReasoningPicker, type PickerRequest } from "./ModelPicker.tsx";
import { plainOf } from "./refs.ts";

/** Narrower than this, the buttons of the box go into one "+" menu. */
const NARROW = 320;

/** The commands of the buttons of the box, whose keys people can change (`Workbench`). */
const COMMANDS = {
  time: "chat.insertTime",
  selection: "chat.insertSelection",
  shoot: "chat.sendFrame",
} as const;

/**
 * Where people write to AI: a box that grows with what they write (2 to 10 lines), whose draft is
 * kept for each conversation in the memory of the window, with the pictures that go with it; under
 * it the buttons that put the moment of the playhead, the objects selected, a frame or a picture in
 * (`Alt+T`, `Alt+O`, `Alt+S` while the box has the focus; in a "+" menu where the chat is narrow),
 * the model and how hard it reasons, and send, or stop while a task runs. Enter sends (or
 * Ctrl+Enter, as people choose in the settings, where Enter is a new line), Shift+Enter is a new
 * line, nothing goes while an input method composes, ↑ in an empty box brings back what people said
 * before. While a task runs Enter queues the message for after it; queued messages show above the
 * box, to take back.
 */
export function Composer(props: {
  /** Something went out: the list follows the newest again. */
  readonly onSent: () => void;
}) {
  const workbench = useWorkbench();
  const { chat, ai, keybindings, pointing } = workbench;
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  // Enter, or Ctrl+Enter (⌘ Enter) where people chose that in the settings: the other is a new line.
  const withMod = settings.sendWith === "modEnter";
  const pointed = useSyncExternalStore(pointing.subscribe, pointing.getSnapshot);
  // The keys of the buttons, as people set them.
  useSyncExternalStore(keybindings.subscribe, keybindings.getSnapshot);
  // The playhead, for what the button of the time says.
  useSyncExternalStore(workbench.timeline.subscribeView, () => workbench.timeline.frame);
  const conversation = snapshot.conversation;
  const talk = useSyncExternalStore(
    conversation?.subscribe ?? noop,
    conversation?.getSnapshot ?? (() => undefined),
  );
  const running = conversation?.running === true;
  const project = chat.projectKey;
  const id = snapshot.id;
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
  const [picking, setPicking] = useState<PickerRequest | undefined>();

  // Which earlier message ↑ brought back, counted from the newest, in which conversation.
  const history = useRef<{ readonly chat: string | undefined; readonly back: number } | undefined>(
    undefined,
  );

  // The chat narrower than 320 pixels: the buttons go into a menu.
  const composeRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = composeRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setNarrow(element.clientWidth < NARROW));
    observer.observe(element);
    setNarrow(element.clientWidth < NARROW);
    return () => observer.disconnect();
  }, []);

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
  const blocked = ready.length > 0 && sees === false;
  const working = pictures.some((item) => item.state === "working");
  const failed = pictures.some((item) => item.state === "failed");

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
      focus: () => box.current?.focus(),
    }),
  );

  const send = async (withPictures = true) => {
    if (project === undefined || id === undefined) return;
    const images = withPictures ? chat.attachments.ready(project, id) : [];
    if ((!text.trim() && images.length === 0) || working || failed) return;
    if (images.length > 0 && sees === false) return;
    // A picture the browser lost since it was added goes nowhere: it says so, and nothing goes.
    if (images.length > 0 && !(await chat.attachments.verify(project, id))) {
      workbench.notifications.push(t("chat.pictures.lost"));
      return;
    }
    write("");
    chat.attachments.clear(project, id);
    history.current = undefined;
    props.onSent();
    if (running) chat.queue(text, images);
    else void chat.send(text, images);
  };
  const said = (talk?.entries ?? []).flatMap((entry) => (entry.role === "user" ? [entry] : []));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = history.current?.chat === id ? history.current?.back : undefined;
    if (event.key === "ArrowUp" && !event.shiftKey) {
      // What people said before, newest first, while the box has nothing else in it.
      const back = (at ?? -1) + 1;
      const shown = at === undefined ? "" : said[said.length - 1 - at]?.text;
      const entry = said[said.length - 1 - back];
      if (entry && text === (shown ?? "")) {
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

  const combo = (keys: string) => formatCombo(keys, keybindings.platform);
  const model = workbench.timeline.model;
  const timeRef = pointing.timeRef();
  const timelineName =
    model && (workbench.session.store?.getState().timelines[model.id]?.name ?? model.id);
  const tools: readonly ToolItem[] = [
    {
      id: "time",
      icon: Clock,
      name: t("chat.compose.insertTime"),
      usage:
        model && timeRef
          ? t("chat.compose.insertTimeHelp", {
              timeline: timelineName,
              time: timeRef.label,
              frame: workbench.timeline.frame,
              interpolation: { escapeValue: false },
            })
          : t("chat.compose.noTimeline"),
      keys: keybindings.keysFor(COMMANDS.time)[0],
      disabled: !model,
    },
    {
      id: "selection",
      icon: Boxes,
      name: t("chat.compose.insertSelection"),
      usage:
        pointed.count > 0
          ? t("chat.compose.insertSelectionHelp", { count: pointed.count })
          : t("chat.compose.insertSelectionNone"),
      keys: keybindings.keysFor(COMMANDS.selection)[0],
      disabled: pointed.count === 0,
      count: pointed.count,
    },
    {
      id: "shoot",
      icon: Camera,
      name: t("chat.compose.shoot"),
      usage: t("chat.compose.shootHelp"),
      keys: keybindings.keysFor(COMMANDS.shoot)[0],
      disabled: !model,
    },
    {
      id: "picture",
      icon: Paperclip,
      name: t("chat.compose.addPicture"),
      usage: t("chat.compose.addPictureHelp"),
      keys: undefined,
      disabled: false,
    },
  ];
  const runTool = (which: ToolItem["id"]) => {
    if (which === "time") insertTime();
    else if (which === "selection") insertSelection();
    else if (which === "shoot") shoot();
    else choose();
  };

  return (
    <div className={styles.compose} ref={composeRef}>
      {snapshot.queued.length > 0 && (
        <div className={styles.queued} data-testid="chat-queued">
          {snapshot.queued.map((queued, index) => (
            <div key={`${index}/${queued.text}`} className={styles.queuedItem}>
              <span className={styles.queuedText} title={plainOf(queued.text)}>
                {t("chat.compose.queued", { text: plainOf(queued.text) })}
                {queued.images && ` · ${t("chat.pictures.count", { count: queued.images.length })}`}
              </span>
              {!running && index === 0 && (
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => {
                    const next = chat.unqueue(0);
                    if (next !== undefined) {
                      props.onSent();
                      void chat.sendQueued(next);
                    }
                  }}
                >
                  {t("chat.compose.sendNow")}
                </button>
              )}
              <button
                type="button"
                className={styles.icon}
                aria-label={t("chat.compose.edit")}
                title={t("chat.compose.edit")}
                onClick={() => takeBack(index)}
              >
                <CornerUpLeft size={12} aria-hidden />
              </button>
              <button
                type="button"
                className={styles.icon}
                aria-label={t("chat.compose.drop")}
                title={t("chat.compose.drop")}
                onClick={() => chat.unqueue(index)}
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
      {project !== undefined && id !== undefined && pictures.length > 0 && (
        <Attachments
          project={project}
          chat={id}
          items={pictures}
          blind={sees === false ? modelName : undefined}
        />
      )}
      {blocked && (
        <div className={styles.blind} role="alert" data-testid="chat-pictures-blocked">
          <span>{t("chat.pictures.blocked")}</span>{" "}
          <button
            type="button"
            className={styles.link}
            onClick={() => setPicking({ at: Date.now(), pictures: true })}
          >
            {t("chat.pictures.pickVision")}
          </button>
          {" · "}
          <button type="button" className={styles.link} onClick={() => void send(false)}>
            {t("chat.pictures.sendWithout")}
          </button>
        </div>
      )}
      {(working || failed) && (
        <p className={styles.unsure} data-testid="chat-pictures-wait">
          {t(failed ? "chat.pictures.removeFailed" : "chat.pictures.wait")}
        </p>
      )}
      {ready.length > 0 && sees === undefined && (
        <p className={styles.unsure} data-testid="chat-pictures-unsure">
          {t("chat.pictures.unsure")}
        </p>
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
        label={
          withMod ? t("chat.placeholderWith", { send: combo("mod+enter") }) : t("chat.placeholder")
        }
        placeholder={
          withMod
            ? t(running ? "chat.compose.whileRunningWith" : "chat.placeholderWith", {
                send: combo("mod+enter"),
              })
            : running
              ? t("chat.compose.whileRunning")
              : t("chat.placeholder")
        }
        gone={(href) => pointing.stateOf(href) === "gone"}
        onPoint={(href) => workbench.pointAt(href)}
        onOpen={(href) => workbench.goToRef(href)}
      />
      <div className={styles.controls}>
        {narrow ? (
          <PlusMenu
            tools={tools}
            combo={combo}
            onRun={runTool}
            planFirst={snapshot.planFirst}
            onPlanFirst={() => chat.setPlanFirst(!snapshot.planFirst)}
          />
        ) : (
          <div className={styles.composeTools} data-testid="chat-tools">
            {tools.map((tool) => (
              <Tip
                key={tool.id}
                name={tool.name}
                usage={tool.usage}
                {...(tool.keys && { shortcut: combo(tool.keys) })}
              >
                <button
                  type="button"
                  className={styles.icon}
                  aria-label={tool.name}
                  data-testid={`chat-tool-${tool.id}`}
                  aria-disabled={tool.disabled || undefined}
                  // The box keeps its caret: what goes in goes where it is.
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (!tool.disabled) runTool(tool.id);
                  }}
                >
                  <tool.icon size={13} aria-hidden />
                  {tool.count !== undefined && tool.count > 0 && (
                    <span className={styles.toolCount}>{tool.count}</span>
                  )}
                </button>
              </Tip>
            ))}
          </div>
        )}
        {!narrow && (
          <>
            <Tip name={t("chat.compose.planFirst")} usage="">
              <button
                type="button"
                className={`${styles.icon} ${styles.planFirst}`}
                aria-label={t("chat.compose.planFirst")}
                aria-pressed={snapshot.planFirst}
                data-testid="chat-plan-first"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => chat.setPlanFirst(!snapshot.planFirst)}
              >
                <ListChecks size={13} aria-hidden />
                <span className={styles.planFirstName}>{t("chat.plan.short")}</span>
              </button>
            </Tip>
            <span className={styles.toolsSep} aria-hidden />
          </>
        )}
        <ModelPicker request={picking} />
        <ReasoningPicker />
        <span className={styles.grow} />
        {running && (text.trim() !== "" || ready.length > 0) && (
          <button type="button" data-testid="chat-queue" onClick={() => void send()}>
            {t("chat.compose.queue")}
          </button>
        )}
        {running ? (
          <button
            type="button"
            className={styles.stop}
            aria-label={t("chat.stop")}
            onClick={() => chat.stop()}
          >
            <Square size={12} /> <span className={styles.buttonText}>{t("chat.stop")}</span>
          </button>
        ) : (
          <button
            type="button"
            className={styles.send}
            aria-label={t("chat.send")}
            disabled={(!text.trim() && ready.length === 0) || blocked || working || failed}
            onClick={() => void send()}
          >
            <SendHorizontal size={12} className={styles.narrowIcon} />
            <span className={styles.buttonText}>{t("chat.send")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

interface ToolItem {
  readonly id: "time" | "selection" | "shoot" | "picture";
  readonly icon: typeof Clock;
  readonly name: string;
  readonly usage: string;
  readonly keys: string | undefined;
  readonly disabled: boolean;
  readonly count?: number;
}

/**
 * The buttons of the box as one menu, where the chat is narrow, with "先出方案" as an item to tick:
 * a dot on "+" says it is on, without opening the menu.
 */
function PlusMenu(props: {
  readonly tools: readonly ToolItem[];
  readonly combo: (keys: string) => string;
  readonly onRun: (which: ToolItem["id"]) => void;
  readonly planFirst: boolean;
  readonly onPlanFirst: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  /** Opened from the keyboard: the first item that can be chosen gets the focus. */
  const [fromKeys, setFromKeys] = useState(false);
  const items = () =>
    [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"], [role="menuitemcheckbox"]',
      ) ?? []),
    ].filter((item) => !item.disabled);
  useEffect(() => {
    if (!open || !fromKeys) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open, fromKeys]);
  const closeMenu = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  // As the other menus: ↑ and ↓ go through what can be chosen, Home and End to the ends, Enter
  // chooses, Esc closes back to the button.
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (index: number) => list[(index + list.length) % list.length]?.focus();
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(-1);
    else if (event.key === "Escape") closeMenu();
    else if (event.key === "Tab") setOpen(false);
    else return;
    if (event.key !== "Tab") {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className={styles.moreWrap} ref={ref}>
      <button
        type="button"
        className={styles.icon}
        aria-label={
          props.planFirst
            ? `${t("chat.compose.more")} · ${t("chat.compose.planFirst")}`
            : t("chat.compose.more")
        }
        title={t("chat.compose.more")}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="chat-tools-more"
        ref={toggle}
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          // A click of the mouse keeps the caret in the box; Enter or Space goes into the menu.
          setFromKeys(event.detail === 0);
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setFromKeys(true);
            setOpen(true);
          }
        }}
      >
        <Plus size={13} aria-hidden />
        {props.planFirst && <span className={styles.plusDot} data-testid="chat-plan-first-dot" />}
      </button>
      {open && (
        <div
          className={`${styles.menu} ${styles.menuUp}`}
          role="menu"
          aria-label={t("chat.compose.more")}
          onKeyDown={onMenuKeyDown}
        >
          {props.tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              role="menuitem"
              disabled={tool.disabled}
              title={tool.usage}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setOpen(false);
                if (fromKeys) toggle.current?.focus();
                props.onRun(tool.id);
              }}
            >
              <tool.icon size={12} aria-hidden /> {tool.name}
              {tool.count !== undefined && tool.count > 0 && ` (${tool.count})`}
              {tool.keys && <span className={styles.menuKeys}>{props.combo(tool.keys)}</span>}
            </button>
          ))}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={props.planFirst}
            data-testid="chat-plan-first"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              setOpen(false);
              if (fromKeys) toggle.current?.focus();
              props.onPlanFirst();
            }}
          >
            {/* Ticked, the tick takes the place of its icon: the menu can be wider than the chat. */}
            {props.planFirst ? (
              <Check size={12} aria-hidden className={styles.menuCheck} />
            ) : (
              <ListChecks size={12} aria-hidden />
            )}{" "}
            {t("chat.compose.planFirst")}
          </button>
        </div>
      )}
    </div>
  );
}

const noop = () => () => {};
const NONE: readonly never[] = [];
