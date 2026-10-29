/**
 * 装配：把 OMP 扩展钩子接到 omp-purge 的功能模块上。
 *
 * 钩子映射（OMP 18.13.3 已核实的契约）：
 *   before_agent_start → 合成 systemPrompt 替换策略（mode: append|replace|strict）
 *   tool_call          → 网络门禁（block 公网目标 / 外挂）
 *   session_start      → 重置会话状态（pi-purge 语义：每会话重来）+ 同步 activeRule
 *
 * 命令：/purge（本模块）、/rules（src/command/rules.ts）
 * flag：--purge-off --purge-verbose --purge-mode --purge-source
 *
 * 本文件自带**结构化** ExtensionAPI（不 import OMP 类型），保证脱离 OMP 包也能 tsc 通过。
 */
import { loadConfig } from "./config.ts";
import { resolveRole } from "./roles.ts";
import { resolveInjectText, defaultOverrideText } from "./inject/resolve.ts";
import { capabilityProtocolText } from "./capability.ts";
import { gateHandler } from "./gate/hooks.ts";
import { activateRule } from "./rules/activate.ts";
import { composeSystemPrompt, isPurgeMode } from "./mode.ts";
import { createSessionState, recordChange, type PurgeSessionState } from "./state.ts";
import { registerPurgeCommand, refreshSource, type PurgeCommandDeps } from "./command/purge.ts";
import { registerRulesCommand } from "./command/rules.ts";

interface FlagOptions {
  description?: string;
  type: "boolean" | "string";
  default?: boolean | string;
}

interface CommandOptions {
  description?: string;
  getArgumentCompletions?: (partial: string) => string[] | undefined;
  handler: (args: string, ctx: any) => Promise<void> | void;
}

interface ExtensionAPI {
  on(event: string, handler: (...args: any[]) => any): void;
  registerCommand(name: string, options: CommandOptions): void;
  registerFlag?(name: string, options: FlagOptions): void;
  getFlag?(name: string): boolean | string | undefined;
  logger?: {
    info?: (msg: string, meta?: unknown) => void;
    warn?: (msg: string, meta?: unknown) => void;
    error?: (msg: string, meta?: unknown) => void;
    debug?: (msg: string, meta?: unknown) => void;
  };
}

function cwdOf(ctx: any): string {
  try {
    const c = ctx && typeof ctx.cwd === "string" ? ctx.cwd : "";
    return c || process.cwd();
  } catch {
    return process.cwd();
  }
}

