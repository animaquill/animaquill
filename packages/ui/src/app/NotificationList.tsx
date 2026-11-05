import { X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "./context.ts";
import styles from "./NotificationList.module.css";

export function NotificationList() {
  const { notifications } = useWorkbench();
  const { t } = useTranslation();
  const items = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);

  return (
    <div className={styles.list} role="status">
      {items.map((item) => (
        <div key={item.id} className={styles.item}>
          <span>{item.message}</span>
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
  );
}
