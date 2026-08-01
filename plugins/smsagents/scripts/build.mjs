import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await rm("dist-test", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await mkdir("dist-test", { recursive: true });

await build({
  entryPoints: ["src/server.ts", "src/hook.ts", "src/cli.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["node:sqlite"]
});

await build({
  entryPoints: ["test/store.test.ts", "test/hook.test.ts", "test/server.test.ts"],
  outdir: "dist-test",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node:sqlite"]
});
