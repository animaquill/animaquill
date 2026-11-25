import { createInstance, type i18n, type TFunction } from "i18next";
import zhCN from "./zh-CN.json";

declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof zhCN };
  }
}

/** Chinese comes first. Other languages are added as resources here. */
export async function createI18n(): Promise<i18n> {
  const instance = createInstance({
    lng: "zh-CN",
    fallbackLng: "zh-CN",
    resources: { "zh-CN": { translation: zhCN } },
    interpolation: { escapeValue: false },
  });
  await instance.init();
  return instance;
}

/** Where a project's repository is, for its words: see `placedT`. */
export type RepositoryWords = "github" | "local";

/**
 * Texts of repositories said of one of the server's own (`<key>_local` next to `<key>` in the
 * resources): `t` with the context "local" where the repository is one, and `t` as it is where it
 * is on GitHub or not known. i18next takes the text of the context where there is one, and the
 * key's own where there is none, so a text that is the same either way needs nothing.
 */
export const placedT = (t: TFunction, place: RepositoryWords | undefined): TFunction =>
  place === "local"
    ? (((key: string, options?: Record<string, unknown>) =>
        t(key as never, { ...options, context: "local" } as never)) as unknown as TFunction)
    : t;

/** Every `<key>_local` of the resources, as the text of `<key>`. */
const localTexts = (resource: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resource)) {
    if (typeof value === "object" && value !== null) {
      const inner = localTexts(value as Record<string, unknown>);
      if (Object.keys(inner).length > 0) out[key] = inner;
    } else if (key.endsWith("_local")) out[key.slice(0, -"_local".length)] = value;
  }
  return out;
};

/**
 * A platform whose projects are all saved to repositories of the server's own (an open-source
 * server without GitHub): every text of repositories says so from now on, wherever it is said,
 * also where nothing tells which repository it is about. Once, for the life of the page.
 */
export function sayLocalRepositories(instance: i18n): void {
  const language = instance.language;
  const resource = instance.getResourceBundle(language, "translation") as
    Record<string, unknown> | undefined;
  if (!resource || (instance as { localWords?: true }).localWords) return;
  (instance as { localWords?: true }).localWords = true;
  instance.addResourceBundle(language, "translation", localTexts(resource), true, true);
  // Whatever shows a text already shows it again.
  void instance.changeLanguage(language);
}
