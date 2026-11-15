import { Image } from "lucide-react";
import { createContext, memo, useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./Markdown.module.css";
import readmeStyles from "./Readme.module.css";
import { readmeImage, readmeLink, type ReadmePlace } from "./readme-urls.ts";

/**
 * The README of a model pack, as Markdown, for people to read: someone else wrote it. HTML in it
 * shows as the text it is, nothing runs and nothing is put in a frame; links go to the web and mail
 * in a new tab, saying where they go when their words say otherwise; pictures of the repository show
 * from the commit installed, pictures from elsewhere only once people ask (see `readme-urls.ts`).
 */
export interface ReadmeProps {
  readonly text: string;
  /** Where the pack's files are on GitHub; nothing for a pack from this computer. */
  readonly place?: ReadmePlace | undefined;
}

const PLUGINS = [remarkGfm];

const Place = createContext<ReadmePlace | undefined>(undefined);

/** The words of an element of the README, to tell whether a link says where it goes. */
function textOf(node: unknown): string {
  const each = node as { type?: string; value?: string; children?: unknown[] } | undefined;
  if (!each) return "";
  if (each.type === "text") return each.value ?? "";
  return (each.children ?? []).map(textOf).join("");
}

function Link({
  href,
  node,
  children,
}: {
  readonly href?: string | undefined;
  readonly node?: unknown;
  readonly children?: ReactNode;
}) {
  const place = useContext(Place);
  const to = href === undefined ? undefined : readmeLink(href, place);
  if (!to) return <span data-testid="readme-not-link">{children}</span>;
  const words = textOf(node).trim();
  // Words that say something else than where it goes: where it goes, in small type after them,
  // for those who cannot hover.
  // A file of the repository itself needs no saying.
  const own =
    place !== undefined &&
    to.startsWith(`https://github.com/${place.owner}/${place.repo}/blob/${place.commit}/`);
  const says = own || words === to || words === href;
  return (
    <>
      <a
        href={to}
        target="_blank"
        rel="noopener noreferrer"
        title={words === to || words === href ? undefined : to}
        data-testid="readme-link"
      >
        {children}
      </a>
      {!says && (
        <small className={readmeStyles.address} data-testid="readme-link-address">
          {" "}
          ({to})
        </small>
      )}
    </>
  );
}

/**
 * A picture from elsewhere: a box that says where from, and the way to open it in a tab of its own.
 * The editor's pages show pictures only from GitHub's raw files (their policy), so it never loads
 * here; opened, the place it is at sees who asks.
 */
function Elsewhere(props: { readonly url: string; readonly host: string }) {
  const { t } = useTranslation();
  return (
    <span className={readmeStyles.elsewhere} data-testid="readme-image-elsewhere">
      <span className={readmeStyles.where}>
        <Image size={14} aria-hidden />
        <span>{t("ai.packs.readme.elsewhere", { host: props.host })}</span>
      </span>
      <a
        href={props.url}
        target="_blank"
        rel="noopener noreferrer"
        title={t("ai.packs.readme.openImageTitle")}
        data-testid="readme-image-open"
      >
        {t("ai.packs.readme.openImage")}
      </a>
    </span>
  );
}

function Picture({
  src,
  alt,
}: {
  readonly src?: string | Blob | undefined;
  readonly alt?: string | undefined;
}) {
  const place = useContext(Place);
  const { t } = useTranslation();
  const image = typeof src === "string" ? readmeImage(src, place) : ({ kind: "none" } as const);
  if (image.kind === "repository") {
    return (
      <img
        src={image.url}
        alt={alt ?? ""}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={readmeStyles.picture}
        data-testid="readme-image"
      />
    );
  }
  if (image.kind === "elsewhere") {
    return <Elsewhere url={image.url} host={image.host} />;
  }
  return (
    <span className={readmeStyles.elsewhere} data-testid="readme-image-none">
      <span className={readmeStyles.where}>
        <Image size={14} aria-hidden />
        {alt || t("ai.packs.readme.noImage")}
      </span>
    </span>
  );
}

function Table({ children }: { readonly children?: ReactNode }) {
  return (
    <div className={styles.table}>
      <table>{children}</table>
    </div>
  );
}

function TaskBox({
  type,
  checked,
}: {
  readonly type?: string | undefined;
  readonly checked?: boolean | undefined;
}) {
  return type === "checkbox" ? <input type="checkbox" checked={checked === true} disabled /> : null;
}

const COMPONENTS: Components = { a: Link, img: Picture, table: Table, input: TaskBox };

/** What may reach the renderers at all: only what `readmeLink` and `readmeImage` look at further. */
const keep = (url: string) =>
  /^(?:https?:|mailto:)/i.test(url.trim()) || !/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url : "";

function ReadmeBody({ text, place }: ReadmeProps) {
  return (
    <Place.Provider value={place}>
      <div className={`${styles.markdown} ${readmeStyles.readme}`} data-testid="pack-readme-body">
        <ReactMarkdown remarkPlugins={PLUGINS} urlTransform={keep} components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
    </Place.Provider>
  );
}

export default memo(ReadmeBody);
