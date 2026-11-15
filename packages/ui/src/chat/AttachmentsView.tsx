import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import type { Attachment } from "./attachments.ts";
import styles from "./ChatPanel.module.css";
import { bytesText } from "./shots.ts";

/** The address a picture kept here shows at, once it is read. */
export function usePictureUrl(image: string | undefined): string | undefined {
  const { chat } = useWorkbench();
  const [found, setFound] = useState<{ image: string; url: string | undefined } | undefined>();
  useEffect(() => {
    let live = true;
    if (image !== undefined) {
      void chat.attachments.urlOf(image).then((url) => {
        if (live) setFound({ image, url });
      });
    }
    return () => {
      live = false;
    };
  }, [chat, image]);
  return found !== undefined && found.image === image ? found.url : undefined;
}

/**
 * The pictures that go with the next message, over the box: each small, with what it is, its size
 * and how much it takes; ✕ takes it out, a click shows it large. A frame being made turns and can
 * be cancelled. Where the model takes no pictures, each has a yellow frame and says so.
 */
export function Attachments(props: {
  readonly project: string;
  readonly chat: string;
  readonly items: readonly Attachment[];
  /** The name of the model of the conversation, where it takes no pictures. */
  readonly blind: string | undefined;
}) {
  const { chat } = useWorkbench();
  const [large, setLarge] = useState<{ url: string; label: string } | undefined>();
  return (
    <div className={styles.pictures} data-testid="chat-pictures">
      {props.items.map((item) => (
        <Picture
          key={item.id}
          item={item}
          blind={props.blind}
          onRemove={() => chat.attachments.remove(props.project, props.chat, item.id)}
          onOpen={(url, label) => setLarge({ url, label })}
        />
      ))}
      {large && <LargePicture {...large} onClose={() => setLarge(undefined)} />}
    </div>
  );
}

function Picture(props: {
  readonly item: Attachment;
  readonly blind: string | undefined;
  readonly onRemove: () => void;
  readonly onOpen: (url: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const { item } = props;
  const ref = item.state === "ready" ? item.picture.ref : undefined;
  const url = usePictureUrl(ref?.image);
  const label = item.state === "ready" ? item.picture.label : item.label;
  const info = ref
    ? t("chat.pictures.info", {
        label,
        width: ref.width,
        height: ref.height,
        size: bytesText(ref.bytes),
        interpolation: { escapeValue: false },
      })
    : item.state === "working"
      ? t("chat.pictures.working")
      : t("chat.pictures.failed");
  return (
    <figure
      className={styles.picture}
      data-testid="chat-picture"
      data-state={item.state}
      data-blind={props.blind !== undefined && item.state === "ready" ? "" : undefined}
    >
      <button
        type="button"
        className={styles.pictureThumb}
        aria-label={t("chat.pictures.view")}
        disabled={!url}
        onClick={() => url && props.onOpen(url, label)}
      >
        {url ? (
          <img src={url} alt={label} />
        ) : item.state === "working" ? (
          <Loader2 size={16} className={styles.spin} aria-hidden />
        ) : null}
        {item.state === "ready" && item.picture.frame && (
          <span className={styles.pictureTime}>{item.picture.frame.timecode}</span>
        )}
      </button>
      <button
        type="button"
        className={styles.pictureRemove}
        aria-label={
          item.state === "working" ? t("chat.pictures.cancel") : t("chat.pictures.remove")
        }
        title={item.state === "working" ? t("chat.pictures.cancel") : t("chat.pictures.remove")}
        data-testid="chat-picture-remove"
        onClick={props.onRemove}
      >
        <X size={10} aria-hidden />
      </button>
      <figcaption data-testid="chat-picture-info">
        {props.blind !== undefined && item.state === "ready"
          ? t("chat.pictures.noVision", {
              model: props.blind,
              interpolation: { escapeValue: false },
            })
          : info}
      </figcaption>
    </figure>
  );
}

/** A picture large, over the page, until a click or Esc. */
export function LargePicture(props: {
  readonly url: string;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const { onClose } = props;
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [onClose]);
  return createPortal(
    <div
      className={styles.largePicture}
      role="dialog"
      aria-label={props.label}
      data-testid="chat-picture-large"
      onClick={onClose}
    >
      <img src={props.url} alt={props.label} />
      <button type="button" className={styles.largeClose} aria-label={t("chat.pictures.close")}>
        <X size={14} aria-hidden />
      </button>
    </div>,
    document.body,
  );
}
