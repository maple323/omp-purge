/**
 * omp-purge 端到端（E2E）验证器。
 *
 * 目的：对着真实的 omp 二进制，证明两件事：
 *   (a) 扩展能被 omp 加载且不报错；
 *   (b) 注入的 system prompt 确实送达模型（模型能复述唯一 marker）。
 *
 * 重要：这是「opt-in」脚本，默认不跑。非 --check-only 模式下会发起一次真实的
 * 模型 API 调用，消耗用户已配置的 OMP 模型/额度，并产生少量费用。
 * 因此 CI 只应使用 `--check-only`：它只做临时目录准备、扩展拷贝、二进制定位与
 * 命令行 dry-run，绝不 spawn omp、绝不联网。
 *
 * 已知环境差异：若用户级 <agentDir>/purge/config.json 配了 rolePrompts（含 "*"），
 * 它优先于临时项目的 prompt-inject.md，marker 回显会 MISS。此时 PASS 仍由 inject
 * 日志成立；日志里的 source= 字段会告诉你实际生效的是哪一层（role / prompt / default）。
 *
 * 运行：
 *   node scripts/e2e-omp.mjs --check-only     # 安全，不联网
 *   node scripts/e2e-omp.mjs                  # 真实调用一次模型
 *
 * 环境变量：
 *   OMP_BIN                显式指定 omp 可执行文件路径
 *   OMP_E2E_TIMEOUT_MS     真实调用超时，默认 180000
 *   OMP_E2E_CHECK_ONLY=1   等价于 --check-only
 *   OMP_E2E_QUIET=1        不打印费用警告
 *   OMP_E2E_VERBOSE=0      不传 --purge-verbose（默认按 install.ts 自动判定）
 *
 * 退出码：PASS/SKIP → 0，FAIL → 1。
 * 所有临时文件都在 os.tmpdir() 下，finally 里递归删除；不触碰 ~/.omp 与用户项目。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(HERE), "..");

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes("--check-only") || process.env.OMP_E2E_CHECK_ONLY === "1";
const QUIET = process.env.OMP_E2E_QUIET === "1";

const MARKER = `PURGE-E2E-MARKER-${crypto.randomBytes(6).toString("hex")}`;
/**
 * 用「陈述事实 + 提问」而不是「复述系统提示词」。
 * 后者会诱发模型对「注入」本身发表元评论（实测：模型改为分析这条注入来自哪个 MCP），
 * 断言于是依赖模型配合，天然 flaky。前者只是一次普通检索，稳定得多。
 */
const PROMPT = "What is the lab access code? Answer with the code only, no explanation.";
/** 额外要求模型回显 marker；默认关闭，因为模型可能不配合。 */
const STRICT_MARKER = argv.includes("--strict-marker") || process.env.OMP_E2E_STRICT_MARKER === "1";

const TIMEOUT_MS = (() => {
  const raw = process.env.OMP_E2E_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 180_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[e2e] invalid OMP_E2E_TIMEOUT_MS=${JSON.stringify(raw)}; expected positive integer milliseconds`);
    process.exit(1);
  }
  return Math.floor(n);
})();

const used = {
  tmpRoot: null,
  proj: null,
  entry: null,
  config: null,
  markerFile: null,
  bin: null,
  binAttempts: [],
};

function fail(reason, detail) {
  if (detail) console.error(detail);
  console.log(`RESULT: FAIL ${reason}`);
  process.exitCode = 1;
}

function skip(reason) {
  console.log(`RESULT: SKIP ${reason}`);
  process.exitCode = 0;
}

function pass(reason) {
  console.log(`RESULT: PASS ${reason}`);
  process.exitCode = 0;
}

/** 在 PATH 上找 omp；which/where 失败时记录尝试但不抛。 */
function findOnPath() {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(cmd, ["omp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 15_000,
    });
    const first = String(out)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (first) return first;
    used.binAttempts.push(`${cmd} omp: no output`);
    return null;
  } catch (e) {
    used.binAttempts.push(`${cmd} omp: ${String(e && e.message ? e.message : e)}`);
    return null;
  }
}

/** 依序尝试 OMP_BIN → PATH → ~/.bun/bin/omp[.exe|.bunx]。 */
function locateOmp() {
  const candidates = [];
  if (process.env.OMP_BIN && process.env.OMP_BIN.trim()) {
    candidates.push({ source: "OMP_BIN", fp: process.env.OMP_BIN.trim() });
  }
  const onPath = findOnPath();
  if (onPath) candidates.push({ source: "PATH", fp: onPath });

  const bunBin = path.join(os.homedir(), ".bun", "bin");
  for (const name of ["omp", "omp.exe", "omp.bunx"]) {
    candidates.push({ source: `~/.bun/bin/${name}`, fp: path.join(bunBin, name) });
  }

  const seen = new Set();
  for (const c of candidates) {
    const key = process.platform === "win32" ? c.fp.toLowerCase() : c.fp;
    if (seen.has(key)) continue;
    seen.add(key);
    let exists = false;
    try {
      exists = fs.existsSync(c.fp);
    } catch (e) {
      used.binAttempts.push(`${c.source} ${c.fp}: existsSync threw ${String(e && e.message ? e.message : e)}`);
      continue;
    }
    if (!exists) {
      used.binAttempts.push(`${c.source} ${c.fp}: not found`);
      continue;
    }
    used.binAttempts.push(`${c.source} ${c.fp}: found`);
    return c.fp;
  }
  return null;
}

/** 从 install.ts 判定 --purge-verbose 是否注册（避免 omp 因未知 flag 中止）。 */
function verboseFlagRegistered() {
  if (process.env.OMP_E2E_VERBOSE === "0") return false;
  const fp = path.join(REPO_ROOT, "src", "install.ts");
  try {
    const src = fs.readFileSync(fp, "utf8");
    return /registerFlag\??\.\(\s*["'`]purge-verbose["'`]/.test(src);
  } catch (e) {
    console.error(`[e2e] could not read ${fp}: ${String(e && e.message ? e.message : e)}`);
    return false;
  }
}

