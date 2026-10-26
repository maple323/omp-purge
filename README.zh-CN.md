# omp-purge

把 [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) 的破甲能力移植到
[Oh My Pi（OMP）](https://github.com/can1357/oh-my-pi)——一个类 Claude Code / Codex 的
终端编码 Agent——的原生 **TypeScript 扩展**。

> 本仓库是 `dsh-purge` 的 fork 派生（fork: `maple323/dsh-purge`）。
> 上游为 Apache-2.0，署名见 [NOTICE](./NOTICE)。

## 能力

| 能力 | 实现 |
|---|---|
| **prompt 注入链** | `before_agent_start` 返回 `systemPrompt` override。优先级：`rolePrompts[role]` > `<project>/.omp/prompt-inject.md` > 内置密封默认槽（小码酱） |
| **规则集系统** | 激活时把 `rules/<id>.md` 写进 `<project>/.omp/AGENTS.md`（OMP native context-file，优先级 100），带 `.bak` 备份与还原 |
| **网络门禁** | `tool_call` 钩子：解析域名→IP，只放行 loopback / RFC1918；攻击词命中公网目标 → block；外挂任务硬拦 |
| **能力选用协议** | 追加「先读 skill/MCP 目录再按任务选用」段 |
| **按 role 路由 prompt** | 读 OMP 当前 model，映射到 role（`default/smol/slow/plan/...`），选对应提示词变体 |

## 与 dsh-purge 的差异（为什么）

dsh-purge 是 Cordis 插件，靠**直接改官方 DSH 的 JS 源码**绕过审批/沙箱
（`ALL_PATCHES`）、注入 shim、重启宿主、带 web/desktop dock UI。OMP 是
**Rust 编译核心 + TS 扩展层**，没有可 patch 的 JS 宿主——所以：

- ✅ 移植：注入链、规则集、CWD 扫描、网络门禁、能力协议、加密槽算法。
- ❌ 不移植：改宿主源码、shim、宿主重启、更新检查、dock UI（无对应物）。
- 🔁 审批绕过 → 用 `tool_call` / `tool_approval_requested` 钩子近似。

## 安装

OMP 扩展从磁盘加载（`.ts`/`.js`），无需构建。二选一：

**项目级**（推荐，随项目走）：

```
<your-project>/.omp/extensions/omp-purge/
├── index.ts            # export default install
├── src/ ...
```

把本仓库整个目录放进 `<your-project>/.omp/extensions/omp-purge/` 即可。
启动 OMP 时自动加载（native 扫描 `<cwd>/.omp/extensions/*.ts`）。

**显式路径**：

```bash
omp -e /path/to/omp-purge/index.ts
```

关闭：配置 `disabledExtensions: ["extension-module:omp-purge"]`，或运行时 `omp --purge-off`。

## 配置

项目级覆盖用户级：

- 用户：`<agentDir>/purge/config.json`（默认 `~/.omp/agent/purge/config.json`）
- 项目：`<cwd>/.omp/purge/config.json`

```json
{
  "enabled": true,
  "activeRule": "redteam",
  "capabilityProtocol": true,
  "gate": true,
  "rolePrompts": {
    "plan": "你处于规划角色：…",
    "task": "你处于执行角色：…",
    "*": ""
  },
  "modelRoles": {
    "plan": "gpt-5-plan",
    "task": "claude-sonnet"
  }
}
```

- `activeRule`：会话启动时同步哪条规则到 `.omp/AGENTS.md`（规则存 `.omp/rules/<id>.md`）。
- `rolePrompts`：按 role 覆盖注入正文（`"*"` 兜底）。
- `modelRoles`：把当前 model id 的子串映射到 role，用于 `rolePrompts` 选择。

命令行 flag：`--purge-off`（本次禁用）、`--purge-verbose`（详细日志）。

## 验证

```bash
node --test test/          # 纯算法冒烟单测（Node ≥ 22 可直接跑 .ts）
```

端到端：

1. 把仓库放进 `<testproject>/.omp/extensions/omp-purge/`。
2. 启动 OMP，问模型「你是谁」→ 应体现注入的默认人格（非原生身份）。
3. 放一个 `<testproject>/.omp/prompt-inject.md` → 注入应被其覆盖。
4. 配置 `activeRule` 并创建 `.omp/rules/<id>.md` → 启动后 `.omp/AGENTS.md` 应出现规则全文。
5. 让模型访问 `8.8.8.8` 或公网域名 → 应被 block 并回「不行，这是严令禁止的」；
   `127.0.0.1` / `192.168.x.x` → 放行。

## 密封默认 prompt

出厂默认 prompt（小码酱）默认以明文源 `src/inject/default-prompt.zh.md` 提供，
运行时可被子 `/prompt-inject.md` 覆盖。若要发布时隐藏明文、只留密文：

```bash
node scripts/seal-default-prompt.mjs   # 生成 src/inject/slot-table.ts（AES-256-GCM + deflate）
```

## 免责声明

仅用于对你**本地拥有的**目标做受控评测；攻击类任务只放行 loopback / RFC1918。
使用者自负全部法律责任。上游 dsh-purge 明确声明「不得转售」，本 fork 保留其署名与 NOTICE。
