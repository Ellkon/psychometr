// Bundles the API into dist/. Workspace packages (@kompas/*) are TypeScript
// sources and get inlined; third-party dependencies stay external and are
// installed in the runtime image.
import { build } from "esbuild";
import pkg from "./package.json" with { type: "json" };

const external = Object.keys(pkg.dependencies ?? {})
  .filter((name) => !name.startsWith("@kompas/"))
  .flatMap((name) => [name, `${name}/*`]);

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external,
});
