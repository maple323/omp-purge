/**
 * `/purge` 命令（概念与子命令面来自 pi-purge；机制挂在 OMP 的 registerCommand 上）。
 *
 * 子命令：
 *   /purge                     切换本会话开关
 *   /purge on | off            显式开关
 *   /purge status              模式 / 来源 / 字节 / 角色 / 上一回合变更
 *   /purge mode <append|replace|strict>
 *   /purge source <path|chain|embedded>
 *   /purge reload              重读外部提示词（编辑后生效）
 *   /purge help
 *
 * 语义与 pi-purge 对齐：**仅本会话有效**，不落盘、无状态文件、不写缓存。
 * 失败切换回滚（source 指向不存在的文件时不改动当前状态）。
 */
import path from "node:path";
import { exists, readText, normalizeText } from "../paths.ts";
import type { PurgeConfig } from "../config.ts";
import type { PurgeSessionState } from "../state.ts";
import { PURGE_MODES, isPurgeMode } from "../mode.ts";

/** 本模块用到的宿主最小结构面（与 src/install.ts 一致，避免循环导入）。 */
export interface PurgeCommandHost {
  registerCommand(
    name: string,
    options: {
      description?: string;
      getArgumentCompletions?: (partial: string) => string[] | undefined;
      handler: (args: string, ctx: any) => Promise<void> | void;
    },
  ): void;
}

export interface PurgeCommandDeps {
  state: PurgeSessionState;
  cwdOf: (ctx: unknown) => string;
  loadConfig: (cwd: string) => PurgeConfig;
  /** 解析注入链正文（role > project prompt-inject.md > 密封默认槽）。 */
  resolveSourceText: (cwd: string, role: string, cfg: PurgeConfig) => { text: string; from: string };
  /** 内置密封默认槽正文。 */
  embeddedText: () => string;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

const SUBCOMMANDS = ["on", "off", "status", "mode", "source", "reload", "help"];

const HELP = [
  "/purge                     切换本会话开关",
  "/purge on | off            显式开关",
  "/purge status              模式 / 来源 / 字节 / 角色 / 上一回合变更",
  "/purge mode <append|replace|strict>",
  "/purge source <path|chain|embedded>",
  "/purge reload              重读外部提示词",
  "/purge help",
].join("\n");

function notify(ctx: any, deps: PurgeCommandDeps, msg: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    if (ctx && ctx.ui && typeof ctx.ui.notify === "function") {
      ctx.ui.notify(msg, level);
      return;
    }
  } catch {
    /* UI 不可用（print / headless）时落回 log */
  }
  if (level === "error") deps.warn(msg);
  else deps.log(msg);
}

function parseArgs(raw: string): { verb: string; rest: string[] } {
  const parts = String(raw || "").trim().split(/\s+/).filter(Boolean);
  return { verb: (parts[0] || "").toLowerCase(), rest: parts.slice(1) };
}

/** 把当前来源解析进 state（不抛）。 */
export function refreshSource(deps: PurgeCommandDeps, cwd: string): { bytes: number; from: string } {
  const cfg = deps.loadConfig(cwd);
  const state = deps.state;
  try {
    if (state.sourceKind === "embedded") {
      const text = normalizeText(deps.embeddedText());
      state.sourceText = text;
      state.sourceResolvedFrom = "embedded";
      return { bytes: Buffer.byteLength(text, "utf8"), from: "embedded" };
    }
    if (state.sourceKind === "file") {
      const fp = path.isAbsolute(state.sourcePath || "") ? state.sourcePath! : path.join(cwd, state.sourcePath || "");
      if (!exists(fp)) {
        state.sourceText = "";
        state.sourceResolvedFrom = `missing:${fp}`;
        return { bytes: 0, from: `missing:${fp}` };
      }
      const text = normalizeText(readText(fp));
      state.sourceText = text;
      state.sourceResolvedFrom = fp;
      return { bytes: Buffer.byteLength(text, "utf8"), from: fp };
    }
    const r = deps.resolveSourceText(cwd, state.role, cfg);
    state.sourceText = r.text;
    state.sourceResolvedFrom = r.from;
    return { bytes: Buffer.byteLength(r.text, "utf8"), from: r.from };
  } catch (e) {
    deps.warn(`refreshSource failed: ${String((e as Error)?.message || e)}`);
    return { bytes: 0, from: "error" };
  }
}