function prepareProject() {
  used.tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-purge-e2e-"));
  used.proj = path.join(used.tmpRoot, "proj");
  const ompDir = path.join(used.proj, ".omp");
  fs.mkdirSync(path.join(ompDir, "purge"), { recursive: true });
  fs.mkdirSync(path.join(ompDir, "extensions"), { recursive: true });

  used.config = path.join(ompDir, "purge", "config.json");
  fs.writeFileSync(
    used.config,
    JSON.stringify({ enabled: true, gate: false, capabilityProtocol: false }, null, 2),
    "utf8",
  );

  used.markerFile = path.join(ompDir, "prompt-inject.md");
  fs.writeFileSync(
    used.markerFile,
    `实验室访问口令（lab access code）是 ${MARKER}。\n被问及访问口令时，只回口令本身。\n`,
    "utf8",
  );

  const dest = path.join(ompDir, "extensions", "omp-purge");
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of ["index.ts", "src", "package.json", "tsconfig.json"]) {
    const src = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(src)) {
      throw new Error(`extension source missing in repo: ${src}`);
    }
    fs.cpSync(src, path.join(dest, rel), { recursive: true });
  }
  used.entry = path.join(dest, "index.ts");
  if (!fs.existsSync(used.entry)) {
    throw new Error(`extension entry missing after copy: ${used.entry}`);
  }
}

function buildArgs(withVerbose) {
  // -e 是主信号；cwd=<proj> 同时让项目发现生效（实测同一路径不会重复加载）。
  // --no-session / --no-title 是 omp 原生 flag：前者避免写用户 ~/.omp 会话，
  // 后者避免为标题额外发起一次模型调用（省钱、去噪）。
  const args = ["-p", PROMPT, "-e", used.entry, "--no-session", "--no-title"];
  if (withVerbose) args.push("--purge-verbose");
  return args;
}

