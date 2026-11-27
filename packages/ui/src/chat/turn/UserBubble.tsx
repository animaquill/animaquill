import type { AttachedImage } from "@animaquill/agent";
import { promptOf } from "@animaquill/agent";
import type { ChatImageHeld } from "@animaquill/host";
import { ChevronDown, Copy, MoreHorizontal, Pencil, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { Tip } from "../../app/Tip.tsx";
import { formatCombo } from "../../workbench/keys.ts";
import { Attachments, LargePicture, usePicture } from "../AttachmentsView.tsx";
import { ChatInput, type ChatInputHandle } from "../ChatInput.tsx";
import { useOpened } from "../expanded.ts";
import { GoBack, type GoingBack } from "../GoBack.tsx";
import { useBoxMenu } from "../input/menu.ts";
import { RefText } from "../RefChip.tsx";
import { plainOf } from "../refs.ts";
import { placesOf, summaryOf } from "../summary.ts";
import type { Turn } from "../turns.ts";
import styles from "./turn.module.css";

/** Copies words for people, and says whether it could. */
export function useCopy(): (text: string) => void {
  const { notifications } = useWorkbench();
  const { t } = useTranslation();
  return (text) =>
    void navigator.clipboard?.writeText(text).then(
      () => notifications.push(t("chat.more.copied")),
      () => notifications.push(t("chat.more.copyFailed")),
    );
}

/** Where the box of an edited message keeps its words and pictures, beside the drafts of the chat. */
const editKey = (chat: string, task: string) => `${chat}#edit:${task}`;

/**
 * What people said (docs/design/chat-panel.md of AnimaQuill Cloud, 5.1): on the right, with its
 * blocks and pictures, and under it, on hovering or with the focus in it, copying it, editing it
 * (the last one, while nothing runs) and "⋯": back to before this turn, asking it again in a new
 * conversation, what AI got as it was. Edited, it is a box in its place, with its pictures, sent
 * again as a new turn (`ChatSession.resend`), taking back what the turn changed first unless people
 * keep it. What is written in the box is kept as a draft, as the box of the chat keeps its own: a
 * task that starts meanwhile, another conversation, a reload lose none of it.
 */
export function UserBubble(props: {
  readonly turn: Turn;
  readonly latest: boolean;
  readonly busy: boolean;
  readonly onForked: () => void;
}) {
  const workbench = useWorkbench();
  const { chat } = workbench;
  const { t } = useTranslation();
  const copy = useCopy();
  const { turn, busy } = props;
  const project = chat.projectKey;
  const id = chat.getSnapshot().id;
  const key = id === undefined ? undefined : editKey(id, turn.task);
  const [editing, setEditing] = useOpened(`${turn.task}/editing`, false);
  const [going, setGoing] = useState<GoingBack>();
  const [sentOpen, setSentOpen] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  // What can be taken back changes with the project, and with what other windows did.
  useSyncExternalStore(workbench.undo.subscribe, workbench.undo.getSnapshot);
  const canGoBack = chat.canGoBack(turn.task);
  const canEdit = props.latest && !busy;

  if (editing && project !== undefined && key !== undefined)
    return (
      <div className={styles.userWrap} data-editing="">
        <UserEditor
          turn={turn}
          project={project}
          draft={key}
          busy={busy}
          onClose={(sent) => {
            chat.drafts.clear(project, key);
            chat.attachments.clear(project, key);
            setEditing(false);
            if (!sent) requestAnimationFrame(() => editButton.current?.focus());
          }}
        />
      </div>
    );
  const startEditing = () => {
    if (project === undefined || key === undefined) return;
    setGoing(undefined);
    setSentOpen(false);
    // A draft from before (a reload, another conversation meanwhile) comes back as it was.
    if (chat.drafts.read(project, key) === "" && !chat.attachments.has(project, key)) {
      chat.drafts.write(project, key, turn.user.text);
      chat.attachments.restore(project, key, turn.user.images ?? []);
    }
    setEditing(true);
  };
  return (
    <div className={styles.userWrap}>
      <div className={styles.user} data-testid="chat-user">
        <RefText text={turn.user.text} />
        {turn.user.images && <SentPictures images={turn.user.images} />}
      </div>
      <PicturesNotSent turn={turn} />
      <div className={styles.userActions}>
        <Tip name={t("chat.user.copy")} usage="">
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t("chat.user.copy")}
            data-testid="chat-user-copy"
            onClick={() => copy(plainOf(turn.user.text))}
          >
            <Copy size={13} aria-hidden />
          </button>
        </Tip>
        {canEdit && (
          <Tip name={t("chat.user.edit")} usage="">
            <button
              ref={editButton}
              type="button"
              className={styles.iconButton}
              aria-label={t("chat.user.edit")}
              data-testid="chat-user-edit"
              onClick={startEditing}
            >
              <Pencil size={13} aria-hidden />
            </button>
          </Tip>
        )}
        <UserMore
          backWhyNot={
            busy ? t("chat.user.whenDone") : canGoBack ? undefined : t("chat.user.backNone")
          }
          forkWhyNot={busy ? t("chat.user.whenDone") : undefined}
          onBack={() => {
            const plan = chat.backPlan(turn.task);
            setSentOpen(false);
            setGoing(plan && { plan });
          }}
          onFork={() => {
            chat.fork(turn.task);
            props.onForked();
          }}
          onSent={() => {
            setGoing(undefined);
            setSentOpen(true);
          }}
        />
      </div>
      {going && (
        <GoBack
          going={going}
          running={busy}
          onChange={setGoing}
          onClose={() => setGoing(undefined)}
        />
      )}
      {sentOpen && <SentCard turn={turn} onClose={() => setSentOpen(false)} />}
    </div>
  );
}

