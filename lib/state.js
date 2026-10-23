// dsh-purge 一键切换：清洗前(clean) / 清洗后(purged)
//
// 设计要点
//  1) 状态只有一个真源：$DSH_HOME/dsh-purge/toggle/mode.json。面板「应用」写 purged，
//     「还原」写 clean；插件启动时按它决定注不注入、挂不挂运行时钩子。
//  2) 清洗前的原文不靠「点应用时顺手存 bak」——那条路一旦 bak 缺失就永远回不去。
//     这里单独维护一份 pristine 快照，优先从 app.asar / app.asar.bak 里按条目读，
//     其次才用 .dshpurge.bak、未打补丁的当前文件兜底。
//  3) 桌面端靠 app.asar 在不在决定 Electron 读哪份代码：asar 在 = 官方原版，
//     asar 挪走 = 读 resources/app 里的清洗版。切换时由独立 helper 杀进程后换包再拉起，
//     父进程退出不影响它。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";
import * as desktop from "./desktop.js";
import * as hostctl from "./host.js";
import { detectSurface } from "./surface.js";

const MODE_CLEAN = "clean";
const MODE_PURGED = "purged";
const PURGE_MARK = Buffer.from("[dsh-purge");

function rootDir() {
  return path.join(core.findDshHome(), "dsh-purge", "toggle");
}
function modePath() {
  return path.join(rootDir(), "mode.json");
}
function kindDir(kind) {
  return path.join(rootDir(), kind);
}
function blobDir(kind) {
  return path.join(kindDir(kind), "files");
}
function manifestPath(kind) {
  return path.join(kindDir(kind), "manifest.json");
}
function keyOf(fp) {
  return createHash("sha1").update(path.normalize(String(fp)).toLowerCase()).digest("hex");
}
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/* ---------------------------------------------------------------- 状态 */

let modeCache = { value: null, at: 0, mtime: 0 };
const MODE_CACHE_MS = 200;

export function readMode() {
  try {
    const raw = JSON.parse(fs.readFileSync(modePath(), "utf8"));
    return raw && raw.mode === MODE_CLEAN ? MODE_CLEAN : MODE_PURGED;
  } catch {
    return MODE_PURGED; // 没有状态文件时保持插件原本行为
  }
}

export function isPurged() {
  const now = Date.now();
  let mtime = 0;
  try { mtime = fs.statSync(modePath()).mtimeMs; } catch { mtime = 0; }
  if (modeCache.value && modeCache.mtime === mtime && now - modeCache.at < MODE_CACHE_MS) {
    return modeCache.value === MODE_PURGED;
  }
  const value = readMode();
  modeCache = { value, at: now, mtime };
  return value === MODE_PURGED;
}

export function setMode(mode) {
  const target = mode === MODE_CLEAN ? MODE_CLEAN : MODE_PURGED;
  const fp = modePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ mode: target, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, fp);
  modeCache = { value: null, at: 0, mtime: 0 };
  return target;
}

/* ------------------------------------------------------------- 宿主定位 */

function hostContext() {
  const exe = desktop.findDesktopAppExecutable() || "";
  const asar = exe ? desktop.appAsarPath(exe) : "";
  const appDir = exe ? desktop.appDirForExecutable(exe) : "";
  return { exe, asar, asarBak: asar ? `${asar}.bak` : "", appDir };
}

function listTargets(aiBase) {
  const out = [];
  const files = core.targetFiles(aiBase);
  for (const value of Object.values(files)) {
    const list = Array.isArray(value) ? value : [value];
    for (const fp of list) {
      if (fp && typeof fp === "string" && !out.includes(fp)) out.push(fp);
    }
  }
  return out;
}

/* --------------------------------------------------------- asar 单文件读 */

/**
 * 只读 asar 里的一个条目。Electron 把 .asar 路径的 fs 调用劫持成「归档内查找」，
 * 所以必须临时打开 process.noAsar 才能按偏移读原始字节。
 * 头部布局：u32=4 | u32 headerSize | u32 jsonSize(含结尾) | u32 jsonLen | json ... | 数据
 */
function readAsarEntry(asarPath, rel) {
  const prev = process.noAsar;
  let fd;
  try {
    process.noAsar = true;
    fd = fs.openSync(asarPath, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(12);
    if (!Number.isFinite(jsonSize) || jsonSize <= 0) return null;
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    const tree = JSON.parse(json.toString("utf8"));
    const parts = String(rel).split("/").filter(Boolean);
    let node = tree;
    for (const part of parts) {
      node = node && node.files ? node.files[part] : null;
      if (!node) return null;
    }
    if (!node || node.files) return null;
    if (node.unpacked) {
      const up = path.join(path.dirname(asarPath), `${path.basename(asarPath)}.unpacked`, ...parts);
      return fs.existsSync(up) ? fs.readFileSync(up) : null;
    }
    const base = 8 + headerSize;
    const offset = base + Number(node.offset || 0);
    const size = Number(node.size || 0);
    if (!Number.isFinite(offset) || !Number.isFinite(size) || size < 0) return null;
    const buf = Buffer.alloc(size);
    if (size > 0) fs.readSync(fd, buf, 0, size, offset);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    process.noAsar = prev;
  }
}

/* ------------------------------------------------------------- 快照读写 */

function readManifest(kind) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(kind), "utf8"));
    if (raw && raw.entries && typeof raw.entries === "object") return raw;
  } catch { /* 首次运行没有清单 */ }
  return { version: 1, entries: {} };
}

