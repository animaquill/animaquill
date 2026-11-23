import { describe, expect, test } from "vitest";
import { describeConfig, forgetSecrets, loadConfig, SECRETS } from "../config.ts";
import { describeLibrary, GB, gbText, libraryMode, LIBRARY_VARIABLES } from "./config.ts";
import { LibraryStorage } from "./storage.ts";

/** The settings of the cloud space, from the platform's .env. */

const files = (entries: Record<string, string>) => (path: string) => entries[path];

/** As the .env of the beta has them. */
const BETA = {
  LIBRARY_S3_ENDPOINT: "http://objects.example:7070",
  LIBRARY_S3_PUBLIC_ENDPOINT: "https://objects.example.com",
  LIBRARY_S3_REGION: "us-east-1",
  LIBRARY_S3_BUCKET: "example-library",
  LIBRARY_S3_PATH_STYLE: "true",
  LIBRARY_S3_PREFIX: "library/",
  LIBRARY_S3_ACCESS_KEY_ID: "aq0123456789abcdef01234567",
  LIBRARY_S3_SECRET_ACCESS_KEY: "the-secret-of-the-storage",
  LIBRARY_S3_CHECKSUM: "sha256",
  LIBRARY_VERIFY: "always",
  LIBRARY_TOTAL_GB: "45",
  LIBRARY_MODE: "on",
};

const library = (env: Record<string, string>, read = files({})) => loadConfig(env, read).library;

