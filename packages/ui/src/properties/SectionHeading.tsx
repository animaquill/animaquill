import { ChevronRight, Diamond } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./PropertiesPanel.module.css";

/** The groups of what the tab shows now, and the kind of clip they are remembered for. */
interface Scope {
  readonly kind: string;
  readonly ids: readonly string[];
}

const ScopeContext = createContext<Scope>({ kind: "", ids: [] });

/** Where the groups of one clip, a track or the master are: what Alt and a click fold up together. */
export function SectionsScope({ kind, ids, children }: Scope & { readonly children: ReactNode }) {
  // The same object for as long as the groups are the same, so that nothing below draws again.
  const key = ids.join("\n");
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the ids are what the key says
  const value = useMemo(() => ({ kind, ids }), [kind, key]);
  return <ScopeContext value={value}>{children}</ScopeContext>;
}

/** Whether a group is folded up now, for this kind of clip. Never for one without an id. */
export function useFolded(id: string | undefined): boolean {
  const { propertySections } = useWorkbench();
  const { kind } = useContext(ScopeContext);
  return useSyncExternalStore(propertySections.subscribe, () =>
    id === undefined ? false : propertySections.isCollapsed(kind, id),
  );
}

/** Whether each of several groups is folded up now, for a list of them such as the effects. */
export function useFoldedOf(): (id: string) => boolean {
  const { propertySections } = useWorkbench();
  const { kind } = useContext(ScopeContext);
  const folded = useSyncExternalStore(propertySections.subscribe, () =>
    propertySections.collapsedFor(kind),
  );
  return (id) => folded.includes(id);
}

/** Opens groups of what the tab shows now, for this kind of clip: what something just put there. */
export function useUnfold(): (ids: readonly string[]) => void {
  const { propertySections } = useWorkbench();
  const { kind } = useContext(ScopeContext);
  return useCallback((ids) => propertySections.set(kind, ids, false), [propertySections, kind]);
}

const noSubscription = () => () => {};
const never = () => false;

/**
 * The title of a group that folds up: a click folds it up or opens it, with Alt every group of the
 * clip, as in After Effects. Folded up, a small diamond says that there are keys in it. Whatever
 * else the title has, such as the switch of an effect, comes after it and is its own control.
 */
export function SectionHeading({
  ref,
  id,
  title,
  folded,
  controls,
  keyed,
  subscribe,
  className,
  children,
}: {
  readonly ref?: Ref<HTMLButtonElement>;
  readonly id: string;
  readonly title: string;
  readonly folded: boolean;
  /** The id of what folds up. */
  readonly controls: string;
  /** Whether there are keys in it, asked while it is folded up. */
  readonly keyed?: (() => boolean) | undefined;
  readonly subscribe?: (listener: () => void) => () => void;
  readonly className?: string | undefined;
  /** What else the title has, after the name. */
  readonly children?: ReactNode;
}) {
  const { propertySections } = useWorkbench();
  const { t } = useTranslation();
  const { kind, ids } = useContext(ScopeContext);
  // Only a folded group follows the keys, which is the only time it shows them.
  const hasKeys = useSyncExternalStore(
    folded && keyed && subscribe ? subscribe : noSubscription,
    folded && keyed ? keyed : never,
  );
  const toggle = (all: boolean) => propertySections.set(kind, all ? ids : [id], !folded);
  return (
    <div className={`${styles.sectionHeading} ${className ?? ""}`}>
      <button
        ref={ref}
        type="button"
        className={styles.sectionToggle}
        aria-expanded={!folded}
        aria-controls={controls}
        onClick={(event: MouseEvent) => toggle(event.altKey)}
        onKeyDown={(event) => {
          // Alt with Enter, as Alt with a click: the keyboard's way to every group at once.
          if (event.key === "Enter" && event.altKey) {
            event.preventDefault();
            toggle(true);
          }
        }}
      >
        <ChevronRight size={12} className={styles.sectionChevron} aria-hidden />
        <span className={styles.sectionTitle}>{title}</span>
        {folded && hasKeys && (
          <Diamond
            size={9}
            className={`${styles.keyed} ${styles.sectionKeyed}`}
            fill="currentColor"
            role="img"
            aria-label={t("property.section.hasKeys")}
          />
        )}
      </button>
      {children}
    </div>
  );
}
