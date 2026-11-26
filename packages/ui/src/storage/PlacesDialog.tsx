import { FileAudio, FileImage, FileType, FileVideo } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import host from "../app/DialogHost.module.css";
import type { CloudProjectsSnapshot } from "../cloud/projects.ts";
import { formatSize } from "../transfer/transfer.ts";
import type { DialogRequest } from "../workbench/dialogs.ts";
import {
  canChoose,
  foldRows,
  placeRows,
  quickChoice,
  sortRows,
  totalOf,
  type PlaceOrder,
  type PlaceRow,
  type QuickChoice,
} from "./place-choice.ts";
import { GITHUB_BILLING } from "./links.ts";
import styles from "./Places.module.css";

type PlacesRequest = Extract<DialogRequest, { kind: "places" }>;

const QUICK: readonly QuickChoice[] = ["all", "used", "large", "videos"];

const noSubscription = () => () => {};
const NONE: CloudProjectsSnapshot = { kind: "none" };
const none = () => NONE;
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((each) => b.has(each));

function KindIcon({ kind }: { kind: string }) {
  if (kind === "video") return <FileVideo size={16} aria-hidden />;
  if (kind === "audio") return <FileAudio size={16} aria-hidden />;
  if (kind === "image") return <FileImage size={16} aria-hidden />;
  return <FileType size={16} aria-hidden />;
}

/**
 * "素材放在哪" (docs/design/asset-storage.md of AnimaQuill Cloud, 4.3, screen U2): which assets of
 * the open project go into the large file storage of its repository. What can be chosen, the quick
 * choices, what it comes to and what it costs, and once for the account
 * what people have to know first. Nothing goes until they press the button.
 */
