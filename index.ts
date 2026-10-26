/**
 * omp-purge — Oh My Pi 破甲扩展入口。
 *
 * OMP 扩展契约：`export default function (pi: ExtensionAPI) {}`。
 * 工厂在加载期被调用；注册方法 / getFlag / exec 可用，session actions 不可用。
 *
 * 本扩展做三件事：
 *   1. prompt 注入链   → before_agent_start 返回 systemPrompt override
 *   2. 规则集系统      → 写 <project>/.omp/AGENTS.md（native context-file，priority 100）
 *   3. 网络门禁        → tool_call 拦截公网目标
 * 外加按 model role 路由提示词（OMP modelRoles）。
 */
import { install } from "./src/install.ts";

export default install;
