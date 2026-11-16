import type { RepositoryConflict } from "@animaquill/host";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { fieldName } from "../chat/change-line.ts";
import { timeText } from "../chat/toolSummary.ts";
import { TAKEABLE, splitLabel, type ConflictRow } from "../cloud/conflicts.ts";
import type { DialogRequest } from "../workbench/dialogs.ts";
import { loadCodeEditor } from "../code/load.ts";
import { useWorkbench } from "./context.ts";
import host from "./DialogHost.module.css";
import styles from "./ConflictsDialog.module.css";

type ConflictsRequest = Extract<DialogRequest, { kind: "conflicts" }>;

const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The fields of a value that times are in, which read as a timecode. */
const TIMES = new Set(["start", "duration", "offset", "end", "time", "in", "out"]);

/** What a conflict is about within its object: a field, lines of code, the whole file. */
function partOf(t: TFunction, conflict: RepositoryConflict): string {
  if (conflict.kind === "lines" && conflict.lines) {
    const { from, to } = conflict.lines;
    return to <= from + 1
      ? t("repoMerge.list.line", { line: from + 1 })
      : t("repoMerge.list.lines", { from: from + 1, to });
  }
  if (conflict.kind === "file") return t("repoMerge.list.wholeFile");
  if (conflict.kind === "check-duplicate") return t("repoMerge.list.duplicate");
  if (conflict.kind === "asset-file") return t("repoMerge.list.assetFile");
  if (conflict.kind === "removed-link") return t("repoMerge.list.removedLink");
  const { part } = splitLabel(conflict.label);
  return part === undefined ? conflict.label : fieldName(t, part);
}

/** A value as people read it: a timecode, a colour with its swatch, text, a count of keyframes. */
function Value({ value, field }: { readonly value: unknown; readonly field: string }) {
  const { t } = useTranslation();
  if (value === undefined)
    return <span className={styles.none}>{t("repoMerge.list.removed")}</span>;
  if (typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value))
    return (
      <span className={styles.color}>
        <span className={styles.swatch} style={{ background: value }} />
        <code>{value}</code>
      </span>
    );
  if ((typeof value === "string" || typeof value === "number") && TIMES.has(field))
    return <code>{timeText(value) ?? String(value)}</code>;
  if (typeof value === "string") return <span className={styles.text}>{value}</span>;
  if (typeof value === "number" || typeof value === "boolean") return <code>{String(value)}</code>;
  if (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { keys?: unknown }).keys)
  )
    return (
      <span>
        {t("repoMerge.list.keyframes", { count: (value as { keys: unknown[] }).keys.length })}
      </span>
    );
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return <span className={styles.text}>{value.join(" → ")}</span>;
  const text = JSON.stringify(value);
  return <code className={styles.json}>{text.length > 200 ? `${text.slice(0, 199)}…` : text}</code>;
}