export function PlacesDialog({ request }: { request: PlacesRequest }) {
  const workbench = useWorkbench();
  const { dialogs, uploads, lfsAccount, missingFiles, cloud } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const state = useProject(store);
  const items = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot).items;
  const missing = useSyncExternalStore(missingFiles.subscribe, missingFiles.getSnapshot);
  const account = useSyncExternalStore(lfsAccount.subscribe, lfsAccount.getSnapshot);
  const linked = useSyncExternalStore(
    cloud?.subscribe ?? noSubscription,
    cloud?.getSnapshot ?? none,
  );
  const repository = linked.kind === "linked" ? linked.repository : undefined;
  const status = useSyncExternalStore(
    repository?.subscribe ?? noSubscription,
    repository?.getSnapshot ?? (() => undefined),
  )?.status;
  const dialog = useRef<HTMLDialogElement>(null);

  const rows = useMemo(
    () =>
      state
        ? placeRows(
            state,
            items,
            new Set(missing.keys()),
            workbench.here(),
            workbench.uploads.fileMost,
          )
        : [],
    [state, items, missing, workbench],
  );
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() =>
    request.chosen
      ? new Set(
          request.chosen.filter((asset) =>
            rows.some((row) => row.asset === asset && canChoose(row)),
          ),
        )
      : quickChoice(rows, "used"),
  );
  const [order, setOrder] = useState<PlaceOrder>("size");
  const [unfolded, setUnfolded] = useState(false);
  const [knows, setKnows] = useState(false);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const sorted = sortRows(rows, order);
  const { shown, folded } = unfolded ? { shown: sorted, folded: [] } : foldRows(sorted);
  const { count, bytes } = totalOf(rows, chosen);
  // Nothing of GitHub's to say yes to, or to pay, for a repository of the server's own.
  const local = workbench.localRepository();
  const asks = !local && account.account?.acknowledgedAt === undefined && account.status !== "none";
  const repo = status?.repository?.fullName;

  const toggle = (row: PlaceRow) => {
    if (!canChoose(row)) return;
    const next = new Set(chosen);
    if (next.has(row.asset)) next.delete(row.asset);
    else next.add(row.asset);
    setChosen(next);
  };
  const dismiss = () => {
    if (!working) dialogs.answer(false);
  };
  const start = async () => {
    if (count === 0 || (asks && !knows)) return;
    setWorking(true);
    setFailed(false);
    try {
      if (asks && !(await lfsAccount.acknowledge())) {
        setFailed(true);
        return;
      }
      await uploads.add([...chosen]);
      dialogs.answer(true);
    } catch (error) {
      console.warn("Uploads could not be started", error);
      setFailed(true);
    } finally {
      setWorking(false);
    }
  };
  const whereText = (row: PlaceRow) => {
    switch (row.where) {
      case "there":
        return t("storage.uploads.dialog.there");
      case "on":
        return t("storage.uploads.dialog.on");
      case "tooLarge":
        return t("storage.uploads.dialog.tooLarge", {
          most: formatSize(workbench.uploads.fileMost),
        });
      case "noFile":
        return t("storage.uploads.dialog.noFile");
      default:
        return t("storage.uploads.dialog.hereOnly");
    }
  };
  const foldedBytes = folded.reduce((all, row) => all + row.size, 0);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label={request.title}
      data-places-dialog=""
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <form
        className={host.content}
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <h2>{request.title}</h2>
        <p>{t("storage.uploads.dialog.about")}</p>
        <div className={styles.toolbar}>
          <span
            className={styles.quick}
            role="group"
            aria-label={t("storage.uploads.dialog.quick")}
          >
            {t("storage.uploads.dialog.quick")}
            {QUICK.map((quick) => {
              const set = quickChoice(rows, quick);
              const on = set.size > 0 && sameSet(set, chosen);
              return (
                <button
                  key={quick}
                  type="button"
                  aria-pressed={on}
                  className={on ? styles.on : undefined}
                  onClick={() => setChosen(set)}
                >
                  {t(`storage.uploads.dialog.${quick}`)}
                </button>
              );
            })}
          </span>
          <label className={styles.order}>
            {t("storage.uploads.dialog.sort")}
            <select value={order} onChange={(event) => setOrder(event.target.value as PlaceOrder)}>
              <option value="size">{t("storage.uploads.dialog.bySize")}</option>
              <option value="name">{t("storage.uploads.dialog.byName")}</option>
            </select>
          </label>
        </div>
        <div className={styles.tableBox}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th aria-label={t("storage.uploads.dialog.asset")} />
                <th>{t("storage.uploads.dialog.asset")}</th>
                <th>{t("storage.uploads.dialog.size")}</th>
                <th>{t("storage.uploads.dialog.uses")}</th>
                <th>{t("storage.uploads.dialog.where")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr
                  key={row.asset}
                  data-place-row={row.asset}
                  data-where={row.where}
                  className={canChoose(row) ? undefined : styles.off}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("input")) return;
                    toggle(row);
                  }}
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label={row.name}
                      checked={chosen.has(row.asset) && canChoose(row)}
                      disabled={!canChoose(row)}
                      onChange={() => toggle(row)}
                    />
                  </td>
                  <td className={styles.name}>
                    <KindIcon kind={row.kind} />
                    <span>{row.name}</span>
                  </td>
                  <td>{formatSize(row.size)}</td>
                  <td className={row.uses === 0 ? styles.unused : undefined}>
                    {row.uses === 0
                      ? t("storage.uploads.dialog.notUsed")
                      : t("storage.uploads.dialog.usesCount", { count: row.uses })}
                  </td>
                  <td>{whereText(row)}</td>
                </tr>
              ))}
              {folded.length > 0 && (
                <tr>
                  <td colSpan={5}>
                    <button type="button" className={styles.more} onClick={() => setUnfolded(true)}>
                      {t("storage.uploads.dialog.more", {
                        count: folded.length,
                        size: formatSize(foldedBytes),
                      })}
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className={styles.summary} role="status">
          <p className={styles.total}>
            <span>{t("storage.uploads.dialog.total", { count, size: formatSize(bytes) })}</span>
            {repo && !local && (
              <span className={styles.repo}>
                {t("storage.uploads.dialog.repository", { repo })}
              </span>
            )}
          </p>
          {/* GitHub's room and what it costs: nothing of a repository of the server's own. */}
          {!local && (
            <p>
              {t("storage.uploads.dialog.cost")}{" "}
              <a href={GITHUB_BILLING} target="_blank" rel="noopener noreferrer">
                {t("storage.uploads.dialog.seeQuota")} ↗
              </a>
            </p>
          )}
          <details>
            <summary>{t("storage.uploads.dialog.kinds")}</summary>
            {(["here", "lfs", "platform", "remote"] as const).map((kind) => (
              <p key={kind}>{t(`storage.uploads.dialog.kind.${kind}`)}</p>
            ))}
          </details>
        </div>
        {asks && (
          <label className={styles.acknowledge}>
            <input
              type="checkbox"
              checked={knows}
              onChange={(event) => setKnows(event.target.checked)}
            />
            {t("storage.uploads.dialog.acknowledge")}
          </label>
        )}
        {failed && (
          <p className={styles.problem} role="alert">
            {t("storage.uploads.dialog.failed")}
          </p>
        )}
        <div className={styles.footer}>
          <span>{t("storage.uploads.dialog.footer")}</span>
          <div className={host.buttons}>
            <button type="button" onClick={dismiss} disabled={working}>
              {t("storage.uploads.dialog.cancel")}
            </button>
            <button
              type="submit"
              className={host.primary}
              disabled={working || count === 0 || (asks && !knows)}
            >
              {count > 0
                ? t("storage.uploads.dialog.start", { count, size: formatSize(bytes) })
                : t("storage.uploads.dialog.startNone")}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
