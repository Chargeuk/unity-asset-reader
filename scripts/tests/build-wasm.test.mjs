import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const DECODER = resolve(import.meta.dirname, "../../packages/decoder");
const IMAGE = "emscripten/emsdk:4.0.7@sha256:8acec700a48dbff5250afc1e3ee545b7c002b689043ee82c277de6481a237fd7";
const REVISION = "8dc91db45bf96c174531006839472a3924d105aa";
const banner = (version) =>
  `emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) ${version}`;

// Run the real builder and glue patcher in a disposable package copy. PATH contains only
// stubs and the few required host utilities, so these tests cannot invoke a real SDK/Docker.
function fixture(t, { nativeVersion, docker = false, node = true, ...options } = {}) {
  const root = mkdtempSync(join(tmpdir(), "decoder-build-route-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const pkg = join(root, "package with spaces");
  mkdirSync(bin);
  mkdirSync(join(pkg, "scripts"), { recursive: true });
  const sources = join(pkg, "texture2ddecoder/src/Texture2DDecoder");
  mkdirSync(sources, { recursive: true });
  for (const name of ["bcn", "pvrtc", "etc", "atc", "astc", "crunch", "unitycrunch"]) {
    writeFileSync(join(sources, `${name}.cpp`), "// fixture only\n");
  }
  writeFileSync(join(pkg, "wasm_bindings.cpp"), "// fixture only\n");
  for (const name of ["build-wasm.sh", "patch-glue.mjs"]) {
    copyFileSync(join(DECODER, "scripts", name), join(pkg, "scripts", name));
  }
  for (const name of ["dirname", "mkdir"]) symlinkSync(`/usr/bin/${name}`, join(bin, name));
  if (node) symlinkSync(process.execPath, join(bin, "node"));
  const log = join(root, "commands.jsonl");
  const compiler = join(root, "compiler.cjs");
  writeFileSync(compiler, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({
  command: "em++", args, cwd: process.cwd(), container: process.env.IN_CONTAINER === "1"
}) + "\\n");
if (args[0] === "--version") {
  console.log(process.env.COMPILER_VERSION);
  process.exit(Number(process.env.VERSION_EXIT));
}
if (Number(process.env.COMPILER_EXIT)) process.exit(Number(process.env.COMPILER_EXIT));
for (const arg of args.filter(arg => arg.endsWith(".cpp"))) {
  if (!fs.existsSync(path.resolve(arg))) throw new Error("Unresolved source: " + arg);
}
const output = args[args.indexOf("-o") + 1];
fs.writeFileSync(output, process.env.BAD_GLUE === "1" ? "unsupported glue" :
  'const{createRequire}=await import("module");\\nexport default function createModule() {}\\n');
`, { mode: 0o755 });
  if (nativeVersion !== undefined) symlinkSync(compiler, join(bin, "em++"));
  if (docker) {
    writeFileSync(join(bin, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ command: "docker", args }) + "\\n");
const image = args.findIndex(arg => arg.startsWith("emscripten/emsdk:"));
if (image < 0) throw new Error("Missing SDK image");
const [command, ...rest] = args.slice(image + 1);
if (command !== "em++" && command !== "node") throw new Error("Unexpected command: " + command);
const child = spawnSync(process.execPath,
  command === "em++" ? [process.env.COMPILER_STUB, ...rest] : rest,
  { env: { ...process.env, IN_CONTAINER: "1" }, stdio: "inherit" });
process.exit(child.status ?? 1);
`, { mode: 0o755 });
  }
  const run = () => spawnSync("/bin/bash", [join(pkg, "scripts/build-wasm.sh")], {
    cwd: root, encoding: "utf8",
    env: {
      ...process.env, PATH: bin, COMMAND_LOG: log, COMPILER_STUB: compiler,
      COMPILER_VERSION: nativeVersion ?? "", VERSION_EXIT: String(options.versionExit ?? 0),
      COMPILER_EXIT: String(options.compilerExit ?? 0), BAD_GLUE: options.badGlue ? "1" : "0",
      IN_CONTAINER: "0",
    },
  });
  return {
    run, pkg,
    commands: () => existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    glue: () => readFileSync(join(pkg, "wasm/texture2ddecoder.js"), "utf8"),
  };
}

