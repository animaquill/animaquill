import type { ModelPack } from "@animaquill/tools";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { placeOf, readmeFromGitHub, type GitHubFailure, type PackPlace } from "./github-packs.ts";
import { Readme } from "./markdown/Readme.tsx";
import styles from "./ModelPacks.module.css";
import type { PackReadme, PackSource } from "./packs.ts";

/** The README of a pack from GitHub, at the commit installed, read when it shows. */
function useGitHubReadme(place: PackPlace | undefined, skip: boolean) {
  const [read, setRead] = useState<
    { readonly key: string; readonly value: PackReadme | undefined | GitHubFailure } | undefined
  >();
  const key = place ? `${place.owner}/${place.repo}/${place.commit}/${place.path}` : "";
  useEffect(() => {
    if (!place || skip) return;
    let live = true;
    void readmeFromGitHub(place).then((value) => {
      if (live) setRead({ key, value });
    });
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the place is the key
  }, [key, skip]);
  return read?.key === key ? read : undefined;
}

/**
 * What a pack says of itself for people: its README (`Readme`, which shows what someone else wrote
 * safely), or where it has none, the line of its pack.json and that it has none. A README longer
 * than shows says so, with the way to all of it on GitHub. The README of a pack installed from
 * GitHub is read from there, at the commit installed.
 */
export function PackIntro(props: {
  readonly pack: Pick<ModelPack, "description"> | undefined;
  readonly source: PackSource | "builtin" | undefined;
  /** What was read with the pack, as the install dialog and packs from this computer have it. */
  readonly readme: PackReadme | undefined;
}) {
  const { t } = useTranslation();
  const source = props.source === "builtin" ? undefined : props.source;
  const place = source?.kind === "github" ? placeOf(source) : undefined;
  const fetched = useGitHubReadme(place, props.readme !== undefined);
  const loading = place !== undefined && props.readme === undefined && fetched === undefined;
  const failure = typeof fetched?.value === "string" ? fetched.value : undefined;
  const readme =
    props.readme ?? (fetched && typeof fetched.value !== "string" ? fetched.value : undefined);
  const whole =
    place &&
    `https://github.com/${place.owner}/${place.repo}/blob/${place.commit}/${
      place.path ? `${place.path.split("/").map(encodeURIComponent).join("/")}/` : ""
    }README.md`;
  return (
    <div className={styles.intro} data-testid="pack-readme">
      {loading && <p className={styles.meta}>{t("ai.packs.readme.loading")}</p>}
      {failure && (
        <p className={styles.meta} data-testid="pack-readme-failed">
          {t("ai.packs.readme.failed", {
            reason: t(`ai.packs.github.${failure}`, { tag: "", version: "" }),
          })}
        </p>
      )}
      {readme && <Readme text={readme.text} place={place} />}
      {readme?.cut && (
        <p className={styles.meta} data-testid="pack-readme-cut">
          {t("ai.packs.readme.cut")}{" "}
          {whole && (
            <a href={whole} target="_blank" rel="noopener noreferrer">
              {t("ai.packs.readme.whole")}
            </a>
          )}
        </p>
      )}
      {!readme && !loading && (
        <>
          {props.pack?.description && <p>{props.pack.description}</p>}
          <p className={styles.meta} data-testid="pack-readme-none">
            {t("ai.packs.readme.none")}
          </p>
        </>
      )}
      <p className={styles.readmeNote}>{t("ai.packs.readme.note")}</p>
    </div>
  );
}
