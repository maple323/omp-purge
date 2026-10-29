/**
 * `/rules` 命令：omp-purge 规则集管理面（对应上游 dsh-purge `lib/rules.js` 的 /rules）。
 *
 * 子命令：
 *   /rules [list]                列出规则、目标 context-file 与同步状态
 *   /rules use <id>              激活规则 → 写入目标文件（原文件先备份为 *.bak）
 *   /rules create <id> [target]  新建规则；正文由编辑器采集，无 UI 时只给落盘指引
 *   /rules delete <id>           删除规则（active 时一并清掉 state）
 *   /rules reset                 用备份还原目标文件并清除 active
 *   /rules help                  用法
 *
 * 规则存储与激活的全部语义在 src/rules/store.ts、src/rules/activate.ts 中，
 * 本文件只负责命令解析、参数校验和结果输出，不重复实现存储。
 * 结构类型自声明：不 import OMP 类型包，也不 import ./install.ts（避免循环依赖）。
 */
import { exists } from "../paths.ts";
import {
  BACKUP_SUFFIX,
  deleteRule,
  formatSize,
  listRules,
  readActive,
  ruleMetaPath,
  rulePath,
  rulesStatus,
  saveRule,
  targetPath,
  validRuleId,
  validTarget,
} from "../rules/store.ts";
import { activateRule, resetToOriginal } from "../rules/activate.ts";

type NotifyLevel = "info" | "warning" | "error";
type Notify = (message: string, level?: NotifyLevel) => void;

/** 命令上下文里本模块用到的成员（结构化声明，不依赖上游类型）。 */
interface CommandUi {
  notify?: (message: string, level: NotifyLevel) => void;
  editor?: (options?: unknown) => unknown;
  input?: (options?: unknown) => unknown;
}

interface CommandContext {
  cwd?: unknown;
  ui?: CommandUi;
}

interface CommandRegistration {
  description?: string;
  getArgumentCompletions?: (partial: string) => string[] | undefined;
  handler: (args: string, ctx: CommandContext) => Promise<void> | void;
}

export interface AnyExtensionAPI {
  registerCommand?: (name: string, options: CommandRegistration) => void;
}

export interface RulesCommandOptions {
  /** cwdOf 与 install.ts 中的实现同形；这里只作为边界回调，内部不使用 any。 */
  cwdOf: (ctx: any) => string;
  log: (message: string) => void;
  warn: (message: string) => void;
}

const SUBCOMMANDS = ["list", "use", "create", "delete", "reset", "help"] as const;
const DEFAULT_TARGET = "AGENTS.md";
/** notify 是多行文本，控制总行数避免刷屏。 */
const MAX_LIST_LINES = 30;
const RULE_ID_HINT = "字母或数字开头，1-64 位，仅限字母数字 . _ -";

const USAGE = [
  "/rules — omp-purge 规则集",
  "  /rules [list]                列出规则、目标文件与同步状态",
  "  /rules use <id>              激活规则（写入目标 context-file，原文件先备份）",
  "  /rules create <id> [target]  新建规则；target = AGENTS.md | CLAUDE.md（默认 AGENTS.md）",
  "  /rules delete <id>           删除规则",
  "  /rules reset                 还原目标文件并清除 active",
  "  /rules help                  显示本帮助",
].join("\n");

export function registerRulesCommand(pi: AnyExtensionAPI, opts: RulesCommandOptions): void {
  const { cwdOf, log, warn } = opts;

  // 旧版 OMP 没有 registerCommand：不注册，只告警，不影响扩展其余功能。
  if (!pi || typeof pi.registerCommand !== "function") {
    warn("registerCommand 不可用（OMP 版本过旧？），/rules 未注册");
    return;
  }

  pi.registerCommand("rules", {
    description: "omp-purge 规则集：list / use / create / delete / reset / help",
    getArgumentCompletions(partial: string): string[] | undefined {
      const p = partial.trim();
      // 只补全第一个词（子命令）；补全回调拿不到 ctx/cwd，规则 id 不在此补全。
      if (p.includes(" ")) return undefined;
      const hits = SUBCOMMANDS.filter((s) => s.startsWith(p.toLowerCase()));
      return hits.length > 0 ? [...hits] : undefined;
    },
    async handler(args: string, ctx: CommandContext): Promise<void> {
      const notify = makeNotify(ctx, log, warn);
      let cwd: string;
      try {
        cwd = cwdOf(ctx) || process.cwd();
      } catch (e) {
        notify(`无法确定 cwd: ${errMsg(e)}`, "error");
        return;
      }
      try {
        await dispatch(cwd, args, ctx, notify);
      } catch (e) {
        // handler 永不向外抛：全部失败都走 notify 的 error 通道。
        notify(`/rules 执行失败: ${errMsg(e)}`, "error");
      }
    },
  });
}

