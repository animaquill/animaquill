import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "./context.ts";

/**
 * Something of the online mode, offline (docs/design/online-offline.md of AnimaQuill Cloud, 1.3):
 * it is where it always is, grey, says on hovering that it needs signing in, and a click asks to
 * sign in, see `Workbench.askToGoOnline`. Nothing else says so anywhere.
 */
export function OnlineOnly({
  className,
  children,
  label,
  what,
}: {
  readonly className?: string | undefined;
  readonly children: ReactNode;
  /** What it is, in a few words, for the question that it needs signing in. */
  readonly what: string;
  /** What it is, for whatever reads the page, where the children do not say it. */
  readonly label?: string;
}) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={className}
      aria-disabled="true"
      data-needs-online=""
      title={t("online.needed.hint")}
      {...(label !== undefined && { "aria-label": label })}
      onClick={() => void workbench.askToGoOnline(what)}
    >
      {children}
    </button>
  );
}