describe("the settings of the cloud space", () => {
  test("are off, quietly, when none are there, as compose passes them empty", () => {
    const empty = Object.fromEntries(LIBRARY_VARIABLES.map((name) => [name, ""]));
    for (const env of [{}, empty]) {
      const config = library(env);
      expect(config.storage).toBeUndefined();
      expect(config.problems).toEqual([]);
      expect(config.mode).toBe("on");
      expect(libraryMode(config)).toBe("off");
      expect(config.minFreeBytes).toBe(50 * GB);
      expect(config.totalBytes).toBeUndefined();
      expect(LibraryStorage.of(config)).toBeUndefined();
    }
  });

  test("are those of the beta, with defaults for what is left out", () => {
    const config = library(BETA);
    expect(config.problems).toEqual([]);
    expect(config.storage).toEqual({
      endpoint: "http://objects.example:7070",
      publicEndpoint: "https://objects.example.com",
      region: "us-east-1",
      bucket: "example-library",
      pathStyle: true,
      prefix: "library/",
      accessKeyId: "aq0123456789abcdef01234567",
      secretAccessKey: "the-secret-of-the-storage",
    });
    expect(config.totalBytes).toBe(45 * GB);
    expect(libraryMode(config)).toBe("on");
    const fewer = library(
      {
        LIBRARY_S3_ENDPOINT: "https://s3.example/",
        LIBRARY_S3_BUCKET: "b-1",
        LIBRARY_S3_ACCESS_KEY_ID: "id",
        LIBRARY_S3_SECRET_ACCESS_KEY_FILE: "/run/secrets/s3",
        LIBRARY_MIN_FREE_GB: "0",
        LIBRARY_MODE: "READONLY",
      },
      files({ "/run/secrets/s3": "from-a-file\n" }),
    );
    expect(fewer.problems).toEqual([]);
    expect(fewer.storage).toMatchObject({
      endpoint: "https://s3.example",
      publicEndpoint: "https://s3.example",
      region: "us-east-1",
      pathStyle: true,
      prefix: "library/",
      secretAccessKey: "from-a-file",
    });
    expect(fewer.minFreeBytes).toBe(0);
    expect(libraryMode(fewer)).toBe("readonly");
    const storage = LibraryStorage.of(fewer)!;
    expect(storage.internal.endpoint).toBe("https://s3.example");
    expect(storage.objectKey("0196a2b4-0000-7000-8000-00000000abcd", "a".repeat(64))).toBe(
      `library/u/0196a2b4-0000-7000-8000-00000000abcd/${"a".repeat(64)}`,
    );
    expect(() => storage.objectKey("x", "a".repeat(64))).toThrow(RangeError);
  });

  test("that are wrong leave the cloud space off and say which, never their values", () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ LIBRARY_S3_ENDPOINT: "objects.example:7070" }, /LIBRARY_S3_ENDPOINT/],
      [
        { LIBRARY_S3_ENDPOINT: "http://objects.example:7070/path" },
        /LIBRARY_S3_ENDPOINT has to be only/,
      ],
      [{ LIBRARY_S3_PUBLIC_ENDPOINT: "ftp://x" }, /LIBRARY_S3_PUBLIC_ENDPOINT/],
      [{ LIBRARY_S3_BUCKET: "Not_A_Bucket" }, /LIBRARY_S3_BUCKET is not a name/],
      [
        { LIBRARY_S3_BUCKET: "with.dots", LIBRARY_S3_PATH_STYLE: "false" },
        /needs LIBRARY_S3_PATH_STYLE/,
      ],
      [{ LIBRARY_S3_PATH_STYLE: "yes" }, /LIBRARY_S3_PATH_STYLE has to be true or false/],
      [{ LIBRARY_S3_PREFIX: "library" }, /LIBRARY_S3_PREFIX/],
      [{ LIBRARY_S3_PREFIX: "../x/" }, /LIBRARY_S3_PREFIX/],
      [{ LIBRARY_S3_PREFIX: "chat-images/" }, /pictures of conversations/],
      [{ LIBRARY_S3_PREFIX: "chat-images/u/" }, /pictures of conversations/],
      [{ LIBRARY_S3_REGION: "US East" }, /LIBRARY_S3_REGION/],
      [{ LIBRARY_S3_ACCESS_KEY_ID: "a/b" }, /LIBRARY_S3_ACCESS_KEY_ID/],
      [{ LIBRARY_S3_SECRET_ACCESS_KEY: "" }, /LIBRARY_S3_SECRET_ACCESS_KEY is not set/],
      [{ LIBRARY_S3_BUCKET: "" }, /LIBRARY_S3_BUCKET is not set/],
      [{ LIBRARY_TOTAL_GB: "0" }, /LIBRARY_TOTAL_GB has to be a number of GB above 0/],
      [{ LIBRARY_TOTAL_GB: "45GB" }, /LIBRARY_TOTAL_GB/],
      [{ LIBRARY_MIN_FREE_GB: "-1" }, /LIBRARY_MIN_FREE_GB/],
      [{ LIBRARY_MODE: "maintenance" }, /LIBRARY_MODE has to be on, readonly or off/],
      [
        { LIBRARY_S3_SECRET_ACCESS_KEY_FILE: "/run/secrets/none" },
        /_FILE names a file that is not there/,
      ],
    ];
    for (const [change, problem] of cases) {
      const config = library({ ...BETA, ...change });
      expect(libraryMode(config), JSON.stringify(change)).toBe("off");
      expect(config.problems.join("\n"), JSON.stringify(change)).toMatch(problem);
      expect(config.problems.join("\n")).toMatch(/the cloud space is off/);
      for (const value of Object.values(change).filter((each) => each.length > 3))
        expect(config.problems.join("\n")).not.toContain(value);
    }
    // A choice that is wrong keeps the default, and says so.
    const checksum = library({ ...BETA, LIBRARY_S3_CHECKSUM: "md5", LIBRARY_VERIFY: "sometimes" });
    expect(checksum.checksum).toBe("sha256");
    expect(checksum.verify).toBe("always");
    expect(libraryMode(checksum)).toBe("on");
    expect(checksum.problems).toHaveLength(2);
  });

  test("say what is in force without the secret, which leaves the environment once read", () => {
    const config = loadConfig(BETA, files({}));
    const said = JSON.stringify(describeConfig(config));
    expect(said).not.toContain("the-secret-of-the-storage");
    expect(describeConfig(config).library).toEqual({
      mode: "on",
      storage: {
        endpoint: "http://objects.example:7070",
        publicEndpoint: "https://objects.example.com",
        region: "us-east-1",
        bucket: "example-library",
        pathStyle: true,
        prefix: "library/",
        accessKeyId: "aq0123456789abcdef01234567",
        secretAccessKey: true,
      },
      checksum: "sha256",
      verify: "always",
      totalGb: 45,
      minFreeGb: 50,
    });
    expect(describeLibrary(library({ LIBRARY_MODE: "off" }))).toMatchObject({
      mode: "off",
      storage: null,
    });
    expect(describeLibrary(library({ ...BETA, LIBRARY_MODE: "readonly" })).mode).toBe("readonly");
    expect(SECRETS).toContain("LIBRARY_S3_SECRET_ACCESS_KEY");
    const env: Record<string, string | undefined> = { ...BETA };
    forgetSecrets(env);
    expect(env["LIBRARY_S3_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env["LIBRARY_S3_ACCESS_KEY_ID"]).toBe(BETA.LIBRARY_S3_ACCESS_KEY_ID);
  });

  test("count GB as 1024³ bytes, as the editor does", () => {
    expect(GB).toBe(1073741824);
    expect(gbText(45 * GB)).toBe("45 GB");
    expect(gbText(GB / 2)).toBe("0.5 GB");
    expect(gbText(0)).toBe("0 GB");
    expect(gbText(12.34 * GB)).toBe("12.3 GB");
    expect(library({ ...BETA, LIBRARY_TOTAL_GB: "0.5" }).totalBytes).toBe(GB / 2);
  });
});
