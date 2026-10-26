/**
 * 角色路由：从 OMP 的当前 model 反推 role，用于按 role 换 prompt。
 *
 * OMP 的 ExtensionContext 没有 role 字段（只有 ctx.model / ctx.models）。这里：
 *   1. 用配置 modelRoles 把 model id 子串映射到 role；
 *   2. 兼容 OMP 启动 flag 语义（--plan/--slow/--smol 常对应 role），读环境变量兜底；
 *   3. 都判不出时用 "default"。
 */
import type { PurgeConfig } from "./config.ts";

export const KNOWN_ROLES = [
  "default", "smol", "slow", "plan", "commit", "vision", "task", "advisor", "tiny",
] as const;
export type Role = (typeof KNOWN_ROLES)[number] | string;

interface MinimalModel {
  id?: string;
  name?: string;
  model?: string;
  provider?: string;
}

function modelIdOf(model: unknown): string {
  const m = (model || {}) as MinimalModel;
  return String(m.id || m.name || m.model || "").toLowerCase();
}

export function resolveRole(ctx: { model?: unknown } | null | undefined, cfg: PurgeConfig): Role {
  const id = modelIdOf(ctx?.model);
  if (id) {
    // 精确：modelRoles 里配置的映射优先。
    for (const [role, needle] of Object.entries(cfg.modelRoles || {})) {
      if (!needle) continue;
      if (id.includes(String(needle).toLowerCase())) return role;
    }
    // 约定：模型 id 里含某 role 名（如 "...-plan"）时也认。
    for (const role of KNOWN_ROLES) {
      if (role !== "default" && id.includes(role)) return role;
    }
  }
  // 环境变量兜底（OMP 启动 flag 常见）。
  const env = (process.env.OMP_ROLE || process.env.PI_ROLE || "").trim().toLowerCase();
  if (env) return env;
  if (process.env.OMP_PLAN === "1" || process.env.PI_PLAN === "1") return "plan";
  return "default";
}