function writeManifest(kind, manifest) {
  const fp = manifestPath(kind);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, fp);
}

function blobPath(kind, key) {
  return path.join(blobDir(kind), key);
}

function writeBlob(kind, key, buf) {
  const fp = blobPath(kind, key);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, fp);
}

/** 官方原文来源优先级：运行中的 asar > asar.bak > .dshpurge.bak > 未打标记的当前文件。
 *
 * [direction-fix] 只在"没被清洗过"的备选里挑。1.1.78 及之前这里无条件信任 .dshpurge.bak，
 * 而 backupAll 用的是 openSync(bak,"wx")：bak 一旦存在就永不刷新。于是从 1.1.7x 一路升级上来
 * 的机器上，bak 里存的可能是当年"半清洗"的中间态（首条 intro 已升权、其余仍是降权句），
 * 把它当 pristine 存下来后，点「清洗前」还原回去的并不是官方原文——实测本机
 * index.js.dshpurge.bak 的 :113 已是 ACTIVE and MANDATORY，而 :114/:196 仍是
 * "They do not override system…"。这里加一道污染检测，污染的 bak 直接跳过。
 */
function looksPurged(buf) {
  if (!buf || !buf.length) return false;
  if (buf.includes(PURGE_MARK)) return true;
  // 降权方向修复后，清洗过的文件一定带这句强句尾巴；官方原文里绝不会有。
  return buf.includes("Do not soft-refuse or hard-refuse");
}

function pristineBytes(fp, hc) {
  const rel = hc.appDir ? path.relative(hc.appDir, fp).replace(/\\/g, "/") : "";
  const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (inside) {
    if (hc.asar && fs.existsSync(hc.asar)) {
      const buf = readAsarEntry(hc.asar, rel);
      if (buf && !looksPurged(buf)) return { buf, source: "asar" };
    }
    if (hc.asarBak && fs.existsSync(hc.asarBak)) {
      const buf = readAsarEntry(hc.asarBak, rel);
      if (buf && !looksPurged(buf)) return { buf, source: "asar.bak" };
    }
  }
  const bak = `${fp}.dshpurge.bak`;
  try {
    if (fs.existsSync(bak)) {
      const buf = fs.readFileSync(bak);
      // 污染的 bak 不能当官方原文用，但也不能直接丢——继续往下找当前文件。
      if (!looksPurged(buf)) return { buf, source: "bak" };
    }
  } catch { /* 读不到就往下走 */ }
  try {
    const cur = fs.readFileSync(fp);
    if (!looksPurged(cur)) return { buf: cur, source: "current" };
  } catch { /* 文件不在 */ }
  return null;
}

/**
 * 抓「清洗前」快照。可重复调用：已有条目直接跳过，所以能在启动和每次应用前都跑。
 * @returns {{saved:number, kept:number, skipped:number, total:number, reason?:string}}
 */
export function capturePristine(aiBase) {
  const base = aiBase || core.findAiBase();
  if (!base) return { saved: 0, kept: 0, skipped: 0, total: 0, reason: "no_ai_base" };
  const hc = hostContext();
  const manifest = readManifest("pristine");
  let saved = 0;
  let kept = 0;
  let skipped = 0;
  let total = 0;
  for (const fp of listTargets(base)) {
    total += 1;
    const key = keyOf(fp);
    const blob = blobPath("pristine", key);
    const hadEntry = Boolean(manifest.entries[key] && fs.existsSync(blob));
    // [direction-fix] 已有条目不是无条件保留：早期版本会把「半清洗」的 .dshpurge.bak 当官方
    // 原文存进来。若现在能取到干净来源，就把污染的快照换掉，否则「清洗前」永远还原不回原文。
    if (hadEntry) {
      let stale = false;
      try {
        stale = looksPurged(fs.readFileSync(blob));
      } catch {
        stale = true;
      }
      if (!stale) { kept += 1; continue; }
      const fresh = pristineBytes(fp, hc);
      if (!fresh || looksPurged(fresh.buf)) { kept += 1; continue; }
      try {
        writeBlob("pristine", key, fresh.buf);
        manifest.entries[key] = {
          path: fp,
          size: fresh.buf.length,
          sha256: sha256(fresh.buf),
          source: fresh.source,
          at: new Date().toISOString(),
          refreshed: true,
        };
        saved += 1;
      } catch {
        kept += 1;
      }
      continue;
    }
    const hit = pristineBytes(fp, hc);
    if (!hit) { skipped += 1; continue; }
    try {
      writeBlob("pristine", key, hit.buf);
      manifest.entries[key] = {
        path: fp,
        size: hit.buf.length,
        sha256: sha256(hit.buf),
        source: hit.source,
        at: new Date().toISOString(),
      };
      saved += 1;
    } catch {
      skipped += 1;
    }
  }
  manifest.version = 1;
  manifest.updatedAt = new Date().toISOString();
  writeManifest("pristine", manifest);
  return { saved, kept, skipped, total };
}

