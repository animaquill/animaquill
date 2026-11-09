import type { Asset } from "@animaquill/schema";
import { parseTime, toSeconds } from "@animaquill/schema";
import {
  AudioWaveform,
  CodeXml,
  FileAudio,
  FileVideo,
  Image as ImageIcon,
  Plus,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu, type MenuItem } from "../app/Menu.tsx";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import type { FilmStrip } from "../media/library.ts";
import styles from "./AssetsPanel.module.css";
import { NO_PROGRESS } from "../folder/assets.ts";
import { NO_PROXIES, type ProxySnapshot, type ProxyState } from "../proxy/proxies.ts";

/** What a drag from this list carries. */
export const ASSET_DRAG_TYPE = "application/x-animaquill-asset";
export const SCENE_DRAG_TYPE = "application/x-animaquill-scene";
export const SOUND_DRAG_TYPE = "application/x-animaquill-sound";

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

const noProxies = () => NO_PROXIES;

/** What a proxy is doing, in a word or two on its video and in a sentence over it. */
function useProxyWords() {
  const { t } = useTranslation();
  return (state: ProxyState, snapshot: ProxySnapshot) => {
    const paused = snapshot.paused && state.kind === "making";
    const percent = state.kind === "making" ? state.percent : 0;
    const badge = paused ? t("proxy.badge.paused") : t(`proxy.badge.${state.kind}`, { percent });
    const about =
      state.kind === "failed"
        ? t(`proxy.state.failed.${state.reason}`)
        : paused
          ? t("proxy.state.paused", { percent })
          : state.kind === "waiting" && snapshot.elsewhere
            ? t("proxy.state.elsewhere")
            : t(`proxy.state.${state.kind}`, { percent });
    return { badge, about };
  };
}

/** How the proxy of a video is, on its picture. Nothing for one that needs none. */
function ProxyBadge({ state, snapshot }: { state: ProxyState; snapshot: ProxySnapshot }) {
  const words = useProxyWords()(state, snapshot);
  return (
    <span className={styles.proxy} data-state={state.kind} title={words.about}>
      {words.badge}
    </span>
  );
}

interface PopupState {
  readonly x: number;
  readonly y: number;
  readonly groups: readonly (readonly MenuItem[])[];
}

const noSubscription = () => () => {};
const noProgress = () => NO_PROGRESS;

