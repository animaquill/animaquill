import { SERVICE_KINDS, recommendedOf, type ServiceKind } from "@animaquill/agent";
import { Plus, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { ServiceAvatar } from "./aiParts.tsx";
import styles from "./AiSettings.module.css";

/** What the card of a server of one's own adds: one that talks OpenAI's way until people change it. */
const OWN_KIND = "openai-compatible";

/**
 * Adding a service, as pi-web's picker of providers (docs/design/settings-and-properties.md of
 * AnimaQuill Cloud, 6.1): over the page, a search on top, a card for a server of one's own, then a
 * card for each service of the catalog, with how many models it has; those already added greyed.
 * A card picked adds the service at once, with the models recommended for it on, and opens it to
 * fill in the rest (the key, the address).
 */
export function AddServicePicker(props: {
  /** A kind asked for from elsewhere, such as the chat: added right away. */
  readonly picked: string | undefined;
  /**
   * In the page, where there is no service yet: the same, not over it, so that the settings around
   * it still search and close as ever.
   */
  readonly inline?: boolean;
  readonly onClose: () => void;
  readonly onAdded: (id: string) => void;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const adding = useRef(false);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open && !props.inline) element.showModal();
  }, [props.inline]);
  // How many models each kind has, and the models to search by.
  useEffect(() => {
    for (const kind of SERVICE_KINDS) void ai.loadKnown(kind.id);
  }, [ai]);

  const add = async (kind: ServiceKind) => {
    if (adding.current) return;
    adding.current = true;
    const existing = snapshot.services.filter((service) => service.kind === kind.id).length;
    const base = kind.custom ? t("ai.add.ownName") : kind.name;
    const name = existing > 0 ? `${base} ${existing + 1}` : base;
    const enabled = kind.custom ? [] : recommendedOf(kind, await ai.loadKnown(kind.id));
    const id = ai.add(kind.id, name, { enabled });
    adding.current = false;
    if (id === undefined) return;
    dialog.current?.close();
    props.onAdded(id);
  };

  // Asked for by its kind, as the chat does: no need to pick it again.
  const asked = props.picked;
  useEffect(() => {
    const kind = SERVICE_KINDS.find((each) => each.id === asked);
    if (kind) void add(kind);
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    dialog.current?.close();
    props.onClose();
  };

  const needle = query.trim().toLowerCase();
  const matches = (kind: ServiceKind) =>
    !needle ||
    kind.name.toLowerCase().includes(needle) ||
    kind.id.includes(needle) ||
    (snapshot.known.get(kind.id) ?? []).some(
      (model) =>
        model.id.toLowerCase().includes(needle) ||
        (model.name ?? "").toLowerCase().includes(needle),
    );
  const own = SERVICE_KINDS.find((kind) => kind.id === OWN_KIND);
  const ownShown =
    own !== undefined &&
    (!needle ||
      [t("ai.add.own"), own.name, "openai", "anthropic", "custom"].some((word) =>
        word.toLowerCase().includes(needle),
      ));
  const kinds = SERVICE_KINDS.filter((kind) => !kind.custom && matches(kind));

  const body = (
    <>
      <label className={styles.pickerSearch}>
        <Search size={14} aria-hidden />
        <input
          type="search"
          aria-label={t("ai.add.search")}
          placeholder={t("ai.add.search")}
          value={query}
          autoFocus={!props.inline}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className={styles.pickerBody}>
        {own && ownShown && (
          <section aria-label={t("ai.add.groups.own")}>
            <h3 className={styles.kicker}>{t("ai.add.groups.own")}</h3>
            <div className={styles.cards}>
              <button
                type="button"
                className={styles.card}
                data-testid="ai-kind"
                data-kind={own.id}
                onClick={() => void add(own)}
              >
                <span className={styles.cardText}>
                  <span>{t("ai.add.own")}</span>
                </span>
                <span className={styles.cardIcon}>
                  <Plus size={14} aria-hidden />
                </span>
              </button>
            </div>
          </section>
        )}
        {kinds.length > 0 && (
          <section aria-label={t("ai.add.groups.catalog")}>
            <h3 className={styles.kicker}>{t("ai.add.groups.catalog")}</h3>
            <div className={styles.cards}>
              {kinds.map((kind) => {
                const added = snapshot.services.some((service) => service.kind === kind.id);
                const count = snapshot.known.get(kind.id)?.length ?? 0;
                return (
                  <button
                    key={kind.id}
                    type="button"
                    className={styles.card}
                    data-testid="ai-kind"
                    data-kind={kind.id}
                    disabled={added}
                    onClick={() => void add(kind)}
                  >
                    <span className={styles.cardText}>
                      <span>{kind.name}</span>
                      {(added || count > 0) && (
                        <span className={styles.cardSub}>
                          {added ? t("ai.add.added") : t("ai.add.models", { count })}
                        </span>
                      )}
                    </span>
                    <ServiceAvatar kind={kind.id} name={kind.name} large />
                  </button>
                );
              })}
            </div>
          </section>
        )}
        {kinds.length === 0 && !ownShown && <p className={styles.muted}>{t("ai.add.none")}</p>}
      </div>
    </>
  );
  if (props.inline)
    return (
      <div className={styles.pickerInline} data-testid="ai-add" aria-label={t("ai.addService")}>
        {body}
      </div>
    );
  return (
    <dialog
      ref={dialog}
      className={styles.picker}
      data-testid="ai-add"
      aria-label={t("ai.addService")}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        // A click on the dim around it.
        if (event.target === dialog.current) close();
      }}
    >
      {body}
    </dialog>
  );
}
