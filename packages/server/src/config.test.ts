import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  ConfigError,
  describeConfig,
  forgetSecrets,
  loadConfig,
  localReposOn,
  privateKeyProblem,
  secret,
} from "./config.ts";

const files = (entries: Record<string, string>) => (path: string) => entries[path];

const key = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({
  type: "pkcs1",
  format: "pem",
}) as string;

describe("secrets", () => {
  test("come from a file, without its last line break", () => {
    expect(secret({ X_FILE: "/run/x" }, "X", files({ "/run/x": "hunter2\n" }))).toBe("hunter2");
  });

  test("or from the variable, and an empty one is not set", () => {
    expect(secret({ X: "value" }, "X", files({}))).toBe("value");
    expect(secret({ X: "  " }, "X", files({}))).toBeUndefined();
    expect(secret({}, "X", files({}))).toBeUndefined();
  });

  test("not from both, and a file that is not there is an error unless it may be missing", () => {
    expect(() => secret({ X: "a", X_FILE: "/run/x" }, "X", files({ "/run/x": "b" }))).toThrow(
      ConfigError,
    );
    expect(() => secret({ X_FILE: "/run/x" }, "X", files({}))).toThrow(
      /X_FILE names a file that is not there/,
    );
    expect(
      secret({ X: "a", X_FILE: "/run/x" }, "X", files({}), {
        optionalFile: true,
      }),
    ).toBe("a");
  });

  test("an empty file is not set, as the one deploy.sh puts where the App's key can go", () => {
    expect(
      secret({ X: "from .env", X_FILE: "/run/x" }, "X", files({ "/run/x": "" }), {
        optionalFile: true,
        pem: true,
      }),
    ).toBe("from .env");
    expect(
      secret({ X: "", X_FILE: "/run/x" }, "X", files({ "/run/x": "\n" }), { optionalFile: true }),
    ).toBeUndefined();
  });

  test("errors never show the value", () => {
    try {
      secret({ X: "the-secret", X_FILE: "/run/x" }, "X", files({ "/run/x": "other-secret" }));
    } catch (error) {
      expect(String(error)).not.toMatch(/secret/);
    }
  });

  test("a key on one line with \\n in it gets its lines back; other secrets stay as typed", () => {
    const oneLine = key.trim().replaceAll("\n", "\\n");
    const read = secret({ K: oneLine }, "K", files({}), { pem: true });
    expect(read).toBe(key.trim());
    expect(privateKeyProblem(read ?? "")).toBeUndefined();
    expect(secret({ X: "a\\nb" }, "X", files({}))).toBe("a\\nb");
  });

  test("a key cut to its first line, as .env gives it without quotes, says so", () => {
    expect(privateKeyProblem(key.split("\n")[0] ?? "")).toMatch(/cut short/);
    expect(
      privateKeyProblem(
        key
          .split("\n")
          .filter((_, line) => line !== 3)
          .join("\n"),
      ),
    ).toMatch(/not a private key/);
  });

  test("leave the environment once read", () => {
    const env: Record<string, string | undefined> = {
      GITHUB_WEBHOOK_SECRET: "a",
      GITHUB_CLIENT_SECRET: "b",
      GITHUB_APP_PRIVATE_KEY: "c",
      DATABASE_PASSWORD: "d",
      GITHUB_APP_ID: "1",
    };
    forgetSecrets(env);
    expect(env).toEqual({ GITHUB_APP_ID: "1" });
  });
});

