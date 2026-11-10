import { describe, expect, it } from "vitest";
import { RELAY_REFUSALS, relayRefusalBody, relayRefusalIn } from "./relay.ts";

describe("what the relay says when it passes nothing on", () => {
  it("is told apart from the service in the error of every library of services", () => {
    for (const why of RELAY_REFUSALS) {
      const body = JSON.stringify(relayRefusalBody(why, "details for people"));
      const error = (relayRefusalBody(why, "details for people") as { error: object }).error;
      // How the libraries of OpenAI, Anthropic, Google and Mistral put an error into words.
      for (const said of [
        `403 aq-relay:${why} details for people`,
        `403 ${body}`,
        `403: ${JSON.stringify(error)}`,
        `got status: 403 . ${body}`,
      ])
        expect(relayRefusalIn(said), said).toBe(why);
    }
  });

  it("is not what a service says, nor a reason the relay does not have", () => {
    expect(
      relayRefusalIn('401 {"error":{"message":"Incorrect API key provided"}}'),
    ).toBeUndefined();
    expect(relayRefusalIn("aq-relay:whatever it is")).toBeUndefined();
    expect(relayRefusalIn("")).toBeUndefined();
  });
});
