/**
 * 装配：把 OMP 扩展钩子接到 omp-purge 的功能模块上。
 *
 * 钩子映射：
 *   before_agent_start → prompt 注入链 + 能力协议（返回 systemPrompt override）
 *   agent_start        → 把配置的 activeRule 同步到 <project>/.omp/AGENTS.md
 *   tool_call          → 网络门禁（block 公网目标 / 外挂）
 */
import { loadConfig } from "./config.ts";
import { resolveRole } from "./roles.ts";
import { resolveInjectText } from "./inject/resolve.ts";
import { capabilityProtocolText } from "./capability.ts";
import { gateHandler } from "./gate/hooks.ts";
import { activateRule } from "./rules/activate.ts";

interface FlagOptions {
  type: "boolean" | "string";
  description?: string;
  default?: boolean | string;
}

interface ExtensionAPI {
  on(event: string, handler: (...args: any[]) => any): void;
  registerFlag?(name: string, options: FlagOptions): void;
  getFlag?(name: string): boolean | string | undefined;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
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

  // ---- 配置 flag ----
  try {
    pi.registerFlag?.("purge-off", { type: "boolean", description: "Disable omp-purge for this run", default: false });
    pi.registerFlag?.("purge-verbose", { type: "boolean", description: "Verbose omp-purge logging", default: false });
  } catch {
    /* 旧版 OMP 没有 registerFlag 时忽略 */
  }

  // ---- 1. prompt 注入链 + 能力协议 ----
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const cwd = cwdOf(ctx);
      const cfg = loadConfig(cwd);
      if (!cfg.enabled || pi.getFlag?.("purge-off") === true) return;
      const role = resolveRole(ctx, cfg);
      const { text, source } = resolveInjectText(cwd, role, cfg.rolePrompts);
      const parts: string[] = [];
      if (text) parts.push(text);
      if (cfg.capabilityProtocol !== false) parts.push(capabilityProtocolText({ enabled: true }));
      if (parts.length === 0) return;
      const base = Array.isArray(event?.systemPrompt) ? event.systemPrompt : [];
      if (pi.getFlag?.("purge-verbose") === true) warn(`inject role=${role} source=${source} bytes=${text.length}`);
      return { systemPrompt: [...base, ...parts] };
    } catch (e) {
      warn(`before_agent_start failed: ${String((e as Error)?.message || e)}`);
      return;
    }
  });

  // ---- 2. 规则集：会话启动时按配置同步到 .omp/AGENTS.md ----
  pi.on("agent_start", async (_event: any, ctx: any) => {
    try {
      const cwd = cwdOf(ctx);
      const cfg = loadConfig(cwd);
      if (!cfg.enabled || pi.getFlag?.("purge-off") === true) return;
      if (!cfg.activeRule) return;
      try {
        activateRule(cwd, cfg.activeRule);
        if (pi.getFlag?.("purge-verbose") === true) warn(`rule synced: ${cfg.activeRule}`);
      } catch (e) {
        warn(`activateRule(${cfg.activeRule}) failed: ${String((e as Error)?.message || e)}`);
      }
    } catch {
      /* ignore */
    }
  });

  // ---- 3. 网络门禁 ----
  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      const cfg = loadConfig(cwdOf(ctx));
      if (!cfg.enabled || cfg.gate === false || pi.getFlag?.("purge-off") === true) return;
      return await gateHandler(event);
    } catch {
      return;
    }
  });

  log("installed");
}