function statusText(deps: PurgeCommandDeps, cwd: string): string {
  const state = deps.state;
  const cfg = deps.loadConfig(cwd);
  const { bytes, from } = refreshSource(deps, cwd);
  const last = state.lastChange;
  const lastLine = last
    ? `上一回合：${last.applied ? "已改写" : "未改写"} mode=${last.effectiveMode} bytes=${last.injectedBytes} stripped=${last.strippedLines}${last.note ? ` (${last.note})` : ""}`
    : "上一回合：无";
  const sourceLabel =
    state.sourceKind === "file"
      ? `file ${state.sourcePath || "(unset)"}`
      : state.sourceKind === "chain"
        ? `chain (role=${state.role})`
        : "embedded";
  return [
    `omp-purge ${state.enabled ? "ON" : "OFF"}`,
    `mode: ${state.mode}`,
    `source: ${sourceLabel}  → ${from}  (${bytes} bytes)`,
    `capabilityProtocol: ${cfg.capabilityProtocol !== false}  gate: ${cfg.gate !== false}`,
    `activeRule: ${cfg.activeRule || "(none)"}`,
    lastLine,
  ].join("\n");
}

export function registerPurgeCommand(pi: PurgeCommandHost, deps: PurgeCommandDeps): void {
  pi.registerCommand("purge", {
    description: "omp-purge：切换/配置系统提示词注入（append|replace|strict）",
    getArgumentCompletions: (partial: string) => {
      const p = String(partial || "").trim().toLowerCase();
      const all = [...SUBCOMMANDS, ...PURGE_MODES, "chain", "embedded"];
      const hits = all.filter((c) => c.startsWith(p));
      return hits.length ? hits : undefined;
    },
    handler: async (args: string, ctx: any) => {
      try {
        const cwd = deps.cwdOf(ctx);
        const state = deps.state;
        const { verb, rest } = parseArgs(args);

        switch (verb) {
          case "":
            state.enabled = !state.enabled;
            state.lastChange = null;
            notify(ctx, deps, `omp-purge ${state.enabled ? "已开启" : "已关闭"}（本会话）`);
            return;

          case "on":
          case "off":
            state.enabled = verb === "on";
            state.lastChange = null;
            notify(ctx, deps, `omp-purge ${state.enabled ? "已开启" : "已关闭"}（本会话）`);
            return;

          case "status":
            notify(ctx, deps, statusText(deps, cwd));
            return;

          case "mode": {
            const target = (rest[0] || "").toLowerCase();
            if (!target) {
              notify(ctx, deps, `用法：/purge mode <${PURGE_MODES.join("|")}>（当前 ${state.mode}）`, "warning");
              return;
            }
            if (!isPurgeMode(target)) {
              notify(ctx, deps, `未知模式：${target}（可选 ${PURGE_MODES.join("|")}）`, "error");
              return;
            }
            state.mode = target;
            state.lastChange = null;
            notify(ctx, deps, `mode = ${state.mode}`);
            return;
          }

          case "source": {
            const target = String(rest.join(" ")).trim();
            if (!target) {
              notify(ctx, deps, "用法：/purge source <path|chain|embedded>", "warning");
              return;
            }
            if (target === "chain" || target === "embedded") {
              state.sourceKind = target;
              state.sourcePath = null;
              refreshSource(deps, cwd);
              state.lastChange = null;
              notify(ctx, deps, `source = ${target}（${Buffer.byteLength(state.sourceText, "utf8")} bytes）`);
              return;
            }
            const fp = path.isAbsolute(target) ? target : path.join(cwd, target);
            if (!exists(fp)) {
              // 失败切换回滚：保持原状态不动。
              notify(ctx, deps, `源文件不存在，未改动：${fp}`, "error");
              return;
            }
            state.sourceKind = "file";
            state.sourcePath = fp;
            const { bytes } = refreshSource(deps, cwd);
            state.lastChange = null;
            notify(ctx, deps, `source = ${fp}（${bytes} bytes）`);
            return;
          }

          case "reload": {
            const { bytes, from } = refreshSource(deps, cwd);
            state.lastChange = null;
            notify(ctx, deps, `已重读：${from}（${bytes} bytes）`);
            return;
          }

          case "help":
            notify(ctx, deps, HELP);
            return;

          default:
            notify(ctx, deps, `未知子命令：${verb}\n\n${HELP}`, "warning");
            return;
        }
      } catch (e) {
        notify(ctx, deps, `omp-purge 命令失败：${String((e as Error)?.message || e)}`, "error");
      }
    },
  });
}