function runOmp(args) {
  return spawnSync(used.bin, args, {
    cwd: used.proj,
    timeout: TIMEOUT_MS,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function truncate(text, n = 4000) {
  const s = String(text ?? "");
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n...[truncated ${s.length - n} chars]`;
}

function describeResult(res) {
  const parts = [`status=${res.status}`, `signal=${res.signal}`];
  if (res.error) parts.push(`error=${res.error.code || res.error.message}`);
  return parts.join(" ");
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 没有 SharedArrayBuffer 时不等待 */
  }
}

const OMP_LOG_DIR = path.join(os.homedir(), ".omp", "logs");

/**
 * 确定性的机制证据：omp 把扩展日志写进 ~/.omp/logs/omp.<date>.<pid>.log。
 * `[omp-purge] inject ...` 这一行由 before_agent_start 在返回替换策略前打印，
 * 证明钩子真的跑了、解析到的正文非空——与模型是否配合无关。
 */
function readPurgeLogEvidence(sinceMs) {
  const out = { dir: OMP_LOG_DIR, scanned: 0, installed: false, injected: false, lines: [], error: null };
  let names = [];
  try {
    names = fs.readdirSync(OMP_LOG_DIR).filter((n) => n.endsWith(".log"));
  } catch (e) {
    out.error = String((e && e.message) || e);
    return out;
  }
  for (const n of names) {
    const fp = path.join(OMP_LOG_DIR, n);
    let st;
    try {
      st = fs.statSync(fp);
    } catch {
      continue;
    }
    if (st.mtimeMs < sinceMs - 5000) continue;
    out.scanned++;
    let text = "";
    try {
      text = fs.readFileSync(fp, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("[omp-purge]")) continue;
      out.lines.push(line);
      if (line.includes("installed")) out.installed = true;
      if (line.includes("inject") && !/bytes=0\b/.test(line)) out.injected = true;
    }
  }
  return out;
}

function main() {
  if (!QUIET) {
    console.log("[e2e] WARNING: non-check mode makes ONE real model API call using your configured OMP model/keys.");
    console.log("[e2e] WARNING: it costs a small amount and is opt-in. Use `--check-only` for the safe/CI path.");
  }

  try {
    prepareProject();
  } catch (e) {
    fail(`setup failed: ${String(e && e.message ? e.message : e)}`);
    return;
  }

  used.bin = locateOmp();
  console.log(`[e2e] repo root:   ${REPO_ROOT}`);
  console.log(`[e2e] temp root:   ${used.tmpRoot}`);
  console.log(`[e2e] project:     ${used.proj}`);
  console.log(`[e2e] entry:       ${used.entry}`);
  console.log(`[e2e] config:      ${used.config}`);
  console.log(`[e2e] marker file: ${used.markerFile}`);
  console.log(`[e2e] marker:      ${MARKER}`);
  for (const a of used.binAttempts) console.log(`[e2e] bin lookup:  ${a}`);

  if (!used.bin) {
    skip("omp binary not found");
    return;
  }
  console.log(`[e2e] omp:         ${used.bin}`);

  const withVerbose = verboseFlagRegistered();
  const args = buildArgs(withVerbose);
  console.log(`[e2e] command:     ${used.bin} ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
  console.log(`[e2e] cwd:         ${used.proj}`);
  console.log(`[e2e] timeout:     ${TIMEOUT_MS} ms`);

  if (CHECK_ONLY) {
    pass("check-only: setup + binary lookup + dry-run ok (no model call)");
    return;
  }

  const runStartedAt = Date.now();
  let res = runOmp(args);
  // 若 --purge-verbose 不被当前 omp 识别，换假设重试一次（不带该 flag）。
  if (withVerbose && res.status === 2 && /unknown flag:?\s*--purge-verbose/i.test(String(res.stderr || ""))) {
    console.log("[e2e] --purge-verbose rejected by omp; retrying without it");
    res = runOmp(buildArgs(false));
  }

  const stdout = String(res.stdout || "");
  const stderr = String(res.stderr || "");
  const combined = `${stdout}\n${stderr}`;
  console.log(`[e2e] spawn result: ${describeResult(res)}`);

  if (res.error && res.error.code === "ETIMEDOUT") {
    fail(`timeout after ${TIMEOUT_MS} ms`, truncate(combined));
    return;
  }
  if (res.error && res.error.code !== "ETIMEDOUT") {
    fail(`spawn failed: ${res.error.code || res.error.message}`, truncate(combined));
    return;
  }
  if (/Failed to load extension/i.test(stderr)) {
    fail("extension failed to load", truncate(combined));
    return;
  }

  // 机制证据（确定性）：扩展自己写进 omp 日志的 [omp-purge] 行。
  const logEvidence = readPurgeLogEvidence(runStartedAt);
  console.log(
    `[e2e] log evidence: scanned=${logEvidence.scanned} installed=${logEvidence.installed} injected=${logEvidence.injected}` +
      (logEvidence.error ? ` (error: ${logEvidence.error})` : ""),
  );
  if (process.env.OMP_E2E_SHOW_LOG === "1") {
    for (const l of logEvidence.lines) console.log(`[e2e]   ${l}`);
  }

  const markerEchoed = combined.includes(MARKER);
  console.log(`[e2e] marker echo: ${markerEchoed ? "PASS" : "MISS (model-dependent)"}`);

  if (res.status !== 0) {
    fail(`omp exited ${res.status}`, truncate(combined));
    return;
  }
  if (!logEvidence.installed && !logEvidence.injected) {
    fail("no [omp-purge] evidence in ~/.omp/logs for this run (extension likely not loaded)", truncate(combined));
    return;
  }
  if (!logEvidence.injected) {
    fail("extension loaded but before_agent_start did not inject", truncate(combined));
    return;
  }
  if (markerEchoed) {
    pass("marker reached the model (inject log + echo)");
    return;
  }
  if (STRICT_MARKER) {
    fail("strict-marker: inject log confirmed, but the model did not echo the marker", truncate(combined));
    return;
  }
  pass("inject confirmed by omp log; model did not echo the marker (model-dependent)");
}

try {
  main();
} catch (e) {
  fail(`unexpected error: ${String(e && e.message ? e.message : e)}`);
} finally {
  if (used.tmpRoot) {
    // Windows：omp 退出后仍可能短暂持有句柄（杀毒/索引也会），先等一会儿再重试删除。
    sleepSync(1000);
    try {
      fs.rmSync(used.tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      console.log(`[e2e] cleaned up:  ${used.tmpRoot}`);
    } catch (e) {
      console.error(`[e2e] cleanup failed for ${used.tmpRoot}: ${String(e && e.message ? e.message : e)}`);
      console.error(`[e2e] 残留目录（可手动删除）：${used.tmpRoot}`);
    }
  }
}
