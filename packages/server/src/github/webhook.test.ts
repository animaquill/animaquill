import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { payloadOf, signatureMatches } from "./webhook.ts";

const sign = (secret: string, body: Buffer | string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("the signature of a webhook", () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');

  test("matches when made with the secret over these bytes", () => {
    expect(signatureMatches("secret", body, sign("secret", body))).toBe(true);
    expect(
      signatureMatches(
        "secret",
        body,
        sign("secret", body).toUpperCase().replace("SHA256", "sha256"),
      ),
    ).toBe(true);
  });

  // The example GitHub gives in its documentation of validating deliveries.
  test("matches the example of GitHub", () => {
    expect(
      signatureMatches(
        "It's a Secret to Everybody",
        Buffer.from("Hello, World!"),
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      ),
    ).toBe(true);
  });

  test("does not match with another secret, other bytes, or no signature", () => {
    expect(signatureMatches("secret", body, sign("other", body))).toBe(false);
    expect(signatureMatches("secret", Buffer.from(`${body} `), sign("secret", body))).toBe(false);
    expect(signatureMatches("secret", body, undefined)).toBe(false);
    expect(signatureMatches("secret", body, "")).toBe(false);
  });

  test("does not match what is not one, whatever its length", () => {
    const good = sign("secret", body);
    for (const header of [
      good.slice(0, -2),
      `${good}00`,
      good.replace("sha256=", "sha1="),
      good.replace("sha256=", ""),
      `${good}, ${good}`,
      `sha256=${"z".repeat(64)}`,
    ])
      expect(signatureMatches("secret", body, header), header).toBe(false);
  });
});

describe("what a delivery says", () => {
  test("is its JSON, or the JSON in the field of a form, where the App sends forms", () => {
    const json = { action: "revoked", sender: { id: 1 } };
    expect(payloadOf(Buffer.from(JSON.stringify(json)))).toEqual(json);
    const form = `payload=${encodeURIComponent(JSON.stringify(json))}`;
    expect(payloadOf(Buffer.from(form))).toEqual(json);
    expect(payloadOf(Buffer.from("not json"))).toBeUndefined();
  });
});
