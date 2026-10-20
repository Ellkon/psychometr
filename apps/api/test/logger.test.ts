import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { loggerOptions } from "../src/logger";

describe("request log serializer", () => {
  it("logs the route pattern, not the raw URL with the invite token", () => {
    const options = loggerOptions("info");
    if (typeof options === "boolean") throw new Error("expected logger options object");
    const serialize = options.serializers?.req;
    if (!serialize) throw new Error("req serializer is missing");

    const request = {
      method: "GET",
      url: "/i/secret-token?code=123456",
      headers: { authorization: "Bearer secret" },
      routeOptions: { url: "/i/:token" },
    } as unknown as FastifyRequest;

    const logged = JSON.stringify(serialize(request));
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("123456");
    expect(logged).toContain("/i/:token");
  });
});