/** Lines of code, those that the other side does not have marked. */
function Lines({ text, other }: { readonly text: unknown; readonly other: unknown }) {
  const { t } = useTranslation();
  if (typeof text !== "string")
    return <span className={styles.none}>{t("repoMerge.list.removed")}</span>;
  const others = new Set(typeof other === "string" ? other.split("\n") : []);
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <pre className={styles.code}>
      {lines.map((line, index) => (
        <span key={index} data-changed={others.has(line) ? undefined : ""}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/** One side of a conflict: whose, when, and the value. */
function Side({
  conflict,
  side,
  using,
  field,
  open,
}: {
  readonly conflict: RepositoryConflict;
  readonly side: "here" | "github";
  readonly using: boolean;
  readonly field: string;
  readonly open: (url: string) => void;
}) {
  const { t } = useTranslation();
  // Where GitHub's side stayed (`lost: "change"`), the project has GitHub's, and what went is ours.
  const isGitHubKept = conflict.lost === "change";
  const value =
    side === "here"
      ? isGitHubKept
        ? conflict.theirs
        : conflict.ours
      : isGitHubKept
        ? conflict.ours
        : conflict.theirs;
  const other =
    side === "here"
      ? isGitHubKept
        ? conflict.ours
        : conflict.theirs
      : isGitHubKept
        ? conflict.theirs
        : conflict.ours;
  // When that side was written, or else when the conflict was found: every row says a time.
  const at = (side === "here" ? conflict.oursAt : conflict.theirsAt) ?? conflict.at;
  const isCode = conflict.kind === "lines" || conflict.kind === "file";
  return (
    <div className={styles.side} data-side={side} data-using={using || undefined}>
      <div className={styles.whose}>
        {using && <span className={styles.dot} aria-hidden="true" />}
        {using && <span>{t("repoMerge.list.using")} · </span>}
        <span>{t(side === "here" ? "repoMerge.list.here" : "repoMerge.list.github")}</span>
        {at !== undefined && <span> · {clock.format(at)}</span>}
        {side === "github" && conflict.theirsUrl && conflict.theirsSha && (
          <button type="button" className={styles.link} onClick={() => open(conflict.theirsUrl!)}>
            {t("repoMerge.list.commit", { sha: conflict.theirsSha.slice(0, 7) })} ↗
          </button>
        )}
      </div>
      {conflict.large && value === undefined ? (
        <span className={styles.none}>{t("repoMerge.list.large")}</span>
      ) : isCode && conflict.kind === "lines" ? (
        <Lines text={value} other={other} />
      ) : conflict.kind === "file" ? (
        value === undefined ? (
          <span className={styles.none}>{t("repoMerge.list.removed")}</span>
        ) : (
          <code>{conflict.file}</code>
        )
      ) : (
        <Value value={value} field={field} />
      )}
    </div>
  );
}

/** Two versions of a file of code in the code editor, to choose by hand what stays. */
function Compare({
  path,
  ours,
  theirs,
  onDone,
}: {
  readonly path: string;
  readonly ours: string;
  readonly theirs: string;
  readonly onDone: (text: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const place = useRef<HTMLDivElement>(null);
  const view = useRef<{ readonly ours: string; dispose(): void } | undefined>(undefined);
  useEffect(() => {
    const over = new AbortController();
    void loadCodeEditor().then(({ DiffView }) => {
      if (over.signal.aborted || !place.current) return;
      view.current = new DiffView(place.current, { path, ours, theirs });
    });
    return () => {
      over.abort();
      view.current?.dispose();
      view.current = undefined;
    };
  }, [path, ours, theirs]);
  return (
    <div className={styles.compare} data-compare={path}>
      <div className={styles.compareHead}>
        <span>
          {t("repoMerge.compare.title", { file: path, interpolation: { escapeValue: false } })}
        </span>
      </div>
      <div ref={place} className={styles.diff} />
      <div className={host.buttons}>
        <button type="button" onClick={() => onDone(undefined)}>
          {t("repoMerge.compare.cancel")}
        </button>
        <button
          type="button"
          className={host.primary}
          onClick={() => onDone(view.current?.ours ?? ours)}
        >
          {t("repoMerge.compare.save")}
        </button>
      </div>
    </div>
  );
}

/**
 * The places both the project and GitHub changed (screen G2 of the design): by object, both values
 * side by side as what they are, the one in use marked; GitHub's taken with one press, which Ctrl+Z
 * takes back, or the project's kept; code compared in the code editor. What is settled folds away.
 */
export function ConflictsDialog({ request }: { request: ConflictsRequest }) {
  const workbench = useWorkbench();
  const { dialogs } = workbench;
  const { t } = useTranslation();
  const { list, archiving, locate, openFile, open } = request;
  const snapshot = useSyncExternalStore(list.subscribe, list.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const [comparing, setComparing] = useState<
    { conflict: RepositoryConflict; ours: string; theirs: string } | undefined
  >();

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const dismiss = () => dialogs.answer(undefined);
  const openCount = snapshot.open.reduce((sum, group) => sum + group.rows.length, 0);
  const isDone = snapshot.status === "ready" && openCount === 0;

  /** The whole file of both sides, for comparing in the code editor. */
  const compare = (conflict: RepositoryConflict) => {
    const now = workbench.session.store?.getState().files[conflict.file];
    if (typeof now !== "string") return;
    const isGitHubKept = conflict.lost === "change";
    const mine = isGitHubKept ? conflict.theirs : conflict.ours;
    const github = isGitHubKept ? conflict.ours : conflict.theirs;
    let theirs = now;
    if (conflict.kind === "file" && typeof github === "string") theirs = github;
    else if (conflict.kind === "lines" && typeof mine === "string" && typeof github === "string") {
      const parts = now.split(mine);
      if (parts.length === 2) theirs = parts.join(github);
    }
    setComparing({ conflict, ours: now, theirs });
  };

  const compared = (text: string | undefined) => {
    const was = comparing;
    setComparing(undefined);
    if (!was || text === undefined) return;
    const store = workbench.session.store;
    if (!store) return;
    if (text !== was.ours) {
      const result = store.execute({
        type: "file.write",
        params: { path: was.conflict.file, text },
      });
      if (!result.ok) return;
    }
    // What people put together by hand is the project's side now.
    void list.keep([was.conflict.id]);
  };

  const rowView = ({ conflict, failed }: ConflictRow) => {
    const isGitHubKept = conflict.lost === "change";
    const field = conflict.path.at(-1) ?? "";
    const takeable = TAKEABLE.has(conflict.kind);
    const removesTheirs = conflict.theirs === undefined && conflict.kind !== "lines";
    return (
      <div
        key={conflict.id}
        className={styles.row}
        data-conflict={conflict.id}
        data-kind={conflict.kind}
      >
        <div className={styles.part}>{partOf(t, conflict)}</div>
        {takeable ? (
          <>
            <Side conflict={conflict} side="here" using={!isGitHubKept} field={field} open={open} />
            <Side
              conflict={conflict}
              side="github"
              using={isGitHubKept}
              field={field}
              open={open}
            />
          </>
        ) : (
          // What only people can settle: what it is about, not two values to choose from.
          <div className={styles.only}>
            <code>{conflict.file}</code>
            {conflict.theirsUrl && conflict.theirsSha && (
              <button
                type="button"
                className={styles.link}
                onClick={() => open(conflict.theirsUrl!)}
              >
                {t("repoMerge.list.commit", { sha: conflict.theirsSha.slice(0, 7) })} ↗
              </button>
            )}
          </div>
        )}
        <div className={styles.choices}>
          {takeable && (
            <button
              type="button"
              disabled={snapshot.busy}
              onClick={() => void list.take([conflict.id])}
            >
              {isGitHubKept
                ? t("repoMerge.list.takeHere")
                : removesTheirs
                  ? t("repoMerge.list.deleteToo")
                  : t("repoMerge.list.take")}
            </button>
          )}
          {conflict.kind === "check-duplicate" && (
            <button type="button" onClick={() => openFile(conflict.file)}>
              {t("repoMerge.list.openFile")}
            </button>
          )}
          <button
            type="button"
            disabled={snapshot.busy}
            onClick={() => void list.keep([conflict.id])}
          >
            {takeable
              ? t(isGitHubKept ? "repoMerge.list.keepGithub" : "repoMerge.list.keep")
              : t("repoMerge.list.seen")}
          </button>
          {failed && (
            <span className={styles.failed} role="status">
              {t(failed === "changed" ? "repoMerge.list.notTaken" : "repoMerge.list.notTakenOther")}
            </span>
          )}
        </div>
      </div>
    );
  };

  const handledText = ({ conflict, state }: ConflictRow) => {
    const isGitHubKept = conflict.lost === "change";
    if (state === "stale") return t("repoMerge.list.stale");
    if (state === "theirs")
      return t(isGitHubKept ? "repoMerge.list.tookHere" : "repoMerge.list.tookTheirs");
    return t(isGitHubKept ? "repoMerge.list.keptGithub" : "repoMerge.list.keptOurs");
  };

  const title =
    snapshot.status === "ready" && openCount > 0
      ? t("repoMerge.list.title", { count: openCount })
      : request.title;

  return (
    <dialog
      ref={dialog}
      className={`${host.wide} ${styles.dialog}`}
      aria-label={title}
      data-conflicts={snapshot.status}
      onCancel={(event) => {
        event.preventDefault();
        if (comparing) setComparing(undefined);
        else dismiss();
      }}
    >
      <div className={styles.head}>
        <h2>{title}</h2>
        <button
          type="button"
          className={styles.close}
          aria-label={t("repoMerge.list.close")}
          onClick={dismiss}
        >
          ×
        </button>
      </div>
      {comparing ? (
        <Compare
          path={comparing.conflict.file}
          ours={comparing.ours}
          theirs={comparing.theirs}
          onDone={compared}
        />
      ) : (
        <div className={styles.body}>
          {snapshot.status === "loading" && (
            <p className={styles.state}>{t("repoMerge.list.loading")}</p>
          )}
          {snapshot.status === "failed" && (
            <p className={styles.state} role="alert">
              {t("repoMerge.list.failed")}{" "}
              <button type="button" className={styles.link} onClick={() => void list.load()}>
                {t("repoMerge.list.retry")}
              </button>
            </p>
          )}
          {snapshot.trouble && (
            <p className={styles.failed} role="alert">
              {t("repoMerge.list.busy")}
            </p>
          )}
          {isDone && (
            <p className={styles.done} role="status" data-done="">
              {t("repoMerge.list.done")}
              {archiving() && `，${t("repoMerge.list.archiving")}`}
            </p>
          )}
          {openCount > 0 && (
            <div className={styles.all}>
              <button type="button" disabled={snapshot.busy} onClick={() => void list.keepAll()}>
                {t("repoMerge.list.keepAll")}
              </button>
              <button type="button" disabled={snapshot.busy} onClick={() => void list.takeAll()}>
                {t("repoMerge.list.takeAll")}
              </button>
            </div>
          )}
          {snapshot.open.map((group) => {
            const first = group.rows[0]?.conflict;
            const isCode = first !== undefined && (first.kind === "lines" || first.kind === "file");
            return (
              <section key={group.key} className={styles.group} data-group={group.key}>
                <div className={styles.groupHead}>
                  <span className={styles.groupTitle}>
                    {group.title || t("repoMerge.list.project")}
                  </span>
                  {first && isCode ? (
                    <button type="button" className={styles.link} onClick={() => compare(first)}>
                      {t("repoMerge.list.compare")}
                    </button>
                  ) : (
                    first &&
                    group.object && (
                      <button type="button" className={styles.link} onClick={() => locate(first)}>
                        {t("repoMerge.list.locate")}
                      </button>
                    )
                  )}
                </div>
                {group.rows.map(rowView)}
              </section>
            );
          })}
          {snapshot.handled.length > 0 && (
            <details className={styles.handled}>
              <summary>{t("repoMerge.list.handled", { count: snapshot.handled.length })}</summary>
              <ul>
                {snapshot.handled.map((row) => (
                  <li key={row.conflict.id} data-handled={row.state}>
                    <span>{row.conflict.label}</span>
                    <span className={styles.muted}>{handledText(row)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </dialog>
  );
}
