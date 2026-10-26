/**
 * 路径定位：OMP 的 home / agent dir / 项目 .omp。
 *
 * OMP 约定（已核实 docs/extension-loading.md、docs/config-usage.md）：
 *   - 用户 agent dir:   ~/.omp/agent        （可用 PI_CODING_AGENT_DIR / PI_CONFIG_DIR 覆盖）
 *   - 用户 profile:     ~/.omp/profiles/<name>/agent
 *   - 项目根:           <cwd>/.omp          （cwd-only，不向上走）
 *   - 规则/注入状态一律放在项目 .omp 下，随项目走。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 用户 agent 目录。 */
export function agentDir(): string {
  const explicit = process.env.PI_CODING_AGENT_DIR;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  const profile = process.env.OMP_PROFILE || process.env.PI_PROFILE;
  const root = process.env.PI_CONFIG_DIR
    ? path.resolve(process.env.PI_CONFIG_DIR)
    : path.join(os.homedir(), ".omp");
  if (profile && profile.trim()) return path.join(root, "profiles", profile.trim(), "agent");
  return path.join(root, "agent");
}

/** 项目 .omp 目录（不存在时返回理论路径，不创建）。 */
export function projectOmpDir(cwd: string): string {
  return path.join(path.resolve(cwd || process.cwd()), ".omp");
}

export function rulesDir(cwd: string): string {
  return path.join(projectOmpDir(cwd), "rules");
}

export function promptInjectPath(cwd: string): string {
  return path.join(projectOmpDir(cwd), "prompt-inject.md");
}

export function agentsMdPath(cwd: string): string {
  return path.join(projectOmpDir(cwd), "AGENTS.md");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readText(fp: string): string {
  try {
    return fs.readFileSync(fp, "utf8");
  } catch {
    return "";
  }
}

export function exists(fp: string): boolean {
  try {
    return fs.existsSync(fp);
  } catch {
    return false;
  }
}

/** 原子写：先写临时文件再 rename，避免半写坏。 */
export function atomicWrite(fp: string, text: string): void {
  ensureDir(path.dirname(fp));
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, fp);
}

export function normalizeText(text: unknown): string {
  return String(text ?? "").replace(/\r\n/g, "\n").trim();
}