/** "⋯" of a message: what else can be done with it, and why not where it cannot. */
function UserMore(props: {
  readonly backWhyNot: string | undefined;
  readonly forkWhyNot: string | undefined;
  readonly onBack: () => void;
  readonly onFork: () => void;
  readonly onSent: () => void;
}) {
  const { t } = useTranslation();
  const { wrapRef, buttonRef, ...menu } = useBoxMenu();
  const item = (id: string, label: string, run: () => void, whyNot?: string) => (
    <button
      type="button"
      role="menuitem"
      disabled={whyNot !== undefined}
      data-testid={id}
      onClick={() => {
        menu.chosen();
        run();
      }}
    >
      <span className={styles.menuName}>{label}</span>
      {whyNot && <span className={styles.menuNote}>{whyNot}</span>}
    </button>
  );
  return (
    <div className={styles.moreWrap} ref={wrapRef} data-open={menu.open || undefined}>
      <Tip name={t("chat.user.more")} usage="">
        <button
          type="button"
          ref={buttonRef}
          className={styles.iconButton}
          aria-label={t("chat.user.more")}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          data-testid="chat-user-more"
          onClick={menu.onButtonClick}
          onKeyDown={menu.onButtonKeyDown}
        >
          <MoreHorizontal size={13} aria-hidden />
        </button>
      </Tip>
      {menu.open && (
        <div
          className={styles.menu}
          role="menu"
          aria-label={t("chat.user.more")}
          onKeyDown={menu.onMenuKeyDown}
        >
          {item("chat-user-back", t("chat.user.back"), props.onBack, props.backWhyNot)}
          {item("chat-user-fork", t("chat.user.fork"), props.onFork, props.forkWhyNot)}
          {item("chat-user-show-sent", t("chat.user.sent"), props.onSent)}
        </div>
      )}
    </div>
  );
}

/** What AI got of a message, as it was: links, the lines of its pictures, asking for a plan. */
function SentCard({ turn, onClose }: { readonly turn: Turn; readonly onClose: () => void }) {
  const { t } = useTranslation();
  const copy = useCopy();
  const sent = promptOf(turn.user);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => card.current?.focus(), []);
  return (
    <div
      className={styles.sentCard}
      data-testid="chat-user-sent"
      ref={card}
      tabIndex={-1}
      role="group"
      aria-label={t("chat.user.sentTitle")}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className={styles.sentHead}>
        <span className={styles.sentTitle}>{t("chat.user.sentTitle")}</span>
        <button type="button" className={styles.textLink} onClick={() => copy(sent)}>
          {t("chat.user.copy")}
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t("chat.user.close")}
          onClick={onClose}
        >
          <X size={12} aria-hidden />
        </button>
      </div>
      <pre>{sent}</pre>
    </div>
  );
}

