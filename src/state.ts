/**
 * 会话状态：`/purge` 的开关、模式、提示词来源。
 *
 * 与 pi-purge 一致的语义：**每个 session_start 重置**，不落盘、无缓存文件。
 * 唯一的持久化是配置（`<cwd>/.omp/purge/config.json` / `<agentDir>/purge/config.json`）。
 */
import type { PurgeMode } from "./mode.ts";
import { isPurgeMode } from "./mode.ts";
import type { PurgeConfig } from "./config.ts";

export type PurgeSourceKind = "chain" | "file" | "embedded";

export interface PurgeLastChange {
  applied: boolean;
  effectiveMode: PurgeMode;
  injectedBytes: number;
  strippedLines: number;
  /** replace 未命中身份段而回退时的一句话。 */
  note?: string;
}

export interface PurgeSessionState {
  enabled: boolean;
  mode: PurgeMode;
  sourceKind: PurgeSourceKind;
  /** sourceKind === "file" 时的绝对/相对路径。 */
  sourcePath: string | null;
  /** 上次解析出的正文（供 status 展示字节数）。 */
  sourceText: string;
  sourceResolvedFrom: string;
  /** 当前 session 的 role（由 ctx.model 反推）。 */
  role: string;
  lastChange: PurgeLastChange | null;
}

/** 由配置 + CLI flag 初始化会话状态。 */
export function createSessionState(cfg: PurgeConfig, overrides: { mode?: unknown; source?: unknown } = {}): PurgeSessionState {
  const mode = isPurgeMode(overrides.mode) ? overrides.mode : isPurgeMode(cfg.mode) ? cfg.mode : "append";
  const rawSource = typeof overrides.source === "string" && overrides.source.trim() ? overrides.source.trim() : cfg.source;
  let sourceKind: PurgeSourceKind = "chain";
  let sourcePath: string | null = null;
  if (typeof rawSource === "string" && rawSource.trim()) {
    const s = rawSource.trim();
    if (s === "chain") sourceKind = "chain";
    else if (s === "embedded") sourceKind = "embedded";
    else {
      sourceKind = "file";
      sourcePath = s;
    }
  }
  return {
    enabled: cfg.enabled !== false,
    mode,
    sourceKind,
    sourcePath,
    sourceText: "",
    sourceResolvedFrom: "unresolved",
    role: "default",
    lastChange: null,
  };
}

/** 进行一次「有效变更」记录。 */
export function recordChange(
  state: PurgeSessionState,
  change: PurgeLastChange,
): void {
  state.lastChange = change;
}