/**
 * 统一输出出口：有 UI 就走 ui.notify；headless / print 会话没有 UI，
 * 退回注册时注入的 log / warn（warning 和 error 都走 warn）。
 */
function makeNotify(
  ctx: CommandContext | undefined,
  log: (message: string) => void,
  warn: (message: string) => void,
): Notify {
  return (message, level = "info") => {
    const ui = ctx?.ui;
    if (ui && typeof ui.notify === "function") {
      try {
        ui.notify(message, level);
        return;
      } catch {
        /* UI 抛错时退回日志 */
      }
    }
    if (level === "info") log(message);
    else warn(message);
  };
}

async function dispatch(
  cwd: string,
  rawArgs: string,
  ctx: CommandContext,
  notify: Notify,
): Promise<void> {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "list").toLowerCase();
  const rest = parts.slice(1);

  switch (sub) {
    case "list":
      requireArgCount(rest, 0, "list");
      notify(renderList(cwd));
      return;
    case "use":
      requireArgCount(rest, 1, "use <id>");
      handleUse(cwd, rest[0], notify);
      return;
    case "create":
      await handleCreate(cwd, rest, ctx, notify);
      return;
    case "delete":
      requireArgCount(rest, 1, "delete <id>");
      handleDelete(cwd, rest[0], notify);
      return;
    case "reset":
      requireArgCount(rest, 0, "reset");
      handleReset(cwd, notify);
      return;
    case "help":
      requireArgCount(rest, 0, "help");
      notify(USAGE);
      return;
    default:
      notify(`未知子命令: ${sub}\n\n${USAGE}`, "warning");
  }
}

function requireArgCount(rest: string[], count: number, usage: string): void {
  if (rest.length !== count) throw new Error(`用法: /rules ${usage}`);
}

function renderList(cwd: string): string {
  const rules = listRules(cwd);
  const status = rulesStatus(cwd);
  // 显式取 readActive：active 标记以它为准，其余路径 / 同步信息来自 rulesStatus。
  const active = readActive(cwd);

  const lines: string[] = [];
  lines.push(`omp-purge rules — ${rules.length} 条 (${status.rules_dir})`);
  if (active) {
    const sync = !status.agents_exists
      ? "目标文件缺失"
      : status.agents_synced
        ? "已同步"
        : "目标文件已被改动";
    lines.push(
      `active: ${active} [target=${status.active_target ?? "?"}] → ${status.agents_path} (${sync})`,
    );
  } else {
    lines.push(`active: (none) — 默认目标 ${status.agents_path}`);
  }

  // 预留一行给 "... N more" 尾巴。
  const budget = Math.max(0, MAX_LIST_LINES - lines.length - 1);
  const shown = rules.slice(0, budget);
  for (const r of shown) {
    const mark = r.id === active ? "*" : " ";
    lines.push(`${mark} ${r.id}  name=${r.name}  target=${r.target}  size=${formatSize(r.size)}`);
  }
  if (rules.length > shown.length) lines.push(`... ${rules.length - shown.length} more`);
  if (rules.length === 0) lines.push("(暂无规则) 用 /rules create <id> 新建");
  return lines.join("\n");
}

function handleUse(cwd: string, rawId: string, notify: Notify): void {
  const id = rawId;
  if (!validRuleId(id)) throw new Error(`非法规则 id: ${id}（${RULE_ID_HINT}）`);

  // activateRule 内部已完成 setActive 与目标写入。
  const meta = activateRule(cwd, id);
  const target = targetPath(cwd, meta.target);
  const backup = `${target}${BACKUP_SUFFIX}`;
  const backupNote = exists(backup) ? "" : "（原文件为空或不存在，未产生备份）";
  notify([`rule "${id}" 已激活`, `写入: ${target}`, `备份: ${backup}${backupNote}`].join("\n"));
}

type CaptureOutcome =
  | { kind: "unavailable" }
  | { kind: "cancelled" }
  | { kind: "text"; text: string };

async function handleCreate(
  cwd: string,
  rest: string[],
  ctx: CommandContext,
  notify: Notify,
): Promise<void> {
  if (rest.length < 1 || rest.length > 2) {
    throw new Error("用法: /rules create <id> [AGENTS.md|CLAUDE.md]");
  }
  const id = rest[0];
  const target = rest.length === 2 ? rest[1] : DEFAULT_TARGET;
  if (!validRuleId(id)) throw new Error(`非法规则 id: ${id}（${RULE_ID_HINT}）`);
  if (!validTarget(target)) throw new Error(`非法 target: ${target}（仅支持 AGENTS.md / CLAUDE.md）`);

  const ruleFile = rulePath(cwd, id);
  const metaFile = ruleMetaPath(cwd, id);
  if (exists(ruleFile) || exists(metaFile)) {
    throw new Error(`规则已存在: ${id}（先 /rules delete ${id} 再重建）`);
  }

  const captured = await captureBody(ctx, `规则 ${id}（target=${target}）`);
  if (captured.kind === "unavailable") {
    // 没有 UI 采集能力：不写盘，只给出精确落盘位置和 meta 内容。
    notify(
      [
        "当前会话没有可用的编辑器输入，未写入任何文件。",
        `手动创建: ${ruleFile}`,
        `并写入 meta: ${metaFile}`,
        `meta 内容: ${JSON.stringify({ name: id, target }, null, 2)}`,
        `完成后用 /rules use ${id} 激活。`,
      ].join("\n"),
      "warning",
    );
    return;
  }
  if (captured.kind === "cancelled") {
    notify(`已取消：未写入规则 ${id}`, "warning");
    return;
  }

  saveRule(cwd, id, captured.text, { target });
  notify(`rule "${id}" 已创建 → ${ruleFile} (target=${target})，用 /rules use ${id} 激活`);
}

async function captureBody(
  ctx: CommandContext | undefined,
  title: string,
): Promise<CaptureOutcome> {
  const ui = ctx?.ui;
  const editor = typeof ui?.editor === "function" ? ui.editor : null;
  const input = typeof ui?.input === "function" ? ui.input : null;
  if (!editor && !input) return { kind: "unavailable" };

  // 优先多行编辑器，失败退回单行 input。
  if (editor) {
    const result = await tryCapture(editor, title, true);
    if (result !== undefined) {
      return result === null ? { kind: "cancelled" } : { kind: "text", text: result };
    }
  }
  if (input) {
    const result = await tryCapture(input, title, false);
    if (result !== undefined) {
      return result === null ? { kind: "cancelled" } : { kind: "text", text: result };
    }
  }
  // 两个入口都存在但都调用失败：按取消处理，不误报“无 UI”。
  return { kind: "cancelled" };
}

/**
 * 调用上游 UI 采集函数。上游未约定参数形状，先按 { title, initialValue } 传，
 * 失败再试无参调用。
 * 返回 undefined = 调用本身失败（可换下一个入口）；null = 用户取消 / 正文为空；
 * string = 采集成功。
 */
async function tryCapture(
  fn: (options?: unknown) => unknown,
  title: string,
  multiline: boolean,
): Promise<string | null | undefined> {
  const attempts: Array<() => unknown> = multiline
    ? [() => fn({ title, initialValue: "" }), () => fn()]
    : [() => fn({ title }), () => fn()];
  let invoked = false;
  for (const call of attempts) {
    try {
      const out = await call();
      invoked = true;
      const text = normalizeBody(out);
      if (text !== null) return text;
    } catch {
      /* 换下一种调用形状 */
    }
  }
  return invoked ? null : undefined;
}

function normalizeBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n/g, "\n").trim();
  return text.length > 0 ? text : null;
}

function handleDelete(cwd: string, rawId: string, notify: Notify): void {
  const id = rawId;
  if (!validRuleId(id)) throw new Error(`非法规则 id: ${id}（${RULE_ID_HINT}）`);
  if (!exists(rulePath(cwd, id)) && !exists(ruleMetaPath(cwd, id))) {
    throw new Error(`规则不存在: ${id}`);
  }
  const wasActive = readActive(cwd) === id;
  deleteRule(cwd, id);
  const tail = wasActive ? "（active 状态已清除；目标文件保留当前内容，需要时用 /rules reset）" : "";
  notify(`rule "${id}" 已删除${tail}`);
}

function handleReset(cwd: string, notify: Notify): void {
  const result = resetToOriginal(cwd);
  const section = (label: string, items: string[]) =>
    items.length === 0 ? `${label}: (无)` : `${label}:\n${items.map((p) => `  ${p}`).join("\n")}`;
  notify(
    [
      "规则还原完成",
      section(`已从备份还原 (${result.restored.length})`, result.restored),
      section(`已删除目标文件 (${result.removed.length})`, result.removed),
      section(`已跳过（存在非规则改动）(${result.skipped.length})`, result.skipped),
    ].join("\n"),
  );
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
