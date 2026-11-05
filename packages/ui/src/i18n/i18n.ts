import { createInstance, type i18n } from "i18next";
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
