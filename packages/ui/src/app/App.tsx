import { Component, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import type { i18n } from "i18next";
import { DockArea } from "../dock/DockArea.tsx";
import type { Workbench } from "../workbench/workbench.ts";
import { ActivityBar } from "./ActivityBar.tsx";
import styles from "./App.module.css";
import { WorkbenchContext } from "./context.ts";
import { NotificationList } from "./NotificationList.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { TitleBar } from "./TitleBar.tsx";

interface AppProps {
  readonly workbench: Workbench;
  readonly i18n: i18n;
}

/** The last line of defence: whatever fails, people get words and a way out, not a blank page. */
class AppBoundary extends Component<{ workbench: Workbench; children: ReactNode }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    const { t, layout } = this.props.workbench;
    return (
      <div className={styles.crashed} role="alert">
        <h1>{t("app.crashed")}</h1>
        <p>{t("app.crashedHint")}</p>
        <div>
          <button type="button" onClick={() => location.reload()}>
            {t("app.reload")}
          </button>
          <button
            type="button"
            onClick={() => void layout.forget().finally(() => location.reload())}
          >
            {t("app.resetAndReload")}
          </button>
        </div>
      </div>
    );
  }
}

export function App({ workbench, i18n }: AppProps) {
  return (
    <AppBoundary workbench={workbench}>
      <I18nextProvider i18n={i18n}>
        <WorkbenchContext value={workbench}>
          <div className={styles.shell}>
            <TitleBar />
            <div className={styles.body}>
              <ActivityBar />
              <main className={styles.dock}>
                <DockArea />
              </main>
            </div>
            <StatusBar />
            <NotificationList />
          </div>
        </WorkbenchContext>
      </I18nextProvider>
    </AppBoundary>
  );
}
