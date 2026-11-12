// Adapted from pi-web (https://github.com/agegr/pi-web), components/MarkdownBody.tsx, commit 57cea50.
// Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.
import { Image } from "lucide-react";
import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitMarkdownBlocks } from "./blocks.ts";
import styles from "./Markdown.module.css";

/**
 * What AI wrote, as Markdown, for people to read: never as HTML of its own (raw HTML shows as the
 * text it is), links open in a new tab without telling the page they came from, and images are
 * only a link to them, as nothing loads from elsewhere by itself.
 */
export interface MarkdownProps {
  readonly text: string;
  /** The answer is still on its way: only its last block is parsed again as words come. */
  readonly streaming?: boolean;
  /**
   * Links of the editor itself (`aq:`), such as a time or a clip in an answer, once AI writes them:
   * without this they show as text.
   */
  readonly onAppLink?: (href: string) => void;
}

/** Where links may go: the web, mail, and the editor's own `aq:`. Anything else is no link. */
const SAFE_URL = /^(?:https?:|mailto:|aq:)/i;

export const markdownUrl = (url: string): string => (SAFE_URL.test(url.trim()) ? url.trim() : "");

const PLUGINS = [remarkGfm];

/** One parse, skipped while its text and renderers stay the same. */
const Block = memo(function Block({
  markdown,
  components,
}: {
  readonly markdown: string;
  readonly components: Components;
}) {
  return (
    <ReactMarkdown remarkPlugins={PLUGINS} urlTransform={markdownUrl} components={components}>
      {markdown}
    </ReactMarkdown>
  );
});

/** Where the links of the editor go, see `MarkdownProps.onAppLink`. */
const AppLink = createContext<((href: string) => void) | undefined>(undefined);

function SafeLink({
  href,
  children,
}: {
  readonly href?: string | undefined;
  readonly children?: ReactNode;
}) {
  const onAppLink = useContext(AppLink);
  if (!href) return <span>{children}</span>;
  if (/^aq:/i.test(href)) {
    if (!onAppLink) return <span>{children}</span>;
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          onAppLink(href);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** An image is a link to it, which loads nothing by itself. */
function ImageLink({
  src,
  alt,
}: {
  readonly src?: string | Blob | undefined;
  readonly alt?: string | undefined;
}) {
  const href = typeof src === "string" ? src : undefined;
  return (
    <span className={styles.image}>
      <SafeLink href={href}>
        <Image size={12} aria-hidden="true" />
        {alt || href}
      </SafeLink>
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

const COMPONENTS: Components = { a: SafeLink, img: ImageLink, table: Table, input: TaskBox };

function MarkdownBody({ text, streaming, onAppLink }: MarkdownProps) {
  // An answer on its way grows by a few characters a piece; its finished blocks keep their parse
  // and only the last is parsed again. A finished answer is one block.
  const blocks = useMemo(() => (streaming ? splitMarkdownBlocks(text) : [text]), [streaming, text]);
  return (
    <AppLink.Provider value={onAppLink}>
      <div className={styles.markdown} data-testid="chat-markdown">
        {blocks.map((block, index) => (
          <Block key={index} markdown={block} components={COMPONENTS} />
        ))}
      </div>
    </AppLink.Provider>
  );
}

export default memo(MarkdownBody);
