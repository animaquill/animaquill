import { Component, type ErrorInfo, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import type { i18n } from "i18next";
import { ErrorPrompt } from "../diagnostics/ErrorPrompt.tsx";
import promptStyles from "../diagnostics/ErrorPrompt.module.css";
import { DockArea } from "../dock/DockArea.tsx";
import { PlaybackClock } from "../timeline/PlaybackClock.tsx";
import type { Workbench } from "../workbench/workbench.ts";
import { ActivityBar } from "./ActivityBar.tsx";
import { CommandPaletteView } from "./CommandPaletteView.tsx";
import { DialogHost } from "./DialogHost.tsx";
import styles from "./App.module.css";
import { WorkbenchContext, useSession } from "./context.ts";
import { NotificationList } from "./NotificationList.tsx";
import { StartPage } from "./StartPage.tsx";
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

  override componentDidCatch(error: unknown, { componentStack }: ErrorInfo) {
    this.props.workbench.errors.capture("app", error, {
      ...(componentStack && { componentStack }),
    });
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    const { workbench } = this.props;
    const { t, layout, session } = workbench;
    return (
      <>
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
            {/* The project opens again after a reload, so if it is the cause this is the way out. */}
            {session.store && (
              <button
                type="button"
                onClick={() => void session.close().finally(() => location.reload())}
              >
                {t("app.closeAndReload")}
              </button>
            )}
          </div>
        </div>
        <div className={promptStyles.corner}>
          <ErrorPrompt workbench={workbench} />
        </div>
      </>
    );
  }
}

function Content() {
  const { store } = useSession();
  if (!store) return <StartPage />;
  return (
    <div className={styles.body}>
      <PlaybackClock />
      <ActivityBar />
      <main className={styles.dock}>
        <DockArea />
      </main>
    </div>
  );
}

export function App({ workbench, i18n }: AppProps) {
  return (
    <AppBoundary workbench={workbench}>
      <I18nextProvider i18n={i18n}>
        <WorkbenchContext value={workbench}>
          <div className={styles.shell}>
            <TitleBar />
            <Content />
            <StatusBar />
            <NotificationList />
            <CommandPaletteView />
            <DialogHost />
          </div>
        </WorkbenchContext>
      </I18nextProvider>
    </AppBoundary>
  );
}