/**
 * A message as a box in its place, to send again: the same blocks, its pictures under it (each to
 * take away, more to paste in), "取消" and "重发". Where the turn changed something that can still
 * go back, "重发" first takes that back, and its menu keeps it instead. Before anything is taken
 * back, the message is checked as sending checks it: what holds it back (no key, a model that sees
 * no pictures) is said in the box, and nothing is taken back. While a task runs nothing goes; the
 * box stays as it is. Enter sends as the box of the chat does, Esc puts the message back as it was.
 * The commands of the palette that put things in ("插入播放头时间") come here while it is open.
 */
function UserEditor(props: {
  readonly turn: Turn;
  readonly project: string;
  /** Where its words and pictures are kept, see `editKey`. */
  readonly draft: string;
  readonly busy: boolean;
  /** Closed: `sent` once it went. */
  readonly onClose: (sent: boolean) => void;
}) {
  const workbench = useWorkbench();
  const { chat, ai, keybindings, pointing } = workbench;
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const withMod = settings.sendWith === "modEnter";
  const { turn, project, draft, busy, onClose } = props;
  const readText = useCallback(() => chat.drafts.read(project, draft), [chat, project, draft]);
  const text = useSyncExternalStore(chat.drafts.subscribe, readText);
  const readPictures = useCallback(
    () => chat.attachments.list(project, draft),
    [chat, project, draft],
  );
  const pictures = useSyncExternalStore(chat.attachments.subscribe, readPictures);
  const [held, setHeld] = useState<string>();
  const [checking, setChecking] = useState(false);
  const box = useRef<ChatInputHandle>(null);
  const { wrapRef: waysWrap, buttonRef: waysButton, ...ways } = useBoxMenu();
  // What a resend would take back first: the places the card of the turn counts, where they can go.
  useSyncExternalStore(workbench.undo.subscribe, workbench.undo.getSnapshot);
  const places = placesOf(summaryOf(turn.entries));
  const changed = places > 0 && chat.undoState(turn.task) === "undo" ? places : 0;
  const now = chat.modelNow();
  const modelName =
    (now && ai.modelOf(now.ref.service, now.ref.model)?.name) ?? now?.ref.model ?? "";
  // The commands that put something in go to this box, the others to the box of the chat.
  const compose = useMemo(
    () => ({
      time: () => {
        const ref = pointing.timeRef();
        if (ref) box.current?.insert([ref]);
      },
      selection: () => {
        const refs = pointing.selectedRefs();
        if (refs.length > 0) box.current?.insert(refs);
      },
    }),
    [pointing],
  );
  useEffect(() => workbench.composeWith(compose), [workbench, compose]);
  useEffect(() => {
    const element = box.current?.element;
    if (!element) return;
    element.focus();
    // The caret at the end, where people go on writing.
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  }, []);

  const ready = pictures.filter((item) => item.state === "ready");
  const working = pictures.some((item) => item.state === "working");
  const empty = text.trim() === "" && ready.length === 0;
  const blocked = empty || busy || working || checking;
  const send = async (undoFirst: boolean) => {
    if (blocked) return;
    setChecking(true);
    try {
      // A picture the browser lost since: it says so, and nothing goes.
      if (ready.length > 0 && !(await chat.attachments.verify(project, draft))) {
        setHeld(t("chat.pictures.lost"));
        return;
      }
      const images = chat.attachments.ready(project, draft);
      // Nothing is taken back for a message that would not go.
      const why = await chat.holdFor(images);
      if (why) {
        setHeld(t(`chat.hold.${why}`));
        return;
      }
    } finally {
      setChecking(false);
    }
    const images = chat.attachments.ready(project, draft);
    onClose(true);
    if (undoFirst) await chat.undoTask(turn.task);
    void chat.resend({ text, images }, turn.task);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    const mod = keybindings.platform === "mac" ? event.metaKey : event.ctrlKey;
    event.preventDefault();
    if (!withMod || mod) void send(changed > 0);
    // Enter is a new line where Ctrl+Enter sends.
    else document.execCommand("insertLineBreak");
  };
  const sendKeys = formatCombo(withMod ? "mod+enter" : "enter", keybindings.platform);
  return (
    <div
      className={styles.editor}
      data-testid="chat-user-editor"
      onKeyDown={(event) => {
        // Esc anywhere in it, a menu of it aside, which closes by itself first.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose(false);
      }}
    >
      <ChatInput
        ref={box}
        value={text}
        onChange={(value) => {
          setHeld(undefined);
          chat.drafts.write(project, draft, value);
        }}
        onKeyDown={onKeyDown}
        onFiles={(files) => {
          setHeld(undefined);
          void chat.attachments.add(project, draft, files).then((refused) => {
            if (refused) setHeld(t(`chat.pictures.${refused}`));
          });
        }}
        label={t("chat.user.editing")}
        placeholder=""
        gone={(href) => pointing.stateOf(href) === "gone"}
        onPoint={(href) => workbench.pointAt(href)}
        onOpen={(href) => workbench.goToRef(href)}
        onFocus={() => workbench.composeWith(compose)}
        testId="chat-user-editor-input"
      />
      {pictures.length > 0 && (
        <Attachments
          project={project}
          chat={draft}
          items={pictures}
          blind={chat.seesPictures() === false ? modelName : undefined}
        />
      )}
      {(held || busy) && (
        <p className={styles.editorNote} role="status" data-testid="chat-user-editor-held">
          {held ?? t("chat.user.waitRunning")}
        </p>
      )}
      <div className={styles.editorRow}>
        <button type="button" className={styles.ghost} onClick={() => onClose(false)}>
          {t("chat.user.cancel")}
        </button>
        {changed > 0 ? (
          <span className={styles.split} ref={waysWrap}>
            <Tip
              name={t("chat.user.undoResendFull", { count: changed })}
              usage=""
              shortcut={sendKeys}
            >
              <button
                type="button"
                className={styles.primary}
                disabled={blocked}
                data-testid="chat-user-resend"
                data-mode="undo"
                onClick={() => void send(true)}
              >
                {t("chat.user.undoResend", { count: changed })}
              </button>
            </Tip>
            <button
              type="button"
              ref={waysButton}
              className={styles.primary}
              aria-label={t("chat.user.resendWays")}
              aria-haspopup="menu"
              aria-expanded={ways.open}
              disabled={blocked}
              data-testid="chat-user-resend-ways"
              onClick={ways.onButtonClick}
              onKeyDown={ways.onButtonKeyDown}
            >
              <ChevronDown size={12} aria-hidden />
            </button>
            {ways.open && (
              <div
                className={styles.menu}
                role="menu"
                aria-label={t("chat.user.resendWays")}
                onKeyDown={ways.onMenuKeyDown}
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="chat-user-resend"
                  data-mode="undo"
                  onClick={() => {
                    ways.close();
                    void send(true);
                  }}
                >
                  {t("chat.user.undoResendFull", { count: changed })}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="chat-user-resend"
                  data-mode="keep"
                  onClick={() => {
                    ways.close();
                    void send(false);
                  }}
                >
                  {t("chat.user.keepResend")}
                </button>
              </div>
            )}
          </span>
        ) : (
          <Tip name={t("chat.user.resend")} usage="" shortcut={sendKeys}>
            <button
              type="button"
              className={styles.primary}
              disabled={blocked}
              data-testid="chat-user-resend"
              data-mode="keep"
              onClick={() => void send(false)}
            >
              {t("chat.user.resend")}
            </button>
          </Tip>
        )}
      </div>
    </div>
  );
}

