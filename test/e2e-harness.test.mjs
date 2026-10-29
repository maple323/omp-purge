/**
 * E2E harness 自检（node --test）。
 *
 * 目的：保证 scripts/e2e-omp.mjs 存在、语法合法、check-only 路径可运行，且扩展入口
 * 仍默认导出一个工厂函数。
 *
 * 安全边界：本测试文件绝不发起真实模型调用；只运行 `--check-only`。如果机器上找不到
 * omp 二进制，相关用例标记为 SKIP 而不是 FAIL。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "e2e-omp.mjs");

/** 与 e2e-omp.mjs 一致的二进制定位（找到返回路径，找不到返回 null）。 */
function locateOmp() {
  const candidates = [];
  if (process.env.OMP_BIN && process.env.OMP_BIN.trim()) candidates.push(process.env.OMP_BIN.trim());

  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(whichCmd, ["omp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 15_000,
    });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) candidates.push(first);
  } catch {
    /* PATH 上找不到 omp 是正常情况 */
  }

  const bunBin = path.join(os.homedir(), ".bun", "bin");
  for (const name of ["omp", "omp.exe", "omp.bunx"]) candidates.push(path.join(bunBin, name));

  const seen = new Set();
  for (const fp of candidates) {
    const key = process.platform === "win32" ? fp.toLowerCase() : fp;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.existsSync(fp)) return fp;
    } catch {
      /* 忽略不可访问的路径 */
    }
  }
  return null;
}

test("scripts/e2e-omp.mjs 存在且是合法 ESM", () => {
  assert.ok(fs.existsSync(SCRIPT), `missing harness script: ${SCRIPT}`);
  const size = fs.statSync(SCRIPT).size;
  assert.ok(size > 0, `harness script is empty: ${SCRIPT}`);

  const res = spawnSync(process.execPath, ["--check", SCRIPT], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(res.status, 0, `node --check failed:\n${res.stderr || res.stdout}`);
});

test("扩展入口 index.ts 默认导出工厂函数", async () => {
  const mod = await import(new URL("../index.ts", import.meta.url).href);
  assert.equal(typeof mod.default, "function", "index.ts must default-export a factory function");
});

test("e2e-omp.mjs --check-only 可运行（无模型调用）", (t) => {
  const bin = locateOmp();
  if (!bin) {
    t.skip("omp binary not found");
    return;
  }

  const res = spawnSync(process.execPath, [SCRIPT, "--check-only"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, OMP_E2E_QUIET: "1", OMP_E2E_CHECK_ONLY: "1" },
  });
  const combined = `${res.stdout || ""}\n${res.stderr || ""}`;

  assert.equal(res.status, 0, `check-only exited ${res.status}:\n${combined}`);
  assert.match(combined, /RESULT:\s+(PASS|SKIP)/, `missing RESULT line:\n${combined}`);
});
