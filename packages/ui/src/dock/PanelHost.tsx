import type { IDockviewPanelProps } from "dockview-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./PanelHost.module.css";
import type { PanelParams } from "./toDockview.ts";

interface BoundaryProps {
  readonly message: string;
  readonly retry: string;
  readonly onError: (error: unknown, info: ErrorInfo) => void;
  readonly children: ReactNode;
}

/** Keeps a failure inside its own tab. */
class PanelBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    this.props.onError(error, info);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={styles.message} role="alert">
        <p>{this.props.message}</p>
        <button type="button" onClick={() => this.setState({ failed: false })}>
          {this.props.retry}
        </button>
      </div>
    );
  }
}

export function PanelHost({ params }: IDockviewPanelProps<PanelParams>) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const definition = workbench.panels.get(params.type);

  if (!definition) {
    return (
      <div className={styles.message}>
        <p>{t("panel.unknown.hint")}</p>
      </div>
    );
  }

  const Content = definition.component;
  return (
    // Focusable, so that clicking anywhere in a panel makes it the panel that keys go to.
    <div className={styles.content} data-panel={definition.type} tabIndex={-1}>
      <PanelBoundary
        message={t("panel.crashed")}
        retry={t("panel.retry")}
        onError={(error, { componentStack }) =>
          workbench.errors.capture("panel", error, {
            panel: definition.type,
            ...(componentStack && { componentStack }),
          })
        }
      >
        <Content />
      </PanelBoundary>
    </div>
  );
}
