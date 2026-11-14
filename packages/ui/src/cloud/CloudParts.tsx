import {
  createContext,
  use,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { AccountAccess, AccountSnapshot } from "@animaquill/host";
import { useWorkbench } from "../app/context.ts";
import styles from "./CloudSync.module.css";

/** The id of the name of the row a switch is in, which names the switch. */
const RowName = createContext<string | undefined>(undefined);

/** One cloud feature: what it is, what it does, and its switch or button on the right. */
export function FeatureRow(props: {
  readonly id: string;
  readonly name: string;
  readonly help: ReactNode;
  readonly children?: ReactNode;
  /** The switch, or a button. */
  readonly control: ReactNode;
}) {
  const name = useId();
  return (
    <div className={styles.row} data-testid={`cloud-${props.id}`}>
      <div>
        <span className={styles.name} id={name}>
          {props.name}
        </span>
        <span className={styles.help}>{props.help}</span>
        {props.children}
      </div>
      <RowName value={name}>{props.control}</RowName>
    </div>
  );
}

export function Switch(props: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      className={styles.switch}
      aria-labelledby={use(RowName)}
      checked={props.checked}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.checked)}
    />
  );
}

const noSubscribe = () => () => {};
const unknown = (): AccountSnapshot => ({ status: "unknown" });

export function useAccount(account: AccountAccess | undefined): AccountSnapshot {
  return useSyncExternalStore(account?.subscribe ?? noSubscribe, account?.getSnapshot ?? unknown);
}

/**
 * How many repositories the App may touch, where it is on the account: "3", "30+" where there are
 * more than a page, undefined while not known or where it cannot be told.
 */
function useRepositoryCount(installed: boolean): { count: number; more: boolean } | undefined {
  const { repositories } = useWorkbench();
  const [count, setCount] = useState<{ count: number; more: boolean }>();
  useEffect(() => {
    if (!installed || !repositories) return;
    let live = true;
    repositories.list(1).then(
      (list) => {
        if (live) setCount({ count: list.repositories.length, more: list.more });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [installed, repositories]);
  return count;
}

/**
 * "关联 GitHub": not a switch, a way to install the App, which saving projects of the platform to
 * repositories needs. `before` runs first, as the welcome answers itself before the page goes.
 */
export function GitHubRow({ before }: { readonly before?: () => Promise<boolean> }) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const who = useAccount(workbench.account);
  const installed = who.status === "signedIn" && who.appInstalled;
  const repositories = useRepositoryCount(installed);
  const [busy, setBusy] = useState(false);
  if (who.status !== "signedIn") return null;
  const name = who.name;
  const install = async () => {
    setBusy(true);
    try {
      if (before && !(await before())) return;
      await workbench.installApp();
    } finally {
      setBusy(false);
    }
  };
  return (
    <FeatureRow
      id="github"
      name={t("cloudSync.github.name")}
      help={
        installed
          ? repositories?.count === 0
            ? t("cloudSync.github.noRepositories", { name })
            : repositories
              ? t(
                  repositories.more
                    ? "cloudSync.github.repositoriesMore"
                    : "cloudSync.github.repositories",
                  { name, count: repositories.count },
                )
              : t("cloudSync.github.linked", { name })
          : t("cloudSync.github.help")
      }
      control={
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() => void install()}
        >
          {t(installed ? "cloudSync.github.manage" : "cloudSync.github.install")}
        </button>
      }
    >
      {installed && <span className={styles.help}>{t("cloudSync.github.linkedHelp")}</span>}
    </FeatureRow>
  );
}