describe("the configuration", () => {
  test("has defaults, and what it says about itself holds no secret", () => {
    const config = loadConfig(
      {
        DATABASE_PASSWORD_FILE: "/run/secrets/database",
        GITHUB_APP_ID: "1000001",
        GITHUB_CLIENT_ID: "Iv1.a1b2c3d4e5f60718",
        GITHUB_CLIENT_SECRET: "client-secret-value",
        GITHUB_WEBHOOK_SECRET: "webhook-secret-value",
        GITHUB_APP_PRIVATE_KEY: key,
      },
      files({ "/run/secrets/database": "db-password-value\n" }),
    );
    expect(config.port).toBe(8300);
    expect(config.database.password).toBe("db-password-value");
    const said = JSON.stringify(describeConfig(config));
    for (const value of [
      "client-secret-value",
      "webhook-secret-value",
      "db-password-value",
      "PRIVATE KEY",
    ])
      expect(said).not.toContain(value);
    expect(describeConfig(config).github).toEqual({
      appId: "1000001",
      appSlug: null,
      clientId: "Iv1.a1b2c3d4e5f60718",
      clientSecret: true,
      webhookSecret: true,
      privateKey: true,
    });
  });

  test("a GitHub setting that is wrong is left out, and the API still starts", () => {
    const config = loadConfig(
      {
        GITHUB_WEBHOOK_SECRET: "a",
        GITHUB_WEBHOOK_SECRET_FILE: "/run/w",
        GITHUB_APP_PRIVATE_KEY: key.split("\n")[0] ?? "",
        GITHUB_CLIENT_SECRET: "c",
      },
      files({ "/run/w": "b" }),
    );
    expect(config.github.webhookSecret).toBeUndefined();
    expect(config.github.privateKey).toBeUndefined();
    expect(config.github.clientSecret).toBe("c");
    expect(config.github.problems).toEqual([
      "GITHUB_APP_PRIVATE_KEY is cut short: in .env it needs double quotes around all of its lines",
      "GITHUB_WEBHOOK_SECRET and GITHUB_WEBHOOK_SECRET_FILE are both set; keep one",
    ]);
  });

  test("stops on a port that is not one", () => {
    expect(() => loadConfig({ PORT: "http" }, files({}))).toThrow(/PORT/);
  });

  test("GitHub is github.com unless told otherwise, and the App's name in its address is checked", () => {
    const usual = loadConfig({ GITHUB_APP_SLUG: "animaquill" }, files({}));
    expect(usual.github.webUrl).toBe("https://github.com");
    expect(usual.github.apiUrl).toBe("https://api.github.com");
    expect(usual.github.appSlug).toBe("animaquill");
    const other = loadConfig(
      {
        GITHUB_URL: "http://127.0.0.1:8400/",
        GITHUB_API_URL: "http://127.0.0.1:8400/api",
        GITHUB_APP_SLUG: "Not A Slug",
      },
      files({}),
    );
    expect(other.github.webUrl).toBe("http://127.0.0.1:8400");
    expect(other.github.apiUrl).toBe("http://127.0.0.1:8400/api");
    expect(other.github.appSlug).toBeUndefined();
    const wrong = loadConfig(
      { GITHUB_URL: "github.com", GITHUB_API_URL: "https://x/?a=1" },
      files({}),
    );
    expect(wrong.github.webUrl).toBe("https://github.com");
    expect(wrong.github.apiUrl).toBe("https://api.github.com");
    expect(wrong.github.problems.join()).toMatch(/GITHUB_URL.*GITHUB_API_URL/s);
  });
});

