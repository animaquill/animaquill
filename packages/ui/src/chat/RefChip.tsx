import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useSession, useWorkbench } from "../app/context.ts";
import styles from "./ChatPanel.module.css";
import { kindOfRef, piecesOf, type ChatRef, type RefKind } from "./refs.ts";

/** The lines of the icon of each kind of block, on a grid of 24, as the icons of the editor. */
const ICONS: Record<RefKind, readonly string[]> = {
  time: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"],
  object: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M3 9h18"],
  keyframe: ["M12 3 21 12 12 21 3 12z"],
  file: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"],
  objects: ["M12 2 2 7l10 5 10-5-10-5z", "m2 17 10 5 10-5", "m2 12 10 5 10-5"],
  agent: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  unknown: [
    "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7",
    "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  ],
};

export const iconPathOf = (kind: RefKind): readonly string[] => ICONS[kind];

export function RefIcon({ kind }: { readonly kind: RefKind }) {
  return (
    <svg viewBox="0 0 24 24" width={11} height={11} aria-hidden className={styles.chipIcon}>
      {ICONS[kind].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * A block in the conversation, of people's words or of an answer: what it points at lights up on
 * the timeline and in the preview while the pointer is on it, and a click goes there. Grey and
 * still where it is no more.
 */
export function RefChip({ chatRef }: { readonly chatRef: ChatRef }) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  // Whether it is still there changes with the project.
  useSyncExternalStore(store?.subscribe ?? noop, store?.getState ?? none);
  const state = workbench.pointing.stateOf(chatRef.href);
  const kind = kindOfRef(chatRef.href);
  const gone = state === "gone";
  return (
    <a
      href={chatRef.href}
      className={styles.chip}
      data-testid="chat-chip"
      data-kind={kind}
      data-gone={gone ? "" : undefined}
      aria-disabled={gone || undefined}
      title={
        gone ? t("chat.refs.gone") : state === "elsewhere" ? t("chat.refs.elsewhere") : undefined
      }
      onPointerEnter={() => workbench.pointAt(chatRef.href)}
      onPointerLeave={() => workbench.pointAt(undefined)}
      onClick={(event) => {
        event.preventDefault();
        if (!gone) workbench.goToRef(chatRef.href);
      }}
    >
      <RefIcon kind={kind} />
      <span className={styles.chipLabel}>{chatRef.label}</span>
      {gone && <span className={styles.chipGone}>{t("chat.refs.goneMark")}</span>}
    </a>
  );
}

/** Words with their blocks, as people wrote them. */
export function RefText({ text }: { readonly text: string }) {
  return (
    <>
      {piecesOf(text).map((piece, index) =>
        "ref" in piece ? (
          <RefChip key={index} chatRef={piece.ref} />
        ) : (
          <span key={index}>{piece.text}</span>
        ),
      )}
    </>
  );
}

const noop = () => () => {};
const none = () => undefined;