/** The pictures of a message, small; a click shows one large. */
function SentPictures({ images }: { readonly images: readonly AttachedImage[] }) {
  const { chatSync } = useWorkbench();
  const { t } = useTranslation();
  const [large, setLarge] = useState<{ url: string; label: string } | undefined>();
  /** Which pictures show, by their hash, as each was read. */
  const [shown, setShown] = useState<ReadonlyMap<string, boolean>>(new Map());
  // As this window finds pictures that stayed here.
  useSyncExternalStore(chatSync?.subscribe ?? noSubscribe, chatSync?.getSnapshot ?? noSnapshot);
  // Each picture that stayed on one device as the conversation went to the account: here, where it
  // shows, else on another one.
  const held = new Map<string, { why: ChatImageHeld; here: boolean }>();
  for (const image of images) {
    const why = chatSync?.heldOf(image.image) ?? image.held;
    const showing = shown.get(image.image);
    if (why === undefined || showing === undefined) continue;
    held.set(image.image, { why, here: showing });
  }
  const lines = new Map<string, number>();
  for (const { why, here } of held.values()) {
    const key = `${here ? "here" : "there"}/${why}`;
    lines.set(key, (lines.get(key) ?? 0) + 1);
  }
  return (
    <>
      <span className={styles.sentPictures}>
        {images.map((image, index) => (
          <SentPicture
            key={`${image.image}/${index}`}
            image={image}
            held={held.has(image.image) && !held.get(image.image)!.here}
            fromAccount={chatSync !== undefined}
            onShown={(showing) =>
              setShown((before) =>
                before.get(image.image) === showing
                  ? before
                  : new Map(before).set(image.image, showing),
              )
            }
            onOpen={(url, label) => setLarge({ url, label })}
          />
        ))}
        {large && <LargePicture {...large} onClose={() => setLarge(undefined)} />}
      </span>
      {[...lines].map(([key, count]) => {
        const [where, why] = key.split("/") as ["here" | "there", ChatImageHeld];
        return (
          <p key={key} className={styles.userNote} data-testid="chat-picture-held" data-held={why}>
            {t(`chat.pictures.held.${where}.${images.length === 1 ? "one" : "some"}`, {
              count,
              why: t(`chat.pictures.heldWhy.${why}`),
            })}
          </p>
        );
      })}
    </>
  );
}

