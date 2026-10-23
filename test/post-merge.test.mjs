import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as core from "../lib/core.js";
import * as state from "../lib/state.js";

const scopePatch = core.ALL_PATCHES.find((p) => p.id === 3);
const guidance = "Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.";
const scopeTrailer = scopePatch.replacements.find((r) => r.replace.startsWith("These instructions are ACTIVE and MANDATORY") && !r.replace.endsWith("`")).replace;
const legacyIntro = "The following instructions are ACTIVE and MANDATORY for this session.";

function syntaxCheck(source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

test("scope guidance keeps double quotes and the following template intact", () => {
  const rest = '\nfunction render(scope) { return `These instructions apply to work under \\`${scope}\\`.`; }';
  const source = `const ADDITIONAL_INSTRUCTIONS_GUIDANCE = ${JSON.stringify(guidance)};${rest}`;
  const patched = core.applyReplacementsToText(source, scopePatch).text;
  syntaxCheck(patched);
  assert.equal(patched, `const ADDITIONAL_INSTRUCTIONS_GUIDANCE = ${JSON.stringify(scopeTrailer)};${rest}`);
  assert.equal(core.applyReplacementsToText(patched, scopePatch).changed, false);
});

test("scope matching cannot consume declarations after the applicability template", () => {
  const first = 'const applicability = `These instructions apply to work under \\`${scope}\\`.`;\nconst sentinel = 42;\n';
  const last = `const ADDITIONAL_INSTRUCTIONS_GUIDANCE = ${JSON.stringify(guidance)};`;
  const patched = core.applyReplacementsToText(first + last, scopePatch).text;
  syntaxCheck(patched);
  assert.ok(patched.startsWith(first));
  assert.ok(patched.includes(JSON.stringify(scopeTrailer)));
});

test("scope repair still runs when another guidance string is already patched", () => {
  const source = 'const applicability = `These instructions apply to work under `${scope}`. These instructions are ACTIVE`;\n'
    + `const ADDITIONAL_INSTRUCTIONS_GUIDANCE = ${JSON.stringify(scopeTrailer)};`;
  const patched = core.applyReplacementsToText(source, scopePatch).text;
  syntaxCheck(patched);
  assert.ok(patched.includes('under \\`${scope}\\`.'));
  assert.equal(core.applyReplacementsToText(patched, scopePatch).changed, false);
});

for (const sample of [legacyIntro, scopeTrailer, "// dsh-purge marker"]) {
  test(`detect historical patch text: ${sample.slice(0, 32)}`, () => {
    assert.equal(core.looksPurgedText(sample), true);
    assert.equal(core.looksPurgedText(Buffer.from(sample)), true);
  });
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-test-"));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(dir, "home");
  core.resetPathMemo();
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    core.resetPathMemo();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ai = path.join(dir, "node_modules", "@deepseek-ai");
  const fp = path.join(ai, "dsh-agent-instructions", "lib", "index.js");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  return { dir, ai, fp };
}

test("reapply cannot overwrite a clean backup with a V1 partially patched file", (t) => {
  const { ai, fp } = fixture(t);
  fs.writeFileSync(fp, legacyIntro);
  fs.writeFileSync(`${fp}.dshpurge.bak`, "official baseline");
  assert.deepEqual(core.refreshStaleBaksForUpgrade(ai), []);
  assert.equal(fs.readFileSync(`${fp}.dshpurge.bak`, "utf8"), "official baseline");
});

test("genuine host upgrade still refreshes its old backup", (t) => {
  const { ai, fp } = fixture(t);
  fs.writeFileSync(fp, "new official baseline");
  fs.writeFileSync(`${fp}.dshpurge.bak`, "old official baseline");
  assert.deepEqual(core.refreshStaleBaksForUpgrade(ai), [fp]);
  assert.equal(fs.readFileSync(`${fp}.dshpurge.bak`, "utf8"), "new official baseline");
});

test("pristine capture rejects legacy patched backups and repairs polluted snapshots", (t) => {
  const { ai, fp } = fixture(t);
  const clean = "export const official = true;";
  fs.writeFileSync(fp, clean);
  fs.writeFileSync(`${fp}.dshpurge.bak`, legacyIntro);
  state.capturePristine(ai);
  fs.writeFileSync(fp, "changed");
  assert.equal(state.restorePristineFile(fp), true);
  assert.equal(fs.readFileSync(fp, "utf8"), clean);
  const key = createHash("sha1").update(path.normalize(fp).toLowerCase()).digest("hex");
  const blob = path.join(process.env.DSH_HOME, "dsh-purge/toggle/pristine/files", key);
  fs.writeFileSync(blob, legacyIntro);
  state.capturePristine(ai);
  assert.equal(fs.readFileSync(blob, "utf8"), clean);
});