export function install(pi: ExtensionAPI): void {
  const log = (msg: string) => {
    try {
      pi.logger?.info?.(`[omp-purge] ${msg}`);
    } catch {
      /* logger 不可用时静默 */
    }
  };
  const warn = (msg: string) => {
    try {
      pi.logger?.warn?.(`[omp-purge] ${msg}`);
    } catch {
      /* ignore */
    }
  };
  const verbose = (): boolean => {
    try {
      return pi.getFlag?.("purge-verbose") === true;
    } catch {
      return false;
    }
  };

  // ---- 配置 flag ----
  try {
    pi.registerFlag?.("purge-off", { type: "boolean", description: "本次运行禁用 omp-purge", default: false });
    pi.registerFlag?.("purge-verbose", { type: "boolean", description: "omp-purge 详细日志", default: false });
    pi.registerFlag?.("purge-mode", { type: "string", description: "合成模式：append|replace|strict" });
    pi.registerFlag?.("purge-source", { type: "string", description: "提示词来源：chain|embedded|<path>" });
  } catch {
    /* 旧版 OMP 没有 registerFlag 时忽略 */
  }

  // 单一 state 对象：session_start 时**原地**重置，保证 deps 里的引用始终有效。
  let state: PurgeSessionState = createSessionState(loadConfig(process.cwd()));

  const offByFlag = (): boolean => {
    try {
      return pi.getFlag?.("purge-off") === true;
    } catch {
      return false;
    }
  };

  /** 把 CLI flag 上的覆盖写进 state（幂等，可在每次钩子前调用）。 */
  function applyFlags(cwd: string): void {
    if (!pi.getFlag) return;
    try {
      const modeFlag = pi.getFlag("purge-mode");
      if (isPurgeMode(modeFlag)) state.mode = modeFlag;
      const srcFlag = pi.getFlag("purge-source");
      if (typeof srcFlag === "string" && srcFlag.trim()) {
        const s = srcFlag.trim();
        if (s === "chain" || s === "embedded") {
          state.sourceKind = s;
          state.sourcePath = null;
        } else {
          state.sourceKind = "file";
          state.sourcePath = s;
        }
      }
    } catch {
      /* ignore */
    }
    void cwd;
  }

  const deps: PurgeCommandDeps = {
    state,
    cwdOf,
    loadConfig,
    resolveSourceText: (cwd: string, role: string, cfg) => {
      const r = resolveInjectText(cwd, role, cfg.rolePrompts);
      return { text: r.text, from: r.source };
    },
    embeddedText: () => defaultOverrideText(),
    log,
    warn,
  };

  /** 解析本回合要注入的正文（含能力协议段）。 */
  function ourTextFor(cwd: string, role: string): string {
    const cfg = loadConfig(cwd);
    const parts: string[] = [];
    if (state.sourceKind === "chain") {
      const r = resolveInjectText(cwd, role, cfg.rolePrompts);
      state.sourceText = r.text;
      state.sourceResolvedFrom = r.source;
    } else {
      const { from } = refreshSource(deps, cwd);
      state.sourceResolvedFrom = from;
    }
    if (state.sourceText) parts.push(state.sourceText);
    if (cfg.capabilityProtocol !== false) parts.push(capabilityProtocolText({ enabled: true }));
    return parts.join("\n\n");
  }

  // ---- 1. prompt 注入链 + 三模式合成 ----
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      if (event?.reason === "revive") return;
      if (offByFlag()) return;
      const cwd = cwdOf(ctx);
      applyFlags(cwd);
      if (!state.enabled) return;
      const cfg = loadConfig(cwd);
      const role = resolveRole(ctx, cfg);
      state.role = role;

      const ourText = ourTextFor(cwd, role);
      const compose = composeSystemPrompt({
        mode: state.mode,
        ourText,
        nativePrompt: Array.isArray(event?.systemPrompt) ? event.systemPrompt : [],
        cwd,
      });

      recordChange(state, {
        applied: compose.injectedBytes > 0,
        effectiveMode: compose.effectiveMode,
        injectedBytes: compose.injectedBytes,
        strippedLines: compose.strippedLines,
        note: compose.fellBackToAppend ? "身份段 未匹配 → 回退 append" : undefined,
      });

      if (compose.injectedBytes === 0) return;
      if (verbose()) {
        warn(
          `inject mode=${compose.effectiveMode} source=${state.sourceResolvedFrom} bytes=${compose.injectedBytes} stripped=${compose.strippedLines}`,
        );
      }
      return { systemPrompt: compose.systemPrompt };
    } catch (e) {
      warn(`before_agent_start failed: ${String((e as Error)?.message || e)}`);
      return;
    }
  });

  // ---- 2. 会话启动：重置状态 + 同步 activeRule 到 context-file ----
  const onSessionStart = async (_event: any, ctx: any) => {
    try {
      const cwd = cwdOf(ctx);
      const cfg = loadConfig(cwd);
      Object.assign(state, createSessionState(cfg));
      deps.state = state;
      applyFlags(cwd);
      if (state.enabled && cfg.activeRule) {
        try {
          activateRule(cwd, cfg.activeRule);
          if (verbose()) warn(`rule synced: ${cfg.activeRule}`);
        } catch (e) {
          warn(`activateRule(${cfg.activeRule}) failed: ${String((e as Error)?.message || e)}`);
        }
      }
    } catch {
      /* ignore */
    }
  };
  pi.on("session_start", onSessionStart);
  pi.on("agent_start", onSessionStart);

  // ---- 3. 网络门禁 ----
  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      if (offByFlag()) return;
      const cfg = loadConfig(cwdOf(ctx));
      if (!state.enabled || cfg.gate === false) return;
      return await gateHandler(event);
    } catch {
      return;
    }
  });

  // ---- 4. 命令 ----
  try {
    registerPurgeCommand(pi, deps);
    registerRulesCommand(pi, { cwdOf, log, warn });
  } catch (e) {
    warn(`registerCommand failed: ${String((e as Error)?.message || e)}`);
  }

  log(`installed (mode=${state.mode}, source=${state.sourceKind})`);
}