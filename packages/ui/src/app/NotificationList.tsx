import { X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ErrorPrompt } from "../diagnostics/ErrorPrompt.tsx";
import { useWorkbench } from "./context.ts";
import styles from "./NotificationList.module.css";

export function NotificationList() {
  const workbench = useWorkbench();
  const { notifications } = workbench;
  const { t } = useTranslation();
  const items = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);

  return (
    <div className={styles.list}>
      <ErrorPrompt workbench={workbench} />
      <div className={styles.items} role="status">
        {items.map((item) => (
          <div
            key={item.id}
            className={styles.item}
            onPointerEnter={() => notifications.hold(item.id)}
            onPointerLeave={() => notifications.release(item.id)}
            onFocus={() => notifications.hold(item.id)}
            onBlur={() => notifications.release(item.id)}
          >
            <span>{item.message}</span>
            {item.actions?.map(({ label, run }) => (
              <button
                key={label}
                type="button"
                className={styles.action}
                onClick={() => {
                  notifications.dismiss(item.id);
                  run();
                }}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              aria-label={t("notice.dismiss")}
              onClick={() => notifications.dismiss(item.id)}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
