import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CloudPanel, PanelAction, PanelActionId } from "../cloud/panel.ts";
import styles from "./CloudPanel.module.css";
import { httpsLink } from "./links.ts";

function ActionButton({
  action,
  run,
}: {
  readonly action: PanelAction;
  readonly run: (id: PanelActionId) => void;
}) {
  return (
    <button
      type="button"
      {...(action.kind && { className: styles[action.kind] })}
      disabled={!action.enabled}
      data-cloud-action={action.id}
      onClick={() => run(action.id)}
    >
      {action.label}
    </button>
  );
}

/**
 * What the panel of the platform shows, see `cloudPanel` and the design of the start page, 4: a
 * row each for the repository, syncing, archiving, and where the project is on this computer
 * where it has no folder, each with what helps right next to it; and below them what else people
 * can do. Everything it says comes from `cloudPanel`: this only lays it out.
 */
export function CloudPanelBody({
  panel,
  run,
}: {
  readonly panel: CloudPanel;
  readonly run: (id: PanelActionId) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <dl className={styles.rows}>
        {panel.rows.map((row) => {
          // The address is the platform's word: only an https one becomes a link.
          const address = httpsLink(row.link?.url);
          return (
            <div key={row.id} className={styles.row} data-cloud-row={row.id} data-tone={row.tone}>
              <dt>{row.label}</dt>
              <dd>
                <p className={styles.text} role="status">
                  {row.text}
                  {row.link && address && (
                    <a
                      className={styles.link}
                      href={address}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={11} />
                      {row.link.label}
                    </a>
                  )}
                </p>
                {row.notes.map((note) => (
                  <p key={note} className={styles.note}>
                    {note}
                  </p>
                ))}
                {row.actions.length > 0 && (
                  <div className={styles.buttons}>
                    {row.actions.map((action) => (
                      <ActionButton key={action.id} action={action} run={run} />
                    ))}
                  </div>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {panel.actions.length > 0 && (
        <div className={styles.footer} role="group" aria-label={t("cloud.panel.more")}>
          {panel.actions.map((action) => (
            <ActionButton key={action.id} action={action} run={run} />
          ))}
        </div>
      )}
    </>
  );
}
