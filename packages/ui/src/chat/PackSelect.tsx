import { closenessFor } from "@animaquill/tools";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { packLabel } from "./packText.ts";

/** The value of "automatic" in the list: no choice, so the pack chosen by the rules for the model. */
const RECOMMENDED = "";

/**
 * Which model pack a model uses, as a native list to choose from, in the settings: first "自动：" with
 * the pack the rules choose, then the packs made for the model, then the other ones there are. Each
 * is "名字(来源)" (`packLabel`); hidden ones only show when the settings show them, or for the model
 * that has one. Choosing goes through `onChoose`, nothing for automatic.
 */
export function PackSelect(props: {
  readonly model: string;
  readonly onChoose: (pack: string | undefined) => void;
  readonly testId?: string;
}) {
  const { chat, ai, packs } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const { model } = props;
  const options = chat.packOptions(model);
  const fits = options.packs.filter(({ pack }) => closenessFor(pack, model) !== undefined);
  const others = options.packs.filter((each) => !fits.includes(each));
  const auto = packLabel(t, options.recommended, snapshot, true);
  return (
    <select
      aria-label={t("ai.packs.choose", { model })}
      data-testid={props.testId}
      value={options.chosen ? options.current.id : RECOMMENDED}
      onChange={(event) =>
        props.onChoose(event.target.value === RECOMMENDED ? undefined : event.target.value)
      }
    >
      <option value={RECOMMENDED}>{auto}</option>
      {fits.length > 0 && (
        <optgroup label={t("ai.packs.choice.fits", { model })}>
          {fits.map(({ pack }) => (
            <option key={pack.id} value={pack.id}>
              {packLabel(t, pack, snapshot)}
            </option>
          ))}
        </optgroup>
      )}
      {others.length > 0 && (
        <optgroup label={fits.length > 0 ? t("ai.packs.choice.others") : t("ai.packs.choice.all")}>
          {others.map(({ pack }) => (
            <option key={pack.id} value={pack.id}>
              {packLabel(t, pack, snapshot)}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