export function AssetsPanel() {
  const workbench = useWorkbench();
  const { media, timeline, notifications } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const project = useProject(store);
  const importing = useSyncExternalStore(media.subscribe, media.getImporting);
  const copying = useSyncExternalStore(media.subscribe, media.getCopying);
  const folders = workbench.projectFolders;
  const inFolder = useSyncExternalStore(
    folders?.subscribe ?? noSubscription,
    () => folders?.getSnapshot().open !== undefined,
  );
  const progress = useSyncExternalStore(
    folders?.subscribeProgress ?? noSubscription,
    folders?.getProgress ?? noProgress,
  );
  const [reading] = progress.reading;
  // A thumbnail gave up on a file that was not there, and starts over when one came back.
  const restored = useSyncExternalStore(media.subscribe, media.getRestored);
  const { proxies } = workbench;
  const proxySnapshot = useSyncExternalStore(
    proxies?.subscribe ?? noSubscription,
    proxies?.getSnapshot ?? noProxies,
  );
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

  const removeScene = (id: string) => {
    const result = store?.execute({ type: "scene.remove", params: { scene: id } });
    if (result && !result.ok) {
      notifications.push(t("notice.commandFailed", { message: result.error.message }));
    }
  };

  const removeSound = (id: string) => {
    const result = store?.execute({ type: "sound.remove", params: { sound: id } });
    if (result && !result.ok) {
      notifications.push(t("notice.commandFailed", { message: result.error.message }));
    }
  };

  const scenes = Object.entries(project?.scenes ?? {});
  const sounds = Object.entries(project?.sounds ?? {});

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
        void workbench.importDropped(event.dataTransfer);
      }}
    >
      <div className={styles.toolbar}>
        <button type="button" onClick={() => void workbench.pickFiles()}>
          <Upload size={14} />
          {t("assets.import")}
        </button>
        <button type="button" onClick={() => timeline.createScene()}>
          <Plus size={14} />
          {t("assets.newScene")}
        </button>
        <button type="button" onClick={() => timeline.createSound()}>
          <Plus size={14} />
          {t("assets.newSound")}
        </button>
        {importing > 0 && !copying && (
          <span role="status">{t("assets.importing", { count: importing })}</span>
        )}
        {reading && (
          <span
            role="status"
            title={progress.reading.map(({ path, percent }) => `${path} ${percent}%`).join("\n")}
          >
            {progress.checked && t("folder.checking.progress", progress.checked)}{" "}
            {t("folder.checking.reading", {
              path: reading.path,
              percent: reading.percent,
              interpolation: { escapeValue: false },
            })}
          </span>
        )}
        {copying && (
          <span role="status">
            {t(`folder.copy.${copying.stage}`, { name: copying.name, percent: copying.percent })}
            <button type="button" onClick={copying.stop}>
              {t("folder.copy.stop")}
            </button>
          </span>
        )}
      </div>
      {assets.length === 0 && scenes.length === 0 && sounds.length === 0 ? (
        <p className={styles.empty}>{t(inFolder ? "assets.emptyFolder" : "assets.empty")}</p>
      ) : (
        <ul className={styles.list} aria-label={t("panel.assets.title")}>
          {scenes.map(([id, scene]) => (
            <li
              key={`scene ${id}`}
              className={styles.item}
              title={scene.description ?? scene.name}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(SCENE_DRAG_TYPE, id);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onDoubleClick={() => timeline.addScene(id)}
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
                        run: () => timeline.addScene(id),
                      },
                      {
                        id: "remove",
                        label: t("assets.removeScene"),
                        run: () => removeScene(id),
                      },
                    ],
                  ],
                });
              }}
            >
              <div className={styles.thumbnail}>
                <CodeXml size={28} />
              </div>
              <span className={styles.name}>{scene.name}</span>
            </li>
          ))}
          {sounds.map(([id, sound]) => (
            <li
              key={`sound ${id}`}
              className={styles.item}
              title={sound.description ?? sound.name}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(SOUND_DRAG_TYPE, id);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onDoubleClick={() => timeline.addSound(id)}
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
                        run: () => timeline.addSound(id),
                      },
                      {
                        id: "remove",
                        label: t("assets.removeSound"),
                        run: () => removeSound(id),
                      },
                    ],
                  ],
                });
              }}
            >
              <div className={styles.thumbnail}>
                <AudioWaveform size={28} />
              </div>
              <span className={styles.name}>{sound.name}</span>
            </li>
          ))}
          {assets.map(([id, asset]) => {
            const { hash } = asset;
            const proxy = hash === undefined ? undefined : proxySnapshot.states.get(hash);
            // What people can do about the proxy of a video that needs one. It gets made where
            // this window writes the folder, so another window that does has the say.
            const canMake = !proxySnapshot.elsewhere;
            const proxyItems: MenuItem[] =
              proxies && hash !== undefined && proxy
                ? proxy.kind === "none" || proxy.kind === "stopped" || proxy.kind === "failed"
                  ? canMake
                    ? [{ id: "proxy", label: t("proxy.make"), run: () => proxies.make(hash) }]
                    : []
                  : proxy.kind === "ready" || proxy.kind === "checking"
                    ? []
                    : [{ id: "proxy", label: t("proxy.stop"), run: () => proxies.stop(hash) }]
                : [];
            return (
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
                      ...(proxyItems.length > 0 ? [proxyItems] : []),
                    ],
                  });
                }}
              >
                <div className={styles.thumbnail}>
                  <Thumbnail key={restored} id={id} asset={asset} />
                  {proxy && proxy.kind !== "checking" && proxy.kind !== "none" && (
                    <ProxyBadge state={proxy} snapshot={proxySnapshot} />
                  )}
                  {lengthOf(asset) && <span className={styles.length}>{lengthOf(asset)}</span>}
                </div>
                <span className={styles.name}>{asset.name}</span>
              </li>
            );
          })}
        </ul>
      )}
      {popup && (
        <PopupMenu {...popup} label={t("panel.assets.title")} onClose={() => setPopup(undefined)} />
      )}
    </div>
  );
}