for (const version of ["4.0.7", `4.0.7 (${REVISION})`, `4.0.7-git (${REVISION})`]) {
  test(`native ${version} builds and patches without Docker`, (t) => {
    const f = fixture(t, { nativeVersion: banner(version) });
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const commands = f.commands();
    assert.equal(commands.filter(c => c.command === "docker").length, 0);
    assert.deepEqual(commands[0].args, ["--version"]);
    assert.equal(commands.length, 2);
    assert.equal(commands[1].cwd, f.pkg);
    assert.equal(commands[1].container, false);
    assert.match(f.glue(), /nodeModule\.createRequire\|\|nodeModule\.default\.createRequire/);
  });
}

test("missing native SDK uses the unchanged pinned image and identical compiler arguments", (t) => {
  const native = fixture(t, { nativeVersion: banner("4.0.7") });
  const docker = fixture(t, { docker: true });
  for (const f of [native, docker]) {
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const nativeCompile = native.commands().find(c => c.command === "em++" && c.args[0] !== "--version");
  const containerCompile = docker.commands().find(c => c.command === "em++");
  assert.deepEqual(containerCompile.args, nativeCompile.args);
  assert.equal(containerCompile.container, true);
  assert.deepEqual(containerCompile.args.filter(arg => arg.endsWith(".cpp")), [
    ...["bcn", "pvrtc", "etc", "atc", "astc", "crunch", "unitycrunch"]
      .map(name => `texture2ddecoder/src/Texture2DDecoder/${name}.cpp`),
    "wasm_bindings.cpp",
  ]);
  assert.ok(containerCompile.args.includes("-O3"));
  assert.ok(containerCompile.args.includes("EXPORTED_RUNTIME_METHODS=[ccall,cwrap]"));
  assert.ok(containerCompile.args.includes("INCOMING_MODULE_JS_API=[locateFile]"));
  assert.deepEqual(containerCompile.args.slice(-2), ["-o", "wasm/texture2ddecoder.js"]);
  const calls = docker.commands().filter(c => c.command === "docker");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.args.slice(0, 7), [
      "run", "--rm", "-v", `${docker.pkg}:/project`, "-w", "/project", IMAGE,
    ]);
  }
  assert.deepEqual(calls[1].args.slice(7), ["node", "scripts/patch-glue.mjs"]);
  assert.equal(docker.glue(), native.glue());
});

for (const version of [
  "4.0.70", "4.0.7-dev", "4.0.7-git", `4.0.7 (${"0".repeat(40)})`,
  `4.0.7-git (${"0".repeat(40)})`,
]) {
  test(`incompatible native ${version} cannot compile and falls back to the pinned image`, (t) => {
    const f = fixture(t, { nativeVersion: banner(version), docker: true });
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /incompatible native em\+\+/);
    const compiles = f.commands().filter(c => c.command === "em++" && c.args[0] !== "--version");
    assert.equal(compiles.length, 1);
    assert.equal(compiles[0].container, true);
  });
}

test("a failed native version probe falls back without treating the SDK as verified", (t) => {
  const f = fixture(t, { nativeVersion: banner("4.0.7"), versionExit: 9, docker: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /native em\+\+ --version failed/);
  assert.equal(f.commands().find(c => c.command === "em++" && c.args[0] !== "--version").container, true);
});

test("missing native SDK and Docker fails contextually before output creation", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /em\+\+ was not found on PATH; Docker is also unavailable/);
  assert.match(result.stderr, /4\.0\.7/);
  assert.equal(existsSync(join(f.pkg, "wasm")), false);
});

test("native route requires node for the existing glue patch before compiling", (t) => {
  const f = fixture(t, { nativeVersion: banner("4.0.7"), node: false });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs node on PATH/);
  assert.equal(f.commands().length, 1);
});

test("native compile failure is preserved without patching or retrying Docker", (t) => {
  const f = fixture(t, { nativeVersion: banner("4.0.7"), compilerExit: 23, docker: true });
  const result = f.run();
  assert.equal(result.status, 23);
  assert.match(result.stderr, /em\+\+ compilation failed \(exit 23\)/);
  assert.equal(f.commands().filter(c => c.command === "docker").length, 0);
  assert.equal(existsSync(join(f.pkg, "wasm/texture2ddecoder.js")), false);
});

test("unexpected glue fails the existing patch instead of reporting successful preparation", (t) => {
  const f = fixture(t, { nativeVersion: banner("4.0.7"), badGlue: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /patch-glue: expected 1/);
  assert.doesNotMatch(result.stdout, /Generated and patched/);
});
