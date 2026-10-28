import assert from "node:assert/strict";
import { loadFixture, assertMatchesGolden } from "../../../fixtures/helpers.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const dist = (file: string) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));
const require = createRequire(import.meta.url);

test("emits dist/index.mjs, dist/index.cjs and dist/index.d.ts", () => {
  for (const file of ["index.mjs", "index.cjs", "index.d.ts"]) {
    assert.ok(existsSync(dist(file)), `missing dist/${file}`);
  }
});

test("the ESM entry point loads via import()", async () => {
  assert.ok(await import(dist("index.mjs")));
});

test("the CJS entry point loads via require()", () => {
  assert.ok(require(dist("index.cjs")));
});

test("the published tarball holds dist, LICENSE, NOTICE and README only", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const files: string[] = JSON.parse(result.stdout)[0].files.map((f: { path: string }) => f.path);
  assert.deepStrictEqual(
    files.filter((path) => !path.startsWith("dist/")).sort(),
    ["LICENSE", "NOTICE", "README.md", "package.json"],
  );
  assert.deepStrictEqual(
    files.filter((path) => path.endsWith(".tsbuildinfo") || /(?<!\.d)\.ts$/.test(path)),
    [],
  );
});


test("both distributions execute public LZMA range acquisition without private subpaths", async () => {
  for (const api of [require(dist("index.cjs")), await import(dist("index.mjs"))]) {
    assert.equal(typeof api.setResourceReader, "function");
    const reader = await api.openBundleRange(new Blob([loadFixture("lzma.bundle")]));
    const files = [];
    try {
      for (const entry of reader.entries) {
        const data = await reader.readRange({ entry, offset: 0, length: entry.size });
        files.push({ path: entry.path, data });
      }
      assertMatchesGolden("lzma.bundle", files);
    } finally { reader.close(); }
  }
});
