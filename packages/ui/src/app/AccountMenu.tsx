import type { AccountAccess } from "@animaquill/host";
import { LogIn } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "./context.ts";
import { Menu } from "./Menu.tsx";
import styles from "./AccountMenu.module.css";

/**
 * The account where the editor is hosted, at the end of the title bar: "登录" when nobody is signed
 * in, the account's picture and name when someone is, with what there is to do about it. Nothing
 * while the host does not know yet. Signing in is never needed for working on projects.
 */
export function AccountMenu({ account }: { readonly account: AccountAccess }) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot);

  if (snapshot.status === "unknown") return null;
  if (snapshot.status === "signedOut") {
    return (
      <button
        type="button"
        className={styles.signIn}
        title={t("account.signInHint")}
        onClick={() => void workbench.signIn()}
      >
        <LogIn size={14} />
        <span>{t("account.signIn")}</span>
      </button>
    );
  }
  const words = { name: snapshot.name, interpolation: { escapeValue: false } };
  return (
    <Menu
      label={t("account.menu", words)}
      triggerClassName={styles.trigger}
      trigger={
        <>
          <Picture address={snapshot.picture} name={snapshot.name} />
          <span className={styles.name}>{snapshot.name}</span>
        </>
      }
      align="end"
      groups={() => [
        [
          { id: "account.name", label: t("account.name", words), run: () => {}, disabled: true },
          snapshot.appInstalled
            ? { id: "account.app", label: t("account.appInstalled"), run: () => {}, disabled: true }
            : {
                id: "account.app",
                label: t("account.installApp"),
                run: () => void workbench.installApp(),
              },
        ],
        [
          {
            id: "account.signOut",
            label: t("account.signOut"),
            run: () => void workbench.signOut(),
          },
        ],
      ]}
    />
  );
}

/** The picture of the account, or its first letter where there is none or it does not load. */
function Picture({
  address,
  name,
}: {
  readonly address: string | undefined;
  readonly name: string;
}) {
  const [failed, setFailed] = useState<string | undefined>();
  if (!address || failed === address) {
    return (
      <span className={styles.initial} aria-hidden="true">
        {[...name][0]?.toUpperCase() ?? "?"}
      </span>
    );
  }
  return (
    <img
      className={styles.picture}
      src={address}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(address)}
    />
  );
}
