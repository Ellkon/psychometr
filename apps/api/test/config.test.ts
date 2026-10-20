import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("does not leak values of invalid variables", () => {
    expect(() => loadConfig({ DATABASE_URL: "not-a-url-secret" })).toThrow(
      /^Invalid environment: DATABASE_URL$/,
    );
  });

  it("applies defaults", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/db" });
    expect(config.API_PORT).toBe(3000);
    expect(config.NODE_ENV).toBe("development");
  });
});
