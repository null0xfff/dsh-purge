import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detachRuntimeLinks, patchCliRuntimeText } from "../lib/desktop-runtime.js";
import { repairOfficialCliAfterUnpack } from "../lib/desktop.js";

test("CLI support path reaches the same resources/runtime for sealed and expanded layouts", () => {
  const original = 'join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), "runtime")';
  const patch = patchCliRuntimeText(original);
  assert.equal(patch.ok, true);
  const support = new Function("runtimeDir", "runtimeArchivePath", "join", "dirname", `return ${patch.text}`);
  const archivePath = runtimeDir => path.basename(path.dirname(runtimeDir)) === "app.asar" ? path.dirname(runtimeDir) : undefined;
  const resources = path.resolve("fixture", "resources");
  for (const app of ["app", "app.asar", "app.asar.unpacked"]) {
    assert.equal(support(path.join(resources, app, "dsh"), archivePath, path.join, path.dirname), path.join(resources, "runtime"));
  }
  assert.equal(patchCliRuntimeText(patch.text).changed, false);
  assert.equal(patchCliRuntimeText("unknown future CLI").ok, false);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-runtime-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources");
  const runtime = path.join(resources, "runtime");
  fs.mkdirSync(path.join(runtime, "office-skills", "office"), { recursive: true });
  const skill = path.join(runtime, "office-skills", "office", "SKILL.md");
  fs.writeFileSync(skill, "official runtime sentinel");
  const alias = (name, target = runtime) => {
    const app = path.join(resources, name);
    fs.mkdirSync(app, { recursive: true });
    const link = path.join(app, "runtime");
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return link;
  };
  return { root, resources, runtime, skill, alias };
}

test("migrate active and preserved runtime junctions without deleting target files", t => {
  const { resources, skill, alias } = fixture(t);
  const links = ["app", "app.dshpurge-prev", "app.dshpurge-prev-123", "app.dshpurge-next", "app.dshpurge-failed-456"].map(name => alias(name));
  const result = detachRuntimeLinks(resources, { platform: "win32" });
  assert.equal(result.ok, true);
  assert.deepEqual(new Set(result.removed), new Set(links));
  for (const link of links) assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(skill, "utf8"), "official runtime sentinel");
  assert.deepEqual(detachRuntimeLinks(resources, { platform: "win32" }).removed, []);
});

test("a dangling legacy junction is detached before runtime installation", t => {
  const { resources, runtime, alias } = fixture(t);
  const link = alias("app");
  fs.rmSync(runtime, { recursive: true });
  assert.equal(fs.existsSync(link), false);
  assert.deepEqual(detachRuntimeLinks(resources, { platform: "win32" }).removed, [link]);
  assert.throws(() => fs.lstatSync(link), { code: "ENOENT" });
});

test("migration repairs the expanded CLI before removing its runtime junction", t => {
  const { resources, skill, alias } = fixture(t);
  const link = alias("app");
  const cli = path.join(resources, "app", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, 'await runDesktopCli(runtimeDir, join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), "runtime"));');
  const result = detachRuntimeLinks(resources, { platform: "win32" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, [link]);
  assert.match(fs.readFileSync(cli, "utf8"), /runtimeArchivePath\(runtimeDir\) \?\? dirname\(runtimeDir\)/);
  assert.equal(fs.readFileSync(skill, "utf8"), "official runtime sentinel");
});

test("unsupported CLI keeps its legacy link and reports a migration error", t => {
  const { resources, alias } = fixture(t);
  const link = alias("app");
  const cli = path.join(resources, "app", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "unknown future CLI");
  const result = detachRuntimeLinks(resources, { platform: "win32" });
  assert.equal(result.ok, false);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.match(result.errors[0].error, /Unsupported desktop CLI/);
});

test("keep real directories, unrelated targets and unrelated backup names", t => {
  const { root, resources, runtime, skill, alias } = fixture(t);
  const real = path.join(resources, "app", "runtime");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "local.txt"), "local file");
  const outside = path.join(root, "other-runtime");
  fs.mkdirSync(outside);
  const unexpected = alias("app.dshpurge-prev", outside);
  const unrelated = alias("app.user-copy", runtime);
  const result = detachRuntimeLinks(resources, { platform: "win32" });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].path, unexpected);
  assert.equal(fs.lstatSync(unexpected).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(unrelated).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(real, "local.txt"), "utf8"), "local file");
  assert.equal(fs.readFileSync(skill, "utf8"), "official runtime sentinel");
});

test("a linked app directory is not traversed", t => {
  const { root, resources, runtime } = fixture(t);
  const outside = path.join(root, "outside-app");
  fs.mkdirSync(outside);
  const inner = path.join(outside, "runtime");
  fs.symlinkSync(runtime, inner, process.platform === "win32" ? "junction" : "dir");
  fs.symlinkSync(outside, path.join(resources, "app"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(detachRuntimeLinks(resources, { platform: "win32" }).removed, []);
  assert.equal(fs.lstatSync(inner).isSymbolicLink(), true);
});

test("non-Windows migration preserves relative directory symlinks", t => {
  const { resources, alias } = fixture(t);
  const link = alias("app");
  assert.equal(detachRuntimeLinks(resources, { platform: "linux" }).skipped, "not_windows");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test("Windows CLI repair keeps fallback entries and creates no runtime junction", { skip: process.platform !== "win32" }, t => {
  const { root, resources, runtime, skill } = fixture(t);
  const exe = path.join(root, "DeepSeek Harness.exe");
  fs.writeFileSync(exe, "fixture");
  fs.mkdirSync(path.join(resources, "app"));
  const bin = path.join(runtime, "cli", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, "dsh.cmd");
  fs.writeFileSync(shim, '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%exe%" "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\n');
  const result = repairOfficialCliAfterUnpack(exe);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(resources, "app", "runtime")), false);
  const text = fs.readFileSync(shim, "utf8");
  assert.ok(text.includes("app.asar.unpacked"));
  assert.ok(text.includes('"%entry%" %*'));
  assert.equal(fs.readFileSync(`${shim}.dsh-purge.bak`, "utf8").includes("app.asar"), true);
  assert.equal(fs.readFileSync(skill, "utf8"), "official runtime sentinel");
});
