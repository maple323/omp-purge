/**
 * 门禁钩子：挂 OMP 的 tool_call 事件，拦截公网目标 / 外挂任务。
 *
 * OMP 契约（已核实）：on("tool_call", (event, ctx) => ToolCallEventResult | void)
 *   ToolCallEventResult = { block?: boolean; reason?: string; input?: Record<string,unknown>; additionalContext?: string }
 *   event = { type:"tool_call", toolCallId, toolName, input }
 */
import { DENIAL, toolCallText, taskTargetHit } from "./net-scope.ts";

export interface ToolCallLike {
  toolName?: string;
  input?: unknown;
}
export interface ToolCallResult {
  block?: boolean;
  reason?: string;
}

const skipTools = new Set(["todo", "ask", "wait", "web_search"]);

/** handler：命中则 block。永不抛（异常一律放行，避免 tear down 整个会话）。 */
export async function gateHandler(event: ToolCallLike): Promise<ToolCallResult | void> {
  try {
    if (!event || typeof event !== "object") return;
    const name = String(event.toolName || "");
    if (skipTools.has(name)) return;
    const text = toolCallText(event);
    if (!text.trim()) return;
    const hit = await taskTargetHit(text);
    if (!hit) return;
    return { block: true, reason: DENIAL };
  } catch {
    return;
  }
}
