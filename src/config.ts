/**
 * 配置：项目 <cwd>/.omp/purge/config.json 覆盖 用户 <agentDir>/purge/config.json 覆盖默认。
 * 另可由 CLI flag（registerFlag）强制关停。
 */
import { agentDir, projectOmpDir, readText } from "./paths.ts";
import path from "node:path";
import type { PurgeMode } from "./mode.ts";

export interface PurgeConfig {
  enabled: boolean;
  /** 启动时把哪条规则同步到 <project>/.omp/AGENTS.md（空=不自动同步）。 */
  activeRule: string | null;
  /** 默认合成模式（可被 /purge mode 与 --purge-mode 覆盖）。 */
  mode: PurgeMode;
  /** 默认提示词来源：`chain` | `embedded` | 文件路径（可被 /purge source 覆盖）。 */
  source: string;
  /** 按模型 role 覆盖提示词；键为 role 名（default/smol/slow/plan/...），"*" 为兜底。 */
  rolePrompts: Record<string, string>;
  /** role → 模型 id 子串 的映射，用于从 ctx.model 反推 role。 */
  modelRoles: Record<string, string>;
  /** 是否附上「能力选用协议」段。 */
  capabilityProtocol: boolean;
  /** 网络门禁开关。 */
  gate: boolean;
  verbose: boolean;
}

export const DEFAULT_CONFIG: PurgeConfig = {
  enabled: true,
  activeRule: null,
  mode: "append",
  source: "chain",
  rolePrompts: {},
  modelRoles: {},
  capabilityProtocol: true,
  gate: true,
  verbose: false,
};

function readJson(fp: string): Partial<PurgeConfig> {
  try {
    const parsed = JSON.parse(readText(fp));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function userConfigPath(): string {
  return path.join(agentDir(), "purge", "config.json");
}
export function projectConfigPath(cwd: string): string {
  return path.join(projectOmpDir(cwd), "purge", "config.json");
}

export function loadConfig(cwd: string): PurgeConfig {
  const user = readJson(userConfigPath());
  const project = readJson(projectConfigPath(cwd));
  const merged: PurgeConfig = {
    ...DEFAULT_CONFIG,
    ...user,
    ...project,
    rolePrompts: { ...(user.rolePrompts || {}), ...(project.rolePrompts || {}) },
    modelRoles: { ...(user.modelRoles || {}), ...(project.modelRoles || {}) },
  };
  return merged;
}
