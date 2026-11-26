import { describe, expect, test } from "vitest";
import { relayAddressOf } from "@animaquill/host/relay";
import { targetOf } from "./target.ts";

/**
 * The address of the relay that the editor makes of a service's (`relayAddressOf` of
 * @animaquill/host, which the online mode of @animaquill/web uses), and where the relay of the
 * server takes it (target.ts): the same.
 */

describe("the editor and the relay", () => {
  const ORIGIN = "https://editor.example.com";

  test("agree on where each service is", () => {
    // The services the editor sends through the relay by default, and a few others.
    for (const baseUrl of [
      "https://api.moonshot.cn/v1",
      "https://open.bigmodel.cn/api/paas/v4",
      "https://api.minimaxi.com/anthropic",
      "https://api.fireworks.ai/inference/v1",
      "https://integrate.api.nvidia.com/v1",
      "https://openrouter.ai/api/v1",
      "https://generativelanguage.googleapis.com/v1beta",
      "https://api.anthropic.com",
      "https://API.Example.com/v1/",
    ]) {
      const relayed = relayAddressOf(baseUrl, ORIGIN);
      expect(relayed, baseUrl).toBeDefined();
      const service = new URL(baseUrl);
      // The way the libraries add their paths to an address.
      const at = new URL(`${relayed}/chat/completions?alt=sse`);
      expect(at.origin).toBe(ORIGIN);
      expect(targetOf(`${at.pathname}${at.search}`), baseUrl).toEqual({
        hostname: service.hostname,
        path: `${service.pathname.replace(/\/$/, "")}/chat/completions?alt=sse`,
      });
      // pi tells services apart by their address: the relay's still has the service's name in it.
      expect(relayed).toContain(service.hostname);
    }
  });

  test("agree on what the relay does not take", () => {
    for (const baseUrl of [
      "http://api.example.com/v1",
      "https://api.example.com:8443/v1",
      "https://user:password@api.example.com/v1",
      "https://127.0.0.1/v1",
      "https://[::1]/v1",
      "https://api.example.com/v1?key=x",
      "not an address",
    ])
      expect(relayAddressOf(baseUrl, ORIGIN), baseUrl).toBeUndefined();
  });
});
