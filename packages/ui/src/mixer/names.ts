import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { Row } from "../timeline/model.ts";

/** What a track is called: its name, or its kind and number, as "音频 2". */
export const nameOfTrack = (t: TFunction, { track, number, gone }: Row): string =>
  gone ? t("timeline.goneTrack") : (track.name ?? t(`timeline.track.${track.kind}`, { number }));

/** `nameOfTrack` for a component. */
export function useTrackName(): (row: Row) => string {
  const { t } = useTranslation();
  return (row) => nameOfTrack(t, row);
}
