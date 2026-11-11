import { PEAKS_PER_SECOND } from "@animaquill/audio";
import { parseTime, toSeconds, type Asset } from "@animaquill/schema";
import {
  AudioWaveform,
  CodeXml,
  File,
  FileAudio,
  FileVideo,
  Image as ImageIcon,
  Type,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import type { FilmStrip } from "../media/library.ts";
import { NO_PROXIES, type ProxySnapshot, type ProxyState } from "../proxy/proxies.ts";
import type { ResourceIconProps } from "./ResourceBrowser.tsx";
import type { ProjectItem } from "./project-resources.ts";
import styles from "./ProjectIcon.module.css";

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How long a picture of a strip shows while it plays: about as fast as the video goes. */
const FRAME_MS = 250;

/** How long a file plays, as people read it. */
export function lengthOf(asset: Asset): string | undefined {
  const duration = asset.info?.duration;
  if (duration === undefined) return undefined;
  const seconds = Math.round(toSeconds(parseTime(duration)));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The frames of a video: the one from about a quarter in, which says more than a first frame that
 * is often black, and all of them one after the other under the pointer. They come from its strip,
 * so nothing gets decoded for this: video is only decoded in the sandbox of the compositor.
 */
function Frames({ strip, playing }: { strip: FilmStrip; playing: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const frameWidth = strip.image.width / strip.count;
    const draw = (slot: number) =>
      context.drawImage(
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
    const still = Math.floor(strip.count / 4);
    draw(still);
    if (!playing || reducedMotion()) return;
    const at = { slot: still };
    const timer = setInterval(() => {
      at.slot = (at.slot + 1) % strip.count;
      draw(at.slot);
    }, FRAME_MS);
    return () => {
      clearInterval(timer);
      draw(still);
    };
  }, [strip, playing]);

  return <canvas ref={canvas} className={styles.image} width={192} height={108} aria-hidden />;
}

/** The waveform of a sound, and where it would be under the pointer, going along as it plays. */
function Waveform({
  peaks,
  seconds,
  playing,
}: {
  peaks: Uint8Array;
  seconds: number;
  playing: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const style = getComputedStyle(element);
    const wave = style.getPropertyValue("--wave").trim() || "#8ab4f8";
    const line = style.getPropertyValue("--line").trim() || "#fff";
    const { width, height } = element;
    const draw = (at: number | undefined) => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = wave;
      const per = peaks.length / width;
      for (let x = 0; x < width; x += 1) {
        let top = 0;
        const end = Math.min(peaks.length, Math.ceil((x + 1) * per));
        for (let index = Math.floor(x * per); index < end; index += 1) {
          top = Math.max(top, peaks[index] ?? 0);
        }
        const bar = Math.max(1, (top / 255) * (height - 8));
        context.fillRect(x, (height - bar) / 2, 1, bar);
      }
      if (at !== undefined) {
        context.fillStyle = line;
        context.fillRect(Math.round(at * width), 0, 1, height);
      }
    };
    draw(undefined);
    if (!playing || reducedMotion() || seconds <= 0) return;
    const began = performance.now();
    const loop = { frame: 0 };
    const step = (now: number) => {
      draw((((now - began) / 1000) % seconds) / seconds);
      loop.frame = requestAnimationFrame(step);
    };
    loop.frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(loop.frame);
      draw(undefined);
    };
  }, [peaks, seconds, playing]);

  return <canvas ref={canvas} className={styles.wave} width={192} height={108} aria-hidden />;
}

const noProxies = () => NO_PROXIES;
const noSubscription = () => () => {};

/** What a proxy is doing, in a word or two on its video and in a sentence over it. */
function ProxyBadge({ state, snapshot }: { state: ProxyState; snapshot: ProxySnapshot }) {
  const { t } = useTranslation();
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
  return (
    <span className={styles.proxy} data-state={state.kind} title={about}>
      {badge}
    </span>
  );
}

function AssetPicture({ id, asset, playing }: { id: string; asset: Asset; playing: boolean }) {
  const { media } = useWorkbench();
  const [url, setUrl] = useState<string>();
  const strip = useSyncExternalStore(media.subscribe, () => media.stripOf(id));
  const peaks = useSyncExternalStore(media.subscribe, () =>
    asset.kind === "audio" ? media.peaksOfAsset(id) : undefined,
  );

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

  if (strip) return <Frames strip={strip} playing={playing} />;
  if (url) return <img className={styles.image} src={url} alt="" draggable={false} />;
  if (peaks) {
    const duration = asset.info?.duration;
    const seconds =
      duration === undefined ? peaks.length / PEAKS_PER_SECOND : toSeconds(parseTime(duration));
    return <Waveform peaks={peaks} seconds={seconds} playing={playing} />;
  }
  const Icon =
    asset.kind === "video"
      ? FileVideo
      : asset.kind === "audio"
        ? FileAudio
        : asset.kind === "image"
          ? ImageIcon
          : asset.kind === "font"
            ? Type
            : File;
  return <Icon size={28} aria-hidden />;
}

/**
 * The picture of a resource of the project, with how long it plays, how its proxy is and whether
 * its file is missing, or not here but somewhere it can be downloaded from. Under the pointer a
 * video goes through its frames and a sound shows where it would be.
 */
export function ProjectIcon({ resource, playing }: ResourceIconProps<ProjectItem>) {
  const { t } = useTranslation();
  const workbench = useWorkbench();
  const { media, proxies, missingFiles } = workbench;
  const item = resource.data;
  // A thumbnail gave up on a file that was not there, and starts over when one came back.
  const restored = useSyncExternalStore(media.subscribe, media.getRestored);
  const missing = useSyncExternalStore(missingFiles.subscribe, missingFiles.getSnapshot);
  const proxySnapshot = useSyncExternalStore(
    proxies?.subscribe ?? noSubscription,
    proxies?.getSnapshot ?? noProxies,
  );
  if (item.kind === "scene") return <CodeXml size={28} aria-hidden />;
  if (item.kind === "sound") return <AudioWaveform size={28} aria-hidden />;
  const { asset, id } = item;
  const proxy = asset.hash === undefined ? undefined : proxySnapshot.states.get(asset.hash);
  const length = lengthOf(asset);
  const file = missing.get(id);
  return (
    <>
      <AssetPicture key={restored} id={id} asset={asset} playing={playing} />
      {proxy && proxy.kind !== "checking" && proxy.kind !== "none" && (
        <ProxyBadge state={proxy} snapshot={proxySnapshot} />
      )}
      {file &&
        (file.elsewhere ? (
          <span className={styles.elsewhere}>{t("assetPanel.elsewhere")}</span>
        ) : (
          <span className={styles.missing}>{t("assetPanel.missing")}</span>
        ))}
      {length && <span className={styles.length}>{length}</span>}
    </>
  );
}
