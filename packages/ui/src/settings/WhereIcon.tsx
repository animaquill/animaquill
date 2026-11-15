import { useTranslation } from "react-i18next";
import styles from "./Settings.module.css";

/**
 * Where something is kept, as a small picture left of its name (草图 X1 of AnimaQuill Cloud): a
 * computer for this device, a cloud for the account. What it says is in its title, for the mouse
 * and for screen readers.
 */
export function WhereIcon(props: {
  readonly where: "device" | "account";
  readonly className?: string | undefined;
}) {
  const { t } = useTranslation();
  const said = t(`settings.where.${props.where}`);
  return (
    <span
      className={`${styles.where} ${props.className ?? ""}`}
      title={said}
      role="img"
      aria-label={said}
      data-where={props.where}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {props.where === "device" ? (
          <>
            <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.2" />
            <path d="M5.5 13.75h5M8 11v2.75" />
          </>
        ) : (
          <path d="M4.6 12.75h6.9a3 3 0 0 0 .35-5.98A4.1 4.1 0 0 0 4.1 7.3a2.75 2.75 0 0 0 .5 5.45z" />
        )}
      </svg>
    </span>
  );
}