const noSubscribe = () => () => {};
const noSnapshot = () => undefined;

function SentPicture(props: {
  readonly image: AttachedImage;
  /** It stayed on another device: there is nothing to try again. */
  readonly held: boolean;
  /** Pictures not here can come from the account, which may fail and be tried again. */
  readonly fromAccount: boolean;
  readonly onShown: (showing: boolean) => void;
  readonly onOpen: (url: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const { url, reading } = usePicture(props.image.image, attempt);
  const { onShown } = props;
  useEffect(() => {
    if (!reading) onShown(url !== undefined);
  }, [reading, url, onShown]);
  const label = props.image.label ?? "";
  if (!url && !reading && !props.held && props.fromAccount)
    return (
      <span className={styles.sentPicture} data-testid="chat-sent-picture" data-state="unreadable">
        <span>{t("chat.pictures.fetchFailed")}</span>
        <button
          type="button"
          className={styles.pictureRetry}
          data-testid="chat-picture-retry"
          onClick={() => setAttempt((count) => count + 1)}
        >
          {t("chat.pictures.retryRead")}
        </button>
      </span>
    );
  return (
    <button
      type="button"
      className={styles.sentPicture}
      data-testid="chat-sent-picture"
      data-state={url ? "shown" : reading ? "reading" : "elsewhere"}
      title={label}
      disabled={!url}
      onClick={() => url && props.onOpen(url, label)}
    >
      {url ? (
        <img src={url} alt={label} />
      ) : (
        <span>{reading ? t("chat.pictures.reading") : t("chat.pictures.missing")}</span>
      )}
    </button>
  );
}

/**
 * Pictures of an earlier turn do not go to a model that takes none, which the conversation uses
 * now: the turn says so.
 */
function PicturesNotSent({ turn }: { readonly turn: Turn }) {
  const { chat, ai } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  if (!turn.user.images?.length || chat.seesPictures() !== false) return null;
  const now = chat.modelNow();
  const name = (now && ai.modelOf(now.ref.service, now.ref.model)?.name) ?? now?.ref.model ?? "";
  return (
    <p className={styles.userNote} data-testid="chat-pictures-not-sent">
      {t("chat.pictures.notSent", { model: name, interpolation: { escapeValue: false } })}
    </p>
  );
}
