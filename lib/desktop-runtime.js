import path from "node:path";
import { diskFs } from "./extract-asar.js";

const OLD_SUPPORT = 'join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), "runtime")';
const NEW_SUPPORT = 'join(dirname(runtimeArchivePath(runtimeDir) ?? dirname(runtimeDir)), "runtime")';

/** Expanded app/dsh needs resources/runtime; app.asar/dsh already resolves the same sibling. */
export function patchCliRuntimeText(source) {
  if (source.includes(NEW_SUPPORT)) return { ok: true, changed: false, text: source };
  if (!source.includes(OLD_SUPPORT)) return { ok: false, changed: false, error: "Unsupported desktop CLI runtime layout" };
  return { ok: true, changed: true, text: source.replaceAll(OLD_SUPPORT, NEW_SUPPORT) };
}

function repairCliRuntime(appDir, fs) {
  const file = path.join(appDir, "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
  let source;
  try { source = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { ok: true, missing: true }; throw error; }
  const patch = patchCliRuntimeText(source);
  if (!patch.ok) throw new Error(patch.error);
  if (!patch.changed) return { ok: true, changed: false };
  const tmp = `${file}.${process.pid}.runtime-tmp`;
  try {
    fs.writeFileSync(tmp, patch.text, "utf8");
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  return { ok: true, changed: true };
}

/** Remove legacy runtime links before an installer can follow them from its backup tree. */
export function detachRuntimeLinks(resources, { fs = diskFs(), platform = process.platform } = {}) {
  if (platform !== "win32") return { ok: true, removed: [], skipped: "not_windows" };
  const removed = [];
  const errors = [];
  const expected = path.resolve(resources, "runtime").toLowerCase();
  let names;
  try { names = fs.readdirSync(resources); }
  catch (error) { return { ok: false, removed, errors: [{ path: resources, error: error.message }] }; }
  for (const name of names) {
    if (name !== "app" && !/^app\.dshpurge-(?:prev|next|failed)(?:-\d+)?$/.test(name)) continue;
    const appDir = path.join(resources, name);
    const link = path.join(appDir, "runtime");
    try {
      // A linked app directory belongs to another tree; never walk through it.
      const app = fs.lstatSync(appDir);
      if (!app.isDirectory() || app.isSymbolicLink()) continue;
      // Fix the CLI before removing the old alias, including preserved apps that may be restored.
      repairCliRuntime(appDir, fs);
      let stat;
      try { stat = fs.lstatSync(link); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!stat.isSymbolicLink()) continue;
      const target = path.resolve(appDir, fs.readlinkSync(link));
      if (target.toLowerCase() !== expected) {
        errors.push({ path: link, error: "Unexpected runtime link target", target });
        continue;
      }
      // unlink removes the reparse entry, including a dangling junction, without touching its target.
      fs.unlinkSync(link);
      removed.push(link);
    } catch (error) { errors.push({ path: link, error: error.message }); }
  }
  return { ok: errors.length === 0, removed, errors };
}
