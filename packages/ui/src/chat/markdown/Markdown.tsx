import { lazy, Suspense } from "react";
import styles from "./Markdown.module.css";
import type { MarkdownProps } from "./MarkdownBody.tsx";

/** The library that reads Markdown, loaded the first time an answer shows, not with the page. */
const Body = lazy(() => import("./MarkdownBody.tsx"));

/** What AI wrote, as Markdown: as plain text until the library is there. See `MarkdownBody`. */
export function Markdown(props: MarkdownProps) {
  return (
    <Suspense fallback={<div className={styles.plain}>{props.text}</div>}>
      <Body {...props} />
    </Suspense>
  );
}
