import type { Asset } from "@animaquill/schema";
import { parseTime, toSeconds } from "@animaquill/schema";
import { FileAudio, FileVideo, Image as ImageIcon, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu, type MenuItem } from "../app/Menu.tsx";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import type { FilmStrip } from "../media/library.ts";
import styles from "./AssetsPanel.module.css";

/** What a drag from this list carries. */
export const ASSET_DRAG_TYPE = "application/x-animaquill-asset";

const ICONS = { video: FileVideo, audio: FileAudio } as const;

function lengthOf(asset: Asset): string | undefined {
  const duration = asset.info?.duration;
  if (duration === undefined) return undefined;
  const seconds = Math.round(toSeconds(parseTime(duration)));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The frame from about a quarter in, which says more than a first frame that is often black. */
function Poster({ strip }: { strip: FilmStrip }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    const frameWidth = strip.image.width / strip.count;
    const slot = Math.floor(strip.count / 4);
    element
      ?.getContext("2d")
      ?.drawImage(
        strip.image,
        slot * frameWidth,
        0,
        frameWidth,
        strip.image.height,
        0,
        0,
        element.width,
        element.height,
      );
  }, [strip]);

  return <canvas ref={canvas} className={styles.image} width={192} height={108} />;
}

function Thumbnail({ id, asset }: { id: string; asset: Asset }) {
  const { media } = useWorkbench();
  const [url, setUrl] = useState<string>();
  const strip = useSyncExternalStore(media.subscribe, () => media.stripOf(id));

  useEffect(() => {
    let current = true;
    if (asset.kind === "image") {
      void media.urlOf(id).then((value) => {
        if (current) setUrl(value);
      });
    }
    return () => {
      current = false;
    };
  }, [asset.kind, id, media]);

  if (strip) return <Poster strip={strip} />;
  if (url) return <img className={styles.image} src={url} alt="" draggable={false} />;
  const Icon = asset.kind === "audio" || asset.kind === "video" ? ICONS[asset.kind] : ImageIcon;
  return <Icon size={28} />;
}

interface PopupState {
  readonly x: number;
  readonly y: number;
  readonly groups: readonly (readonly MenuItem[])[];
}

export function AssetsPanel() {
  const workbench = useWorkbench();
  const { media, timeline, notifications } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const project = useProject(store);
  const importing = useSyncExternalStore(media.subscribe, media.getImporting);
  const [popup, setPopup] = useState<PopupState>();
  const [over, setOver] = useState(false);
  const assets = Object.entries(project?.assets ?? {}).filter(
    ([, asset]) => asset.kind === "video" || asset.kind === "audio" || asset.kind === "image",
  );

  const remove = (id: string) => {
    const result = store?.execute({ type: "asset.remove", params: { asset: id } });
    if (result && !result.ok) {
      notifications.push(t("notice.commandFailed", { message: result.error.message }));
    }
  };

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

  return (
    <div
      className={over ? styles.dropping : styles.panel}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setOver(false);
        void media.importFiles([...event.dataTransfer.files]);
      }}
    >
      <div className={styles.toolbar}>
        <button type="button" onClick={() => void media.pickFiles()}>
          <Upload size={14} />
          {t("assets.import")}
        </button>
        {importing > 0 && <span role="status">{t("assets.importing", { count: importing })}</span>}
      </div>
      {assets.length === 0 ? (
        <p className={styles.empty}>{t("assets.empty")}</p>
      ) : (
        <ul className={styles.list} aria-label={t("panel.assets.title")}>
          {assets.map(([id, asset]) => (
            <li
              key={id}
              className={styles.item}
              title={asset.name}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(ASSET_DRAG_TYPE, id);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onDoubleClick={() => timeline.addAsset(id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setPopup({
                  x: event.clientX,
                  y: event.clientY,
                  groups: [
                    [
                      {
                        id: "add",
                        label: t("assets.addToTimeline"),
                        run: () => timeline.addAsset(id),
                      },
                      { id: "remove", label: t("assets.remove"), run: () => remove(id) },
                    ],
                  ],
                });
              }}
            >
              <div className={styles.thumbnail}>
                <Thumbnail id={id} asset={asset} />
                {lengthOf(asset) && <span className={styles.length}>{lengthOf(asset)}</span>}
              </div>
              <span className={styles.name}>{asset.name}</span>
            </li>
          ))}
        </ul>
      )}
      {popup && (
        <PopupMenu {...popup} label={t("panel.assets.title")} onClose={() => setPopup(undefined)} />
      )}
    </div>
  );
}
