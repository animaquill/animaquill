import { ExternalLink } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type {
  CloudPanel,
  PanelAction,
  PanelActionId,
  PanelRow,
  PanelSection,
} from "../cloud/panel.ts";
import styles from "./CloudPanel.module.css";
import { PlaceIcon, type Place } from "./PlaceIcon.tsx";
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
  focus,
  place,
}: {
  readonly panel: CloudPanel;
  readonly run: (id: PanelActionId) => void;
  /** Where the project is, for the sign in front of its part "本地", see `PlaceIcon`. */
  readonly place?: Place;
  /** The part that the status people clicked is about: it is where people look first. */
  readonly focus?: PanelSection;
}) {
  const { t } = useTranslation();
  const parts = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    const part = parts.current?.querySelector<HTMLElement>(`[data-cloud-section="${focus}"]`);
    part?.scrollIntoView({ block: "nearest" });
  }, [focus]);
  const sections = [...new Set(panel.rows.map((row) => row.section))];
  return (
    <>
      <div ref={parts} className={styles.sections}>
        {sections.map((section) => (
          <section
            key={section}
            className={styles.section}
            data-cloud-section={section}
            data-focused={focus === section || undefined}
            aria-label={t(`cloud.panel.section.${section}`)}
            tabIndex={-1}
          >
            <h3 className={styles.sectionTitle}>
              {section === "local" && place && (
                <PlaceIcon place={place} size={13} label={t(`saveStatus.place.${place}`)} />
              )}
              {t(`cloud.panel.section.${section}`)}
            </h3>
            <Rows rows={panel.rows.filter((row) => row.section === section)} run={run} />
          </section>
        ))}
      </div>
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

/** The rows of a part of the panel, each with what helps right next to it. */
function Rows({
  rows,
  run,
}: {
  readonly rows: readonly PanelRow[];
  readonly run: (id: PanelActionId) => void;
}) {
  return (
    <>
      <dl className={styles.rows}>
        {rows.map((row) => {
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
    </>
  );
}
