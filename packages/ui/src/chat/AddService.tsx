import {
  SERVICE_GROUPS,
  SERVICE_KINDS,
  checkBaseUrl,
  recommendedOf,
  type ListedModel,
  type ServiceKind,
} from "@animaquill/agent";
import { ChevronLeft, Search } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { ServiceAvatar, TestPill } from "./aiParts.tsx";
import styles from "./AiSettings.module.css";
import type { ConnectionTest } from "./settings.ts";

const noop = () => () => {};
const nobody = () => undefined;

/**
 * Adding a service: cards of the kinds there are, in groups, to search by name or by a model they
 * have. A card picked asks only for what that kind needs (a key; an address for one's own), tests
 * it, and adds it with the models recommended for it turned on.
 */
export function AddService(props: {
  /** The kind picked, whose short form shows. */
  readonly picked: string | undefined;
  readonly onPick: (kind: string | undefined) => void;
  /** Back to the services. */
  readonly onBack: () => void;
  /** There are services to go back to: the way back shows also where the settings are wide. */
  readonly backAlways: boolean;
  readonly onAdded: (id: string) => void;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [query, setQuery] = useState("");

  // How many models each kind has, and the models to search by.
  useEffect(() => {
    for (const kind of SERVICE_KINDS) void ai.loadKnown(kind.id);
  }, [ai]);

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
  const groups = SERVICE_GROUPS.map((group) => ({
    group,
    kinds: SERVICE_KINDS.filter((kind) => kind.group === group && matches(kind)),
  })).filter(({ kinds }) => kinds.length > 0);

  return (
    <div className={styles.wall} data-testid="ai-add">
      <div className={styles.row}>
        <button
          type="button"
          className={props.backAlways ? `${styles.back} ${styles.wallBack}` : styles.back}
          onClick={props.onBack}
        >
          <ChevronLeft size={14} aria-hidden /> {t("settings.back")}
        </button>
        <h2 className={styles.group} style={{ margin: 0 }}>
          {t("ai.add.title")}
        </h2>
      </div>
      {snapshot.services.length === 0 && <p className={styles.help}>{t("ai.intro")}</p>}
      <label className={styles.row}>
        <Search size={14} aria-hidden className={styles.muted} />
        <input
          className={`${styles.input} ${styles.grow}`}
          type="search"
          aria-label={t("ai.add.search")}
          placeholder={t("ai.add.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {groups.length === 0 && <p className={styles.help}>{t("ai.add.none")}</p>}
      {groups.map(({ group, kinds }) => (
        <section key={group} className={styles.wall} aria-label={t(`ai.add.groups.${group}`)}>
          <h3 className={styles.sectionTitle}>{t(`ai.add.groups.${group}`)}</h3>
          <div className={styles.cards}>
            {kinds.map((kind) => (
              <KindCard
                key={kind.id}
                kind={kind}
                picked={props.picked === kind.id}
                onPick={() => props.onPick(props.picked === kind.id ? undefined : kind.id)}
              />
            ))}
          </div>
          {kinds.some((kind) => kind.id === props.picked) && (
            <AddForm
              key={props.picked}
              kind={kinds.find((kind) => kind.id === props.picked) as ServiceKind}
              onCancel={() => props.onPick(undefined)}
              onAdded={props.onAdded}
            />
          )}
        </section>
      ))}
      <p className={styles.help}>{t("ai.noSubscription")}</p>
    </div>
  );
}

function KindCard(props: {
  readonly kind: ServiceKind;
  readonly picked: boolean;
  readonly onPick: () => void;
}) {
  const { kind } = props;
  const { ai, account } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const signedIn =
    useSyncExternalStore(account?.subscribe ?? noop, account?.getSnapshot ?? nobody)?.status ===
    "signedIn";
  const count = snapshot.known.get(kind.id)?.length ?? 0;
  const existing = snapshot.services.filter((service) => service.kind === kind.id).length;
  const how = kind.custom
    ? kind.protocol === "openai-completions"
      ? t("ai.add.ownOpenAI")
      : t("ai.add.own")
    : kind.route === "relay"
      ? ai.canRelay
        ? signedIn
          ? t("ai.add.relay")
          : t("ai.add.relaySignIn")
        : t("ai.add.relayNone")
      : count > 0
        ? `${t("ai.add.apiKey")} · ${t("ai.add.models", { count })}`
        : t("ai.add.apiKey");
  return (
    <button
      type="button"
      className={styles.card}
      aria-pressed={props.picked}
      data-testid="ai-kind"
      data-kind={kind.id}
      onClick={props.onPick}
    >
      <ServiceAvatar kind={kind.id} name={kind.custom ? "{" : kind.name} large />
      <span className={styles.cardText}>
        <div>{kind.name}</div>
        <div className={styles.cardSub}>
          {how}
          {existing > 0 && ` · ${t("ai.add.existing", { count: existing })}`}
        </div>
      </span>
    </button>
  );
}

/** The short form of one kind: its key (and address), a test, and adding it. */
function AddForm(props: {
  readonly kind: ServiceKind;
  readonly onCancel: () => void;
  readonly onAdded: (id: string) => void;
}) {
  const { kind } = props;
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  // The key stays in the field only, never in what React renders: see `KeySection`.
  const keyField = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(false);
  const keyNow = () => keyField.current?.value.trim() ?? "";
  const [url, setUrl] = useState(kind.baseUrl);
  const [trying, setTrying] = useState(false);
  const [tried, setTried] = useState<
    | {
        readonly test: ConnectionTest;
        readonly recommended: readonly string[];
        readonly listed?: readonly ListedModel[];
      }
    | undefined
  >();
  const form = useRef<HTMLDivElement>(null);

  useEffect(() => {
    form.current?.scrollIntoView({ block: "nearest" });
  }, []);
  // What it would start with, by name, once what pi knows of the kind is here.
  const known = snapshot.known.get(kind.id) ?? [];
  const preview = kind.recommended
    ? recommendedOf(kind, known).map((id) => known.find((model) => model.id === id)?.name ?? id)
    : [];

  const existing = snapshot.services.filter((service) => service.kind === kind.id).length;
  const name = existing > 0 ? `${kind.name} ${existing + 1}` : kind.name;
  const baseUrl = kind.custom ? (checkBaseUrl(url) ?? "") : kind.baseUrl;
  const route = ai.canRelay ? kind.route : "direct";
  const missing = kind.custom
    ? baseUrl === ""
      ? t("ai.add.urlRequired")
      : undefined
    : !typed
      ? t("ai.add.keyRequired")
      : undefined;

  const add = async (result: NonNullable<typeof tried>) => {
    const id = ai.add(kind.id, name, { baseUrl, route, enabled: result.recommended });
    if (id === undefined) return;
    const key = keyNow();
    if (key) await ai.setKey(id, key);
    ai.keepTest(id, result.test, result.listed);
    props.onAdded(id);
  };

  const tryIt = async () => {
    if (missing || trying) return;
    setTrying(true);
    setTried(undefined);
    const result = await ai.tryService({ kind: kind.id, baseUrl, route }, keyNow());
    setTrying(false);
    if (result.test.state === "ok") await add(result);
    else setTried(result);
  };

  const willDefault = snapshot.default === undefined;
  return (
    <div className={styles.form} ref={form} data-testid="ai-add-form">
      <div className={styles.row}>
        <ServiceAvatar kind={kind.id} name={kind.custom ? "{" : kind.name} large />
        <strong>{t("ai.add.form", { name: kind.name })}</strong>
      </div>
      {kind.custom && (
        <label className={styles.field}>
          <span>{t("ai.baseUrl")}</span>
          <input
            className={styles.input}
            value={url}
            placeholder="https://"
            spellCheck={false}
            aria-invalid={url.trim() !== "" && baseUrl === ""}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
      )}
      {kind.custom && url.trim() !== "" && baseUrl === "" && (
        <p className={styles.warning}>{t("ai.baseUrlInvalid")}</p>
      )}
      <label className={styles.field}>
        <span>{t("ai.key")}</span>
        <input
          className={`${styles.input} ${styles.mono}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={kind.custom ? t("ai.keyOptional") : t("ai.keyPlaceholder")}
          ref={keyField}
          defaultValue=""
          onChange={(event) => setTyped(event.target.value.trim() !== "")}
          onKeyDown={(event) => event.key === "Enter" && void tryIt()}
        />
      </label>
      {kind.id === "anthropic" && <p className={styles.help}>{t("ai.noSubscriptionAnthropic")}</p>}
      {kind.id === "openai-compatible" && (
        <p className={styles.note} data-testid="ai-gpt6">
          {t("ai.add.completions")}
        </p>
      )}
      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={missing !== undefined || trying}
          title={missing}
          onClick={() => void tryIt()}
        >
          {trying ? t("ai.add.trying") : t("ai.add.try")}
        </button>
        <button type="button" className={styles.button} onClick={props.onCancel}>
          {t("ai.add.cancel")}
        </button>
        <span className={styles.muted}>{t("ai.testCost")}</span>
      </div>
      {trying && (
        <TestPill test={{ state: "running" }} relayed={route === "relay"} canRelay={ai.canRelay} />
      )}
      {!tried && !trying && (
        <p className={styles.help}>
          {preview.length > 0 && kind.recommended
            ? t(willDefault ? "ai.add.willEnableDefault" : "ai.add.willEnable", {
                models: preview.join("、"),
              })
            : t("ai.add.willList")}
        </p>
      )}
      {tried && (
        <>
          <TestPill test={tried.test} relayed={route === "relay"} canRelay={ai.canRelay} />
          <div className={styles.row}>
            <button
              type="button"
              className={styles.button}
              data-testid="ai-add-anyway"
              onClick={() => void add(tried)}
            >
              {t("ai.add.anyway")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
