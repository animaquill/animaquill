import { lazy, Suspense } from "react";
import styles from "./Markdown.module.css";
import type { ReadmeProps } from "./ReadmeBody.tsx";

/** The library that reads Markdown, loaded the first time a README shows, not with the page. */
const Body = lazy(() => import("./ReadmeBody.tsx"));

/** The README of a model pack, as Markdown: as plain text until the library is there. */
export function Readme(props: ReadmeProps) {
  return (
    <Suspense fallback={<div className={styles.plain}>{props.text}</div>}>
      <Body {...props} />
    </Suspense>
  );
}
