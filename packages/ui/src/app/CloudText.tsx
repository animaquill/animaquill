import { Cloud } from "lucide-react";

const MARK = "☁ ";

/** The words alone, for where they are read out or shown in a tip. */
export const withoutCloud = (text: string): string =>
  text.startsWith(MARK) ? text.slice(MARK.length) : text;

/**
 * Words about the platform, which begin with a cloud where the project is on it ("☁ 已同步"): the
 * cloud shows as an icon, like the others of the editor, as not every font has the character and
 * those that do draw it in their own ways. Whatever holds it lines the two up.
 */
export function CloudText({ text }: { readonly text: string }) {
  if (!text.startsWith(MARK)) return <>{text}</>;
  return (
    <>
      <Cloud size={12} aria-hidden="true" data-cloud-icon="" />
      {text.slice(MARK.length)}
    </>
  );
}
