import type { ModelPack } from "@animaquill/tools";
import { Plus } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./AiSettings.module.css";
import packStyles from "./ModelPacks.module.css";
import { usePackInstall, type PackInstall } from "./PackInstall.tsx";
import { PackLabel } from "./PackLabel.tsx";
import { PackPage } from "./PackViews.tsx";
import type { InstalledPack } from "./packs.ts";

/** Where a pack to install comes from. */
type InstallFrom = "github" | "folder" | "file";

/**
 * The group of model packs in the settings, as pi-web's Plugins (docs/design/settings-and-
 * properties.md of AnimaQuill Cloud, 8.2), the same as the page of AI models beside it: the packs
 * on the left, those installed above AnimaQuill's own, "＋ 安装" at the bottom; on the right the
 * pack picked (`PackPage`), or the ways to install one. Only the packs: which model uses which is
 * chosen in the bubble of models. Updates are looked for as the page opens (see
 * `ModelPacks.lookForUpdates`). Where the settings are narrow, one at a time: the list, then what
 * was picked.
 */
export function ModelPacksSettings() {
  const { packs, settingsNav } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const place = useSyncExternalStore(settingsNav.subscribe, settingsNav.getSnapshot);
  const install = usePackInstall({
    onInstalled: (id) => settingsNav.go({ group: "packs", depth: 2, pack: id }),
  });

  // As the page opens: what GitHub has newer, each pack at most every few hours.
  useEffect(() => {
    void packs.lookForUpdates();
  }, [packs]);

  const builtins = snapshot.packs.filter((pack) => pack.builtin);
  const ids = [...snapshot.installed.map(({ id }) => id), ...builtins.map(({ id }) => id)];
  const adding = place.adding !== undefined;
  // Found by searching, the switch of the packs to compare with: on the first of them.
  const searched =
    place.item === "packs.hidden" ? builtins.find((pack) => pack.hidden)?.id : undefined;
  const picked = adding
    ? undefined
    : (searched ?? (place.pack !== undefined && ids.includes(place.pack) ? place.pack : ids[0]));
  const depth = place.depth === 0 ? 1 : place.depth;
  const gone = place.depth >= 2 && !adding && place.pack !== undefined && !ids.includes(place.pack);

  // A pack gone while it was open, removed here or elsewhere: back to the list.
  useEffect(() => {
    if (gone) settingsNav.go({ group: "packs", depth: 1 });
  }, [gone, settingsNav]);

  const open = (pack: string) => {
    install.clearFailure();
    settingsNav.go({ group: "packs", depth: 2, pack });
  };

  return (
    <div className={styles.page} data-depth={depth} data-testid="model-packs">
      {/* `data-setting`: what searching the settings goes to, see settings/registry.ts. */}
      <nav className={styles.tree} aria-label={t("ai.packs.title")} data-setting="packs.installed">
        <div className={styles.treeList} data-testid="pack-list">
          {snapshot.installed.map((installed) => (
            <InstalledRow
              key={installed.id}
              installed={installed}
              current={picked === installed.id}
              onOpen={() => open(installed.id)}
            />
          ))}
          {snapshot.installed.length > 0 && builtins.length > 0 && (
            <hr className={styles.treeLine} />
          )}
          {builtins.map((pack) => (
            <button
              key={pack.id}
              type="button"
              className={styles.treeRow}
              aria-current={picked === pack.id}
              data-testid="pack-builtin"
              data-pack={pack.id}
              onClick={() => open(pack.id)}
            >
              <Row pack={pack} version={pack.version} />
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.treeAdd}
          aria-current={adding}
          data-testid="pack-add"
          onClick={() => {
            install.clearFailure();
            settingsNav.go({ group: "packs", depth: 2, adding: true });
          }}
        >
          <Plus size={14} aria-hidden /> {t("ai.packs.install")}
        </button>
      </nav>
      <div className={styles.detail}>
        <div className={styles.detailInner}>
          {adding ? (
            <InstallPane install={install} />
          ) : (
            picked !== undefined && <PackPage key={picked} pack={picked} install={install} />
          )}
        </div>
      </div>
      {install.element}
    </div>
  );
}

/** A pack in the list: "名字(来源)", a dot where there is news of it, its version on the right. */
function Row(props: {
  readonly pack: Pick<ModelPack, "id" | "name" | "builtin">;
  readonly version?: string | undefined;
  readonly dot?: { readonly state: "update" | "rate"; readonly title: string } | undefined;
}) {
  return (
    <>
      <span className={packStyles.listName}>
        <PackLabel pack={props.pack} testId="pack-item-label" />
      </span>
      {props.dot && (
        <span
          className={packStyles.listDot}
          data-state={props.dot.state}
          data-testid={props.dot.state === "update" ? "pack-update" : "pack-rate"}
          role="img"
          aria-label={props.dot.title}
          title={props.dot.title}
        />
      )}
      {props.version !== undefined && (
        <span className={packStyles.listVersion} data-testid="pack-item-version">
          {props.version}
        </span>
      )}
    </>
  );
}

/** One pack installed, with a dot where GitHub has a newer version, or would not say. */
function InstalledRow(props: {
  readonly installed: InstalledPack;
  readonly current: boolean;
  readonly onOpen: () => void;
}) {
  const { packs } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const { installed } = props;
  const update = packs.updateOf(installed.id);
  const latest = snapshot.updates.get(installed.id)?.latest;
  const rate = latest?.state === "failed" && latest.failure === "rate";
  const dot = update
    ? {
        state: "update" as const,
        title: update.version
          ? t("ai.packs.updateTo", { version: update.version })
          : t("ai.packs.updateCommit", { commit: update.commit.slice(0, 7) }),
      }
    : rate
      ? { state: "rate" as const, title: t("ai.packs.github.rateLater") }
      : undefined;
  return (
    <button
      type="button"
      className={styles.treeRow}
      aria-current={props.current}
      data-testid="pack-item"
      data-pack={installed.id}
      onClick={props.onOpen}
    >
      <Row
        pack={installed.pack ?? { id: installed.id, name: installed.id, builtin: false }}
        version={installed.pack?.version}
        dot={dot}
      />
    </button>
  );
}

/**
 * Installing a pack, as pi-web's "Add plugin": where it comes from (GitHub, a folder, a pack.json),
 * then its address or the picker. What is read then shows in the install dialog, with what it
 * changes and its README; nothing is kept before people say so.
 */
function InstallPane({ install }: { readonly install: PackInstall }) {
  const { t } = useTranslation();
  const [from, setFrom] = useState<InstallFrom>("github");
  const [address, setAddress] = useState("");
  const reading = install.busy !== undefined;
  return (
    <div className={packStyles.installPane} data-testid="pack-install">
      <div className={packStyles.installHead}>
        <h2>{t("ai.packs.install")}</h2>
      </div>
      <div className={packStyles.segments} role="radiogroup" aria-label={t("ai.packs.from")}>
        {(["github", "folder", "file"] as const).map((each) => (
          <button
            key={each}
            type="button"
            role="radio"
            aria-checked={from === each}
            data-testid={`pack-install-${each}`}
            onClick={() => {
              install.clearFailure();
              setFrom(each);
            }}
          >
            {t(`ai.packs.fromWay.${each}`)}
          </button>
        ))}
      </div>
      {from === "github" ? (
        <form
          className={styles.column}
          onSubmit={(event) => {
            event.preventDefault();
            if (address.trim() !== "" && !reading) void install.fromGitHub(address.trim());
          }}
        >
          <label className={styles.field}>
            <span>{t("ai.packs.address")}</span>
            <input
              type="url"
              className={`${styles.input} ${styles.mono}`}
              value={address}
              spellCheck={false}
              placeholder={t("ai.packs.githubPlaceholder")}
              onChange={(event) => {
                setAddress(event.target.value);
                install.clearFailure();
              }}
            />
          </label>
          <button
            type="submit"
            className={`${styles.button} ${styles.primary} ${packStyles.installGo}`}
            disabled={address.trim() === "" || reading}
            data-testid="pack-github-read"
          >
            {reading ? t("ai.packs.fetching") : t("ai.packs.installGo")}
          </button>
        </form>
      ) : (
        <button
          type="button"
          className={`${styles.button} ${styles.primary} ${packStyles.installGo}`}
          data-testid="pack-pick"
          onClick={() => (from === "folder" ? install.pickFolder() : install.pickFile())}
        >
          {from === "folder" ? t("ai.packs.pickFolder") : t("ai.packs.pickFile")}
        </button>
      )}
      {install.failure && (
        <p className={styles.warning} role="alert" data-testid="pack-install-failure">
          {install.failure}
        </p>
      )}
    </div>
  );
}
