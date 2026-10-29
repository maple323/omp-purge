# omp-purge

把 [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) 与
[pi-purge](https://github.com/ZiChuanLan/pi-purge) 移植到
[Oh My Pi（OMP）](https://github.com/can1357/oh-my-pi)，以原生 **TypeScript 扩展**
的形式实现。

> 本仓库同时是两者的派生作品。
> **dsh-purge**（作者 YuJunZhiXue，Apache-2.0）提供：prompt 注入链、规则集、网络门禁、
> 能力协议、密封槽编解码。
> **pi-purge**（作者 ZiChuanLan，MIT）提供：`/purge` 命令概念、三种组合模式、按会话开关、
> 剥离身份段落的行为。完整署名与模块映射见 [NOTICE](./NOTICE)。

[English](./README.md) | 简体中文

## OMP 是什么

OMP 即 [`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)
包（`>= 18.13.3`），由 <https://github.com/can1357/oh-my-pi> 提供的 `omp` CLI 驱动
（MIT，主页 <https://omp.sh>）。

它属于 **pi 家族**：Rust/TS 编译核心 + 原生 TypeScript 扩展层。与 DSH 不同，OMP 没有
可 patch 的 JS 宿主——扩展只能走公开 API，不能改写 Agent 源码。

## 能力

| # | 能力 | 实现 |
|---|---|---|
| 1 | **`/purge` 命令 + 三种模式** | `pi.registerCommand("purge", …)`；`src/mode.ts` 以 `append` / `replace` / `strict` 组合返回的 prompt |
| 2 | **prompt 注入链** | `before_agent_start` 返回 `systemPrompt` 覆盖。优先级：`rolePrompts[role]` > `<project>/.omp/prompt-inject.md` > 内置密封默认槽 |
| 3 | **规则集 + `/rules`** | 激活时把 `rules/<id>.md` 写入 `<project>/.omp/AGENTS.md`（OMP 原生 context 文件），带 `.omp-purge-rule.bak` 备份与还原 |
| 4 | **网络门禁** | `tool_call` 钩子：解析域名 → IP，只放行 loopback / RFC1918；攻击词命中公网目标即 block；外挂任务硬拦 |
| 5 | **能力选用协议** | 追加「先读 skill/MCP 目录，再按任务选用」段 |
| 6 | **按 role 路由** | 读 OMP 当前 model，映射到 role（`default` / `smol` / `slow` / `plan` / …），选对应提示词变体 |
| 7 | **密封默认 prompt** | AES-256-GCM + deflate 密封槽，位于 `src/inject/slot-table.ts`；明文源被 `package.json` 的 `files` 排除，不随包发布 |
| 8 | **不移植：改宿主源码、dock UI** | OMP 是 Rust/TS 核心，没有可 patch 的 JS 宿主，也没有对应的插件 dock。此处显式说明，而非静默删掉 |

dsh-purge 的审批绕过靠直接改宿主源码；OMP 没有这个接缝，因此 omp-purge 只用受支持的
`tool_call` 门禁，不放宽 Agent 的审批策略。

## 已核实的扩展 API

以下事实通过阅读 `@oh-my-pi/pi-coding-agent@18.13.3` 的
`src/extensibility/extensions/types.ts` 核实。原始参考见
[docs/omp-extension-api.md](./docs/omp-extension-api.md)。

| 契约 | 已核实的签名 / 行为 |
|---|---|
| **入口** | `export default function (pi: ExtensionAPI)` —— 同步或 async 工厂，加载期调用，在并发 import 阶段之后顺序执行。加载期不可用 session actions。 |
| **注入** | `pi.on("before_agent_start", (event, ctx) => ({ systemPrompt: string[] }))`。`event.systemPrompt: string[]`；`event.reason: "prompt" \| "revive"`（`revive` 时返回值被丢弃）。返回的 `systemPrompt` 是**替换策略**，作用于下一次请求及其后续，直到下一次 preparation；多个 handler 按注册顺序链式执行。`ctx.getSystemPrompt(): string[]` 读取当前 prompt。 |
| **命令** | `pi.registerCommand(name, { description?, getArgumentCompletions?, handler })` |
| **Flag** | `pi.registerFlag(name, { description?, type: "boolean" \| "string", default? })`；`pi.getFlag(name): boolean \| string \| undefined` |
| **工具门禁** | `pi.on("tool_call", (event, ctx) => ({ block?, reason?, input?, additionalContext? }))`。返回的 `input` 为 last-wins，会替换 exec 参数；`block` 短路。 |
| **发现** | `<cwd>/.omp/extensions/*.{ts,js}`（仅 cwd，不向上查找）与 `<agentDir>/extensions/*.{ts,js}`（默认 `~/.omp/agent/extensions`；profile 为 `~/.omp/profiles/<name>/agent/extensions`）。目录项解析 `index.ts` / `index.js`，或带 `omp.extensions`（旧版 `pi.extensions`）的 `package.json`。显式 `-e` / `--extension <path>`。用 `disabledExtensions: ["extension-module:omp-purge"]` 关闭。 |
| **原生文件** | `SYSTEM.md` = 完整 system-prompt 覆盖（`<agentDir>/SYSTEM.md`，以及项目配置目录）；`AGENTS.md` / `CLAUDE.md` = context 文件（会话中的用户指令）；`~/.omp/agent/config.yml` 中的 `modelRoles`。 |
| **无头运行** | `omp -p "<prompt>" -e <path>` |

## 安装

OMP 从磁盘加载扩展（`.ts` / `.js`），无需构建。

**项目级**（推荐）：把本仓库整个目录放进
`<your-project>/.omp/extensions/omp-purge/`，OMP 启动时自动发现
`<cwd>/.omp/extensions/*.ts`。

**显式路径**：

```bash
omp -e /path/to/omp-purge/index.ts
```

**关闭**：配置里写

```json
{ "disabledExtensions": ["extension-module:omp-purge"] }
```

或者运行时加 `omp --purge-off`。

## 命令参考

开关状态**按会话生效**：`/purge on` 或 `/purge mode …` 只影响当前会话，不会改写
`config.json`。

| 命令 | 作用 |
|---|---|
| `/purge` | 本会话内切换注入开/关 |
| `/purge on` / `/purge off` | 显式设置会话开关 |
| `/purge status` | 显示开关、模式、来源、解析出的 role、当前规则与同步状态；`replace` 模式下还会报告身份行是否匹配成功 |
| `/purge mode append\|replace\|strict` | 切换本会话的组合模式 |
| `/purge source <path>\|chain\|embedded` | 覆盖注入文本来源：显式文件路径、正常优先级链、或密封内置 prompt |
| `/purge reload` | 重新读取配置 / 注入源并重建 prompt |
| `/purge help` | 命令帮助 |

| 规则命令 | 作用 |
|---|---|
| `/rules list` | 列出 `<project>/.omp/rules/` 下的规则 |
| `/rules use <id>` | 激活规则：写入 `.omp/AGENTS.md`（先备份原文件） |
| `/rules create <id>` | 新建空规则文件 |
| `/rules delete <id>` | 删除规则；若为当前激活项，同时清空激活状态 |
| `/rules reset` | 还原所有备份目标并清空激活规则 |
| `/rules help` | 命令帮助 |

## 三种模式

| 模式 | 组合后的 prompt | 说明 |
|---|---|---|
| `append` | 我们的文本追加在原生 prompt 数组**之后** | 默认且最安全，对应 dsh-purge 的 post-prompt 行为 |
| `replace` | 先我们的文本，再原生 prompt（移除其身份行） | 若匹配不到身份行，回退到 `append`，并由 `/purge status` 报告 |
| `strict` | 我们的文本，外加单行 `Current working directory: <cwd>` | 不保留原生 prompt 的任何其他内容 |

## 配置

JSON。项目级覆盖用户级，用户级覆盖默认值：

- 用户：`<agentDir>/purge/config.json`（默认 `~/.omp/agent/purge/config.json`）
- 项目：`<cwd>/.omp/purge/config.json`

```json
{
  "enabled": true,
  "activeRule": "redteam",
  "rolePrompts": { "plan": "…", "task": "…", "*": "" },
  "modelRoles": { "plan": "gpt-5-plan" },
  "capabilityProtocol": true,
  "gate": true,
  "verbose": false,
  "mode": "append",
  "source": "chain"
}
```

出厂默认值为 `mode: "append"`、`source: "chain"`。

| 键 | 含义 |
|---|---|
| `enabled` | 总开关；`false` 时所有钩子停用 |
| `activeRule` | 会话启动时同步进 `<project>/.omp/AGENTS.md` 的规则；空值表示不自动同步 |
| `rolePrompts` | 按 role 覆盖注入正文；`"*"` 为兜底 |
| `modelRoles` | 把 model id 的子串映射到 role，用于选择 `rolePrompts` |
| `capabilityProtocol` | 是否附加能力选用协议段 |
| `gate` | 是否启用网络门禁 |
| `verbose` | 详细日志 |
| `mode` | 默认组合模式：`append` / `replace` / `strict` |
| `source` | 默认注入来源：路径、`chain` 或 `embedded` |

## Flags

| Flag | 作用 |
|---|---|
| `--purge-off` | 本次运行禁用 omp-purge |
| `--purge-verbose` | 详细日志 |
| `--purge-mode <append\|replace\|strict>` | 覆盖组合模式 |
| `--purge-source <path>` | 覆盖注入来源 |

## 验证

```bash
# 单元 + 装配集成测试。Node >= 22 可直接运行 .ts。
node --test "test/**/*.test.mjs"

# 类型检查（仅开发期）。
npx tsc --noEmit

# 端到端 dry-run：不调模型，CI 用这个。
node scripts/e2e-omp.mjs --check-only

# 端到端真跑：会发起一次真实模型调用（opt-in）。
node scripts/e2e-omp.mjs
```

端到端脚本会新建临时项目，把扩展复制进 `.omp/extensions/omp-purge/`，再驱动真实
CLI。它报告**两个独立信号**：

| 信号 | 含义 | 来源 |
|---|---|---|
| **inject 日志** | 钩子确实跑了，解析到非空正文 | `~/.omp/logs/omp.*.log` 里的 `[omp-purge] inject …` |
| **marker 回显** | 注入真的送达模型 | 模型回答里出现随机 marker |

`RESULT: PASS` 以 inject 日志为准；marker 回显单独报告，因为那取决于模型是否配合。
加 `--strict-marker` 要求两者都过，加 `OMP_E2E_SHOW_LOG=1` 打印命中的日志行。

## 密封默认 prompt

内置默认 prompt 以密封槽形式发布，而不是明文：

```bash
node scripts/seal-default-prompt.mjs   # AES-256-GCM + deflate -> src/inject/slot-table.ts
```

明文源是 `src/inject/default-prompt.zh.md`，被 `package.json` 的 `files` 刻意排除，
因此 npm 只发布密文。仅当槽为空或解包失败时，运行时才回退到明文文件。

## 目录结构

```
omp-purge/
├── index.ts                        入口：export default install
├── src/
│   ├── install.ts                  钩子、命令、flags
│   ├── state.ts                    按会话的开关 / 模式 / 来源
│   ├── mode.ts                     append / replace / strict 组合
│   ├── config.ts                   配置合并与默认值
│   ├── paths.ts                    agent dir / 项目 .omp 定位
│   ├── roles.ts                    model id -> role
│   ├── capability.ts               能力协议文本
│   ├── command/
│   │   ├── purge.ts                /purge
│   │   └── rules.ts                /rules
│   ├── inject/
│   │   ├── resolve.ts              role -> 项目文件 -> 密封默认
│   │   ├── crypto.ts               AES-256-GCM 密封槽编解码
│   │   ├── slot-table.ts           生成的密封槽
│   │   └── default-prompt.zh.md    明文源（不发布）
│   ├── rules/
│   │   ├── store.ts                规则存储与激活状态
│   │   ├── activate.ts             应用 / 还原
│   │   └── cwd-scan.ts             AGENTS.md / CLAUDE.md 扫描
│   └── gate/
│       ├── net-scope.ts            host 提取、DNS、放行判定
│       └── hooks.ts                tool_call 门禁处理器
├── scripts/
│   ├── seal-default-prompt.mjs
│   └── e2e-omp.mjs
├── test/
│   ├── smoke.test.mjs              门禁 / 注入 / 加密 / role
│   ├── mode.test.mjs               append / replace / strict 组合
│   ├── install.test.mjs            假宿主下的装配验证
│   └── e2e-harness.test.mjs        跑测脚本自检（不调模型）
├── presets/
│   └── redteam/
│       ├── rule.md                 红队规则，复制到 .omp/rules/
│       └── config.json             配套 purge 配置
├── docs/
│   ├── omp-extension-api.md
│   └── architecture.md
├── NOTICE
└── LICENSE
```

## 关于 `SYSTEM.md`

`<agentDir>/SYSTEM.md`（通常是 `~/.omp/agent/SYSTEM.md`）是 OMP 自身的原生完整
system-prompt 覆盖，不是 omp-purge 的文件。它存在时，`before_agent_start` 收到的原生
prompt 数组已经是该覆盖内容。这一点对 `replace` / `strict` 模式有直接影响：`replace`
从 OMP 提供的数组里剥离身份行，`strict` 则完全丢弃它。选这两种模式前，建议先读一遍
你的 `SYSTEM.md`。

## 免责声明

仅用于对你**本地拥有的**目标做受控评测；攻击类任务只放行 loopback / RFC1918。使用者
自负全部法律责任。上游 dsh-purge 明确声明「不得转售」，本移植保留其署名与 NOTICE。
两个上游均按原样提供，不附带任何担保。
