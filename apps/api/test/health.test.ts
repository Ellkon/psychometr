import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../src/app";

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("health routes", () => {
  it("GET /api/health returns ok", async () => {
    app = await buildApp({ logLevel: "silent", checkDatabase: () => Promise.resolve(true) });
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("GET /api/ready returns 503 when the database is down", async () => {
    app = await buildApp({
      logLevel: "silent",
      checkDatabase: () => Promise.reject(new Error("connection refused")),
    });
    const response = await app.inject({ method: "GET", url: "/api/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable", checks: { database: "unavailable" } });
  });

  it("sets security headers", async () => {
    app = await buildApp({ logLevel: "silent", checkDatabase: () => Promise.resolve(true) });
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});
