import { Lock } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { unusableLine } from "../cloud/unusable.ts";
import { useWorkbench } from "./context.ts";
import styles from "./ReadOnlyBar.module.css";

const noSubscription = () => () => {};
const nothing = () => undefined;

/**
 * Above a project that cannot be edited now, see `Workbench.readOnly` and the design of the start
 * page of AnimaQuill Cloud, 5.1: why, and how long the platform keeps it, with the way to what
 * helps, which the panel of the platform has. Nothing where the project can be edited.
 */
export function ReadOnlyBar() {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const isReadOnly = useSyncExternalStore(
    workbench.readOnly.subscribe,
    workbench.readOnly.getSnapshot,
  );
  const { cloud } = workbench;
  // What it says follows the platform, which says more as it goes, such as how long it keeps it.
  useSyncExternalStore(cloud?.subscribe ?? noSubscription, cloud?.getSnapshot ?? nothing);
  const unusable = cloud?.unusable;
  // How many days are left moves on with the time, now and then.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Or what this computer has is of the copy before the one the platform made again, until it is
  // taken back onto that one, see `CloudProjects.takeBack`: how that goes is no part of the
  // snapshot, and is read by itself, so that the bar follows it.
  const takeBack = useSyncExternalStore(cloud?.subscribe ?? noSubscription, () =>
    cloud?.rebuilt === true ? (cloud.takeBack ?? "running") : undefined,
  );
  if (!isReadOnly || (!unusable && !takeBack)) return null;
  return (
    <div className={styles.bar} role="alert" data-read-only="">
      <Lock size={14} aria-hidden="true" />
      <span className={styles.text}>
        {unusable
          ? t("cloud.unusable.bar", {
              what: unusableLine(unusable, now, t),
              interpolation: { escapeValue: false },
            })
          : t(takeBack === "stopped" ? "cloud.takeBack.cancelled" : "cloud.takeBack.waiting")}
      </span>
      <button type="button" onClick={() => workbench.cloudPanel.set(true)}>
        {t("cloud.unusable.showWays")}
      </button>
    </div>
  );
}
