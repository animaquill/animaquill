import type { PlatformProjectUse } from "@animaquill/host";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import host from "../app/DialogHost.module.css";
import { placedT } from "../i18n/i18n.ts";
import type { DialogRequest } from "../workbench/dialogs.ts";
import { agoText } from "../app/start-view.ts";
import { formatPlatformBytes, partOf, releaseBlockText } from "./platform-space.ts";
import styles from "./PlatformSpace.module.css";

type FullRequest = Extract<DialogRequest, { kind: "platformFull" }>;

/** Projects the dialog lists at most: what makes room is among the first few. */
const LISTED = 5;

const noSubscription = () => () => {};
const noAccount = () => undefined;

/**
 * "平台存储满了" / "在线项目数满了" (docs/design/online-offline.md of AnimaQuill Cloud, 3.6): a new
 * project, an import or a restore found no room on the platform. The projects that make room, each
 * with what makes it: where the bytes are full, the largest, to let go of (here, at once) or to
 * keep in a folder; where the number is, those changed longest ago, to keep in a folder or delete.
 * One that cannot be let go of says why on its row, as a dialog shows no hovering tips. Once room
 * is made, what was asked goes on by itself: whoever showed the dialog hears so.
 */
export function PlatformFullDialog({ request }: { request: FullRequest }) {
  const workbench = useWorkbench();
  const { dialogs, platformSpace, account } = workbench;
  const { t: baseT } = useTranslation();
  const who = useSyncExternalStore(
    account?.subscribe ?? noSubscription,
    account?.getSnapshot ?? noAccount,
  );
  const t = placedT(
    baseT,
    who?.status === "signedIn" && who.repositories === "local" ? "local" : undefined,
  );
  const { space } = useSyncExternalStore(platformSpace.subscribe, platformSpace.getSnapshot);
  const [releasing, setReleasing] = useState<string>();
  const [now] = useState(() => Date.now());
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    close.current?.focus();
    return () => element?.close();
  }, []);

  const isMine = () => dialogs.getSnapshot()?.id === request.id;
  const answer = (value: Parameters<typeof dialogs.answer>[0]) => {
    if (isMine()) dialogs.answer(value);
  };
  const byCount = request.by === "count";
  const changedAt = request.changedAt;
  const all = space?.projects ?? [];
  const rows: readonly PlatformProjectUse[] = byCount
    ? all
        .toSorted(
          (a, b) =>
            (changedAt?.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
              (changedAt?.get(b.id) ?? Number.MAX_SAFE_INTEGER) || b.bytes - a.bytes,
        )
        .slice(0, LISTED)
    : all.filter((each) => each.state === "live" && each.bytes > 0).slice(0, LISTED);
  const part =
    space &&
    (byCount ? partOf(space.count.used, space.count.limit) : partOf(space.used, space.limit));

  const release = async (row: PlatformProjectUse) => {
    setReleasing(row.id);
    const went = await request.release(row.id, row.name).catch(() => false);
    if (!isMine()) return;
    setReleasing(undefined);
    if (went) answer({ kind: "freed" });
  };

  return (
    <dialog
      ref={dialog}
      className={`${host.wide} ${styles.full}`}
      aria-label={request.title}
      data-platform-full={request.by}
      onCancel={(event) => {
        event.preventDefault();
        if (releasing === undefined) answer(undefined);
      }}
    >
      <div className={host.content}>
        <h2>{request.title}</h2>
        <p>
          {t(
            byCount ? "storage.platform.full.countMessage" : "storage.platform.full.storageMessage",
          )}
        </p>
        {part !== undefined && (
          <div
            className={styles.meter}
            role="meter"
            aria-label={t("storage.platform.meter")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round(part * 100))}
            data-over={part >= 1 ? "" : undefined}
          >
            <span style={{ width: `${Math.min(100, part * 100)}%` }} />
          </div>
        )}
        {rows.length > 0 && (
          <>
            <h3 className={styles.listTitle}>
              {t(byCount ? "storage.platform.full.oldest" : "storage.platform.full.largest")}
            </h3>
            {!byCount && (
              <p className={styles.note} data-release-note="">
                {t("storage.platform.full.releaseNote")}
              </p>
            )}
            <ul className={styles.rows}>
              {rows.map((row) => {
                const why = row.why && releaseBlockText(row.why, t);
                const busy = releasing !== undefined;
                const live = row.state === "live";
                const changed = changedAt?.get(row.id);
                return (
                  <li key={row.id} className={styles.row} data-platform-project={row.id}>
                    <span className={styles.what}>
                      <span className={styles.rowName} title={row.name}>
                        {row.name}
                      </span>
                      <span className={styles.size}>{formatPlatformBytes(row.bytes)}</span>
                      {!byCount && why && (
                        <span className={styles.why} data-release-why={row.why?.code}>
                          {why.text}
                        </span>
                      )}
                      {byCount && (
                        <span className={styles.why}>
                          {[
                            changed === undefined
                              ? undefined
                              : t("storage.platform.full.changed", {
                                  when: agoText(changed, now, baseT),
                                }),
                            live ? undefined : t("storage.platform.released"),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </span>
                    <span className={styles.actions}>
                      {!byCount && (
                        <button
                          type="button"
                          className={row.releasable ? styles.primary : undefined}
                          disabled={busy || row.releasable !== true}
                          onClick={() => void release(row)}
                        >
                          {releasing === row.id
                            ? t("storage.platform.releasing")
                            : t("storage.platform.release")}
                        </button>
                      )}
                      {!byCount && why?.fix === "open" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => answer({ kind: "open", project: row.id, name: row.name })}
                        >
                          {t("storage.platform.fix")}
                        </button>
                      )}
                      {live && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            answer({ kind: "saveToFolder", project: row.id, name: row.name })
                          }
                        >
                          {t("storage.platform.saveToFolder")}
                        </button>
                      )}
                      {(byCount || row.releasable !== true) && (
                        <button
                          type="button"
                          className={byCount ? styles.danger : styles.quiet}
                          disabled={busy}
                          onClick={() =>
                            answer({ kind: "delete", project: row.id, name: row.name })
                          }
                        >
                          {t("storage.platform.delete")}
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <div className={host.buttons}>
          <button
            ref={close}
            type="button"
            disabled={releasing !== undefined}
            onClick={() => answer(undefined)}
          >
            {t("storage.platform.full.close")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
