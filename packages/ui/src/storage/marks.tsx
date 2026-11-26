import { placedAssets } from "@animaquill/core";
import { CircleAlert, Clock, Cloud } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { MenuItem } from "../app/Menu.tsx";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { formatSize } from "../transfer/transfer.ts";
import { percentOf } from "./upload-text.ts";
import type { UploadItem, UploadProblem } from "./uploads.ts";
import styles from "./marks.module.css";

/** What the picture of an asset says of where its file is, see `UploadMark`. */
export type AssetMark =
  | { readonly kind: "lfs" }
  | { readonly kind: "uploading"; readonly percent: number }
  /** Waits for people to say they know what the storage means, in this window. */
  | { readonly kind: "waiting" }
  | { readonly kind: "failed"; readonly problem: UploadProblem };

/**
 * Of the assets of the open project, those whose picture says where their file is (4.3): in the
 * large file storage, on its way there, or failed. Only here, which most are, says nothing.
 */
export function useAssetMarks(): ReadonlyMap<string, AssetMark> {
  const workbench = useWorkbench();
  const { uploads, downloads, newAssets } = workbench;
  const waiting = useSyncExternalStore(newAssets.subscribe, newAssets.getSnapshot);
  const { store } = useSession();
  const state = useProject(store);
  const { items } = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot);
  const coming = useSyncExternalStore(downloads.subscribe, downloads.getSnapshot).items;
  const here = workbench.here();
  return useMemo(() => {
    const marks = new Map<string, AssetMark>();
    if (!state) return marks;
    for (const [id, asset] of Object.entries(placedAssets(state, here) ?? {}))
      if (asset.storage === "lfs") marks.set(id, { kind: "lfs" });
      else if (waiting.has(id)) marks.set(id, { kind: "waiting" });
    for (const item of items as readonly UploadItem[]) {
      if (item.hash !== state.assets?.[item.asset]?.hash) continue;
      if (item.phase === "failed")
        marks.set(item.asset, { kind: "failed", problem: item.problem ?? "refused" });
      else if (item.phase !== "done")
        marks.set(item.asset, { kind: "uploading", percent: percentOf(item) });
    }
    // On its way here, which this computer lacks: the corner of the picture says so in words
    // (`ProjectIcon`), and the mark gives way.
    for (const item of coming)
      if (item.phase !== "done" && item.hash === state.assets?.[item.asset]?.hash)
        marks.delete(item.asset);
    return marks;
  }, [state, items, coming, here, waiting]);
}

/** A small sign in the corner of the picture of an asset, with its words on hover. */
export function UploadMark({ mark }: { mark: AssetMark | undefined }) {
  const { t } = useTranslation();
  const limits = useWorkbench().uploadLimitWords();
  if (!mark) return null;
  const title =
    mark.kind === "lfs"
      ? t("storage.uploads.badge.lfs")
      : mark.kind === "waiting"
        ? t("storage.uploads.badge.waiting")
        : mark.kind === "uploading"
          ? t("storage.uploads.badge.uploading", { percent: mark.percent })
          : t("storage.uploads.badge.failed", {
              reason: t(`storage.uploads.problem.${mark.problem}`, limits),
            });
  return (
    <span
      className={`${styles.mark} ${styles[mark.kind]}`}
      title={title}
      role="img"
      aria-label={title}
      data-upload-mark={mark.kind}
    >
      {mark.kind === "lfs" ? (
        <Cloud size={10} aria-hidden />
      ) : mark.kind === "waiting" ? (
        <Clock size={10} aria-hidden />
      ) : mark.kind === "failed" ? (
        <CircleAlert size={11} aria-hidden />
      ) : (
        <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
          <circle cx="8" cy="8" r="6" className={styles.track} />
          <circle
            cx="8"
            cy="8"
            r="6"
            className={styles.ring}
            strokeDasharray={`${(mark.percent / 100) * 37.7} 37.7`}
            transform="rotate(-90 8 8)"
          />
        </svg>
      )}
    </span>
  );
}

/**
 * "放在…" of the menu of assets (4.3, screen U1 left): only here, the large file storage with how
 * many and how large, the places that are not there yet, and the dialog.
 */
export function usePlaceMenu(): (assets: readonly string[]) => MenuItem | undefined {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  const state = useProject(store);
  const { uploads, cloud } = workbench;
  const snapshot = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot);
  return (assets) => {
    if (!state || !cloud || assets.length === 0) return undefined;
    const placed = placedAssets(state, workbench.here()) ?? {};
    const going = new Set(
      snapshot.items.filter((item) => item.phase !== "done").map((item) => item.asset),
    );
    const files = assets.flatMap((id) => {
      const asset = placed[id];
      return asset?.hash !== undefined && asset.size !== undefined ? [{ id, asset }] : [];
    });
    if (files.length === 0) return undefined;
    const allHere = files.every(({ asset }) => asset.storage === "local");
    const can = files.filter(
      ({ id, asset }) =>
        asset.storage === "local" && !going.has(id) && (asset.size ?? 0) <= uploads.fileMost,
    );
    const bytes = can.reduce((all, { asset }) => all + (asset.size ?? 0), 0);
    const isCloud = cloud?.getSnapshot().kind === "linked";
    const usable = isCloud && uploads.available && snapshot.blocked === undefined;
    const soon = t("storage.uploads.comingSoon");
    return {
      id: "placeIn",
      label: t("storage.uploads.menu.placeIn"),
      run: () => {},
      items: [
        [
          {
            id: "place.here",
            label: t("storage.uploads.menu.here"),
            selected: allHere,
            run: () => {},
          },
          {
            id: "place.lfs",
            label: t("storage.uploads.menu.lfs"),
            note: usable
              ? t("storage.uploads.menu.count", { count: can.length, size: formatSize(bytes) })
              : t(`storage.uploads.blocked.${snapshot.blocked ?? "notCloud"}`),
            disabled: !usable || can.length === 0,
            run: () => void workbench.putInLfs(can.map(({ id }) => id)),
          },
          {
            id: "place.platform",
            label: t("storage.uploads.cloudSpace"),
            note: soon,
            disabled: true,
            run: () => {},
          },
          {
            id: "place.remote",
            label: t("storage.uploads.ownStorage"),
            note: soon,
            disabled: true,
            run: () => {},
          },
        ],
        [
          {
            id: "place.choose",
            label: t("storage.uploads.menu.choose"),
            disabled: !usable,
            run: () => void workbench.choosePlaces(can.map(({ id }) => id)),
          },
        ],
      ],
    };
  };
}
