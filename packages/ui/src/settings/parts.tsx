import { useId, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { useAccount } from "../cloud/CloudParts.tsx";
import type { SettingId, SettingWhere } from "./registry.ts";
import { settingItem } from "./registry.ts";
import { WhereIcon } from "./WhereIcon.tsx";
import { visibleGroups, type SettingsGroup } from "../workbench/settings-nav.ts";
import styles from "./Settings.module.css";

/**
 * Where a setting is kept, on this device or with the account, for people who are signed in:
 * before that everything is on this device, and nothing is said (4.2). Settings of AI go with the
 * account while their sync is on here.
 */
export function useWhere(where: SettingWhere | undefined): "device" | "account" | undefined {
  const { account, aiSync } = useWorkbench();
  const signedIn = useAccount(account).status === "signedIn";
  const ai = useSyncExternalStore(aiSync.subscribe, aiSync.getSnapshot);
  if (!signedIn || where === undefined) return undefined;
  if (where === "ai") return ai.status === "off" || ai.account === undefined ? "device" : "account";
  return where;
}

/** Where a whole group is kept, as `WhereIcon`, once people are signed in. */
export function GroupWhere(props: {
  readonly where: SettingWhere;
  readonly className?: string | undefined;
}) {
  const shown = useWhere(props.where);
  if (!shown) return null;
  return <WhereIcon where={shown} className={props.className} />;
}

/** A group of rows, under its title. */
export function GroupPage(props: {
  readonly title: string;
  readonly intro?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.scroll}>
      <h2 className={styles.groupTitle}>{props.title}</h2>
      {props.intro && <p className={styles.intro}>{props.intro}</p>}
      <div className={styles.rows}>{props.children}</div>
    </div>
  );
}

/** A heading between rows of a group. */
export function RowsHeading({ children }: { readonly children: ReactNode }) {
  return <h3 className={styles.rowsHeading}>{children}</h3>;
}

/**
 * One setting: its name on the left, with where it is kept left of it, and what it does under it
 * where that needs saying; how it is set on the right. The name and the words come from the texts
 * of the setting (`settings.items.<id>`), unless given: an empty `help` there says nothing.
 * Whatever names the control is the name.
 */
export function SettingRow(props: {
  readonly id: SettingId;
  readonly name?: ReactNode;
  readonly help?: ReactNode;
  readonly children?: ReactNode;
  /** What is under the words, such as how it stands now. */
  readonly below?: ReactNode;
  /** Laid out under the words rather than beside them, for what needs the width. */
  readonly wide?: boolean;
}) {
  const { t } = useTranslation();
  const label = useId();
  const item = settingItem(props.id);
  const where = useWhere(item?.where);
  const help = props.help ?? t(`settings.items.${props.id}.help`, { defaultValue: "" });
  return (
    <div
      className={styles.row}
      data-setting={props.id}
      data-wide={props.wide ? "" : undefined}
      role="group"
      aria-labelledby={label}
    >
      <div className={styles.words}>
        <span className={styles.nameLine}>
          {where && <WhereIcon where={where} />}
          <span className={styles.name} id={label}>
            {props.name ?? t(`settings.items.${props.id}.name`)}
          </span>
        </span>
        {help !== "" && <span className={styles.help}>{help}</span>}
        {props.below}
      </div>
      <div className={styles.control}>{props.children}</div>
    </div>
  );
}

export interface Option<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Not there yet: shown grey, with "在做". */
  readonly later?: boolean;
}

/** A choice of a few, side by side. */
export function Segmented<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly Option<T>[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className={styles.segmented} role="radiogroup" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === props.value}
          disabled={props.disabled === true || option.later === true}
          title={option.later ? t("settings.later") : undefined}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

/** A choice of more, as a list to drop down. */
export function Choice<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly Option<T>[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <select
      className={styles.select}
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value as T)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.later}>
          {option.later ? `${option.label}（${t("settings.later")}）` : option.label}
        </option>
      ))}
    </select>
  );
}

/** On or off. */
export function Toggle(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (on: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      className={styles.switch}
      aria-label={props.label}
      checked={props.checked}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.checked)}
    />
  );
}

export function Button(props: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={styles.button}
      data-danger={props.danger ? "" : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** The groups there are now: the account's only with a platform, cloud sync only signed in. */
export function useGroups(): readonly SettingsGroup[] {
  const { cloudSync, account } = useWorkbench();
  const { available } = useSyncExternalStore(cloudSync.subscribe, cloudSync.getSnapshot);
  const signedIn = useAccount(account).status === "signedIn";
  return visibleGroups({ account: account !== undefined, cloud: available && signedIn });
}