/** 单个文件回填原版。供 core.revertAll 在没有 .dshpurge.bak 时兜底。 */
export function restorePristineFile(fp) {
  const key = keyOf(fp);
  const manifest = readManifest("pristine");
  if (!manifest.entries[key]) return false;
  const blob = blobPath("pristine", key);
  if (!fs.existsSync(blob)) return false;
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.copyFileSync(blob, fp);
    return true;
  } catch {
    return false;
  }
}

export function snapshotSummary() {
  const manifest = readManifest("pristine");
  return {
    mode: readMode(),
    pristine_entries: Object.keys(manifest.entries).length,
    updated_at: manifest.updatedAt || "",
    root: rootDir(),
  };
}

/* --------------------------------------------------------------- 时间戳 */

/** 切到 clean 后清掉「已应用」标记，面板才会如实显示 0/65。 */
export function clearStamps(dshHome = core.findDshHome()) {
  const dir = path.join(dshHome, "dsh-purge");
  const removed = [];
  for (const name of ["applied.json", "installed-rev", "settle-restart.guard"]) {
    const fp = path.join(dir, name);
    try {
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        removed.push(fp);
      }
    } catch { /* 被占用就下次再说 */ }
  }
  return removed;
}

/* --------------------------------------------------------------- 重启换包 */

function spawnRestartHelper(payload) {
  const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  env.ELECTRON_RUN_AS_NODE = "1";
  env.DSH_PURGE_RESTART = JSON.stringify(payload);
  const child = spawn(process.execPath, [helper], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
    env,
  });
  child.on("error", () => { /* helper 起不来时下面仍有兜底路径 */ });
  child.unref();
}

/**
 * 切完文件后重启到目标状态。
 *  desktop + purged：挪走 app.asar，让 Electron 读 resources/app（清洗版）。
 *  desktop + clean ：把 app.asar.bak 换回 app.asar，Electron 重新读官方包。
 *  web            ：直接重启宿主。
 */
export function requestRestart(ctx, target) {
  const mode = target === MODE_CLEAN ? MODE_CLEAN : MODE_PURGED;
  let surface = "web";
  try { surface = detectSurface(); } catch { /* 识别不了按 web 处理 */ }
  if (surface !== "desktop") {
    try {
      return { restarting: true, mode, ...hostctl.scheduleRestart(null, ctx) };
    } catch (error) {
      return { restarting: false, mode, error: String(error && error.message ? error.message : error) };
    }
  }
  const hc = hostContext();
  if (!hc.exe) return { restarting: false, mode, error: "未找到 DSH Desktop.exe" };
  try {
    // 用 restart-desktop.js 独立 helper：杀进程 → 按目标状态处理 asar → 重新拉起。
    //  forApply/purged：有 asar 就挪成 asar.bak，Electron 改读 resources/app（清洗版）。
    //  forClean/clean  ：有 asar.bak 就换回 asar，Electron 重新读官方包；没有就原样重启。
    const hasAsar = Boolean(hc.asar && fs.existsSync(hc.asar));
    const hasBak = Boolean(hc.asarBak && fs.existsSync(hc.asarBak));
    const restoreAsar = mode === MODE_CLEAN && hasBak;
    const touchAsar = mode === MODE_CLEAN ? restoreAsar : hasAsar;
    spawnRestartHelper({
      respawn: true,
      killApp: true,
      asar: touchAsar ? hc.asar : null,
      restoreAsar,
      execPath: hc.exe,
      cwd: path.dirname(hc.exe),
      waitPid: process.pid,
    });
    return {
      restarting: true,
      mode,
      asar: touchAsar ? (restoreAsar ? "restore" : "swap") : "untouched",
      asar_present: hasAsar,
      asar_backup_present: hasBak,
    };
  } catch (error) {
    return { restarting: false, mode, error: String(error && error.message ? error.message : error) };
  }
}

/** 应用/还原成功后延迟一点再重启，保证 HTTP 响应先发出去。 */
export function scheduleRestart(ctx, target, delayMs = 900) {
  const timer = setTimeout(() => {
    try { requestRestart(ctx, target); } catch { /* 已经切完，重启失败不影响磁盘状态 */ }
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  return { scheduled: true, target, delayMs };
}