describe("the master key", () => {
  const masterKey = randomBytes(32).toString("base64");

  test("comes from its file, and only its versions are ever said", () => {
    const config = loadConfig(
      { PLATFORM_MASTER_KEY_FILE: "/run/secrets/master-key" },
      files({ "/run/secrets/master-key": `1:${masterKey}\n` }),
    );
    expect(config.masterKeys?.map((item) => item.version)).toEqual([1]);
    expect(config.problems).toEqual([]);
    expect(describeConfig(config).masterKeys).toEqual([1]);
    expect(JSON.stringify(describeConfig(config))).not.toContain(masterKey);
  });

  test("missing or wrong, nobody can sign in, and the API still starts", () => {
    const none = loadConfig({}, files({}));
    expect(none.masterKeys).toBeUndefined();
    expect(none.problems).toEqual(["PLATFORM_MASTER_KEY is not set: nobody can sign in"]);
    const wrong = loadConfig({ PLATFORM_MASTER_KEY: masterKey }, files({}));
    expect(wrong.masterKeys).toBeUndefined();
    expect(wrong.problems.join()).toMatch(/PLATFORM_MASTER_KEY: line 1/);
    expect(wrong.problems.join()).not.toContain(masterKey);
    const gone = loadConfig({ PLATFORM_MASTER_KEY_FILE: "/run/secrets/master-key" }, files({}));
    expect(gone.problems.join()).toMatch(/PLATFORM_MASTER_KEY_FILE names a file that is not there/);
  });

  test("leaves the environment once read", () => {
    const env: Record<string, string | undefined> = { PLATFORM_MASTER_KEY: `1:${masterKey}` };
    expect(loadConfig(env, files({})).masterKeys).toHaveLength(1);
    forgetSecrets(env);
    expect(env).toEqual({});
  });
});

describe("uploads into Git LFS", () => {
  test("wait in the staging volume, and keep 30 GiB of its disk free, unless told otherwise", () => {
    const plainly = loadConfig({}, files({}));
    expect(plainly.stagingDir).toBe("/var/lib/animaquill/staging");
    expect(plainly.stagingFloorGb).toBeUndefined();
    const told = loadConfig({ LFS_STAGING_DIR: "/tmp/staging", LFS_MIN_FREE_GB: "1.5" }, files({}));
    expect(told).toMatchObject({ stagingDir: "/tmp/staging", stagingFloorGb: 1.5 });
    expect(describeConfig(told)).toMatchObject({ stagingDir: "/tmp/staging", stagingFloorGb: 1.5 });
  });

  test("take the default, and say so, for what is not a whole path or a number", () => {
    for (const [name, value] of [
      ["LFS_STAGING_DIR", "staging"],
      ["LFS_MIN_FREE_GB", "-1"],
      ["LFS_MIN_FREE_GB", "30GB"],
    ] as const) {
      const config = loadConfig({ [name]: value }, files({}));
      expect(config.stagingDir, value).toBe("/var/lib/animaquill/staging");
      expect(config.stagingFloorGb, value).toBeUndefined();
      expect(config.problems.join(), value).toContain(name);
    }
  });
});

describe("repositories of the server's own", () => {
  test("are on where the GitHub App is not set up, or where AQ_LOCAL_REPOS says so; in the data folder", () => {
    const plainly = loadConfig({}, files({}));
    expect(plainly.dataDir).toBe("/var/lib/animaquill");
    expect(localReposOn(plainly)).toBe(true);
    const github = {
      GITHUB_APP_ID: "1",
      GITHUB_CLIENT_ID: "Iv1.0000000000000000",
      GITHUB_APP_PRIVATE_KEY: key,
    };
    expect(localReposOn(loadConfig(github, files({})))).toBe(false);
    expect(localReposOn(loadConfig({ ...github, AQ_LOCAL_REPOS: "on" }, files({})))).toBe(true);
    expect(localReposOn(loadConfig({ AQ_LOCAL_REPOS: "off" }, files({})))).toBe(false);
    const told = loadConfig({ AQ_DATA_DIR: "/data/aq" }, files({}));
    expect(describeConfig(told)).toMatchObject({ dataDir: "/data/aq", localRepos: true });
    const wrong = loadConfig({ AQ_DATA_DIR: "data", AQ_LOCAL_REPOS: "yes" }, files({}));
    expect(wrong.dataDir).toBe("/var/lib/animaquill");
    expect(wrong.localRepos).toBeUndefined();
    expect(wrong.problems.join(" ")).toMatch(/AQ_DATA_DIR.*AQ_LOCAL_REPOS/);
  });
});
