# omp-purge

Ports [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) and
[pi-purge](https://github.com/ZiChuanLan/pi-purge) to
[Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) as a native **TypeScript
extension**.

> This repository is a derivative of both upstreams.
> **dsh-purge** by YuJunZhiXue (Apache-2.0) supplies the prompt injection chain,
> rule sets, network gate, capability protocol, and sealed-slot codec.
> **pi-purge** by ZiChuanLan (MIT) supplies the `/purge` command concept, the
> three composition modes, the per-session toggle, and the identity-stripping
> behavior. See [NOTICE](./NOTICE) for the full attribution and module mapping.

English | [简体中文](./README.zh-CN.md)

## What OMP is

OMP is the [`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)
package (`>= 18.13.3`), driven by the `omp` CLI from
<https://github.com/can1357/oh-my-pi> (MIT, homepage <https://omp.sh>).

It is a **pi-family agent**: a Rust/TS core plus a native TypeScript extension
layer. Unlike DSH, there is no patchable JS host — extensions integrate through
the documented API, not by rewriting the agent's source.

## Capabilities

| # | Capability | Implementation |
|---|---|---|
| 1 | **`/purge` command + three modes** | `pi.registerCommand("purge", …)`; `src/mode.ts` composes the returned prompt as `append`, `replace`, or `strict` |
| 2 | **Prompt injection chain** | `before_agent_start` returns a `systemPrompt` override. Priority: `rolePrompts[role]` > `<project>/.omp/prompt-inject.md` > sealed built-in default |
| 3 | **Rule sets + `/rules`** | Activating writes `rules/<id>.md` into `<project>/.omp/AGENTS.md` (OMP native context file) with a `.omp-purge-rule.bak` backup and restore |
| 4 | **Network gate** | `tool_call` hook: resolve host → IP, allow only loopback / RFC1918; block attack-word requests aimed at public hosts; hard-block cheat tasks |
| 5 | **Capability protocol** | Appends "read the skill/MCP catalog, then call what matches the task" |
| 6 | **Role routing** | Reads the current OMP model, maps it to a role (`default` / `smol` / `slow` / `plan` / …), and picks the prompt variant |
| 7 | **Sealed default prompt** | AES-256-GCM + deflate slot in `src/inject/slot-table.ts`; the plaintext source is not shipped by `files` in `package.json` |
| 8 | **Not ported: host patching, dock UI** | OMP is a Rust/TS core with no patchable JS host and no plugin dock equivalent. Documented here rather than silently dropped |

Approval bypass in dsh-purge was implemented by patching the host source. OMP
has no such seam, so omp-purge only uses the supported `tool_call` gate; it does
not weaken the agent's approval policy.

## Verified extension API

These facts were verified by reading
`@oh-my-pi/pi-coding-agent@18.13.3`,
`src/extensibility/extensions/types.ts`. See
[docs/omp-extension-api.md](./docs/omp-extension-api.md) for the raw reference.

| Contract | Verified signature / behavior |
|---|---|
| **Entry** | `export default function (pi: ExtensionAPI)` — a sync or async factory, called at load, sequentially after the concurrent import phase. Session actions are unavailable at load. |
| **Inject** | `pi.on("before_agent_start", (event, ctx) => ({ systemPrompt: string[] }))`. `event.systemPrompt: string[]`; `event.reason: "prompt" \| "revive"` (the result is discarded for `revive`). The returned `systemPrompt` is a **replacement policy** applied to the next request and its continuations until the next preparation, chained in registration order. `ctx.getSystemPrompt(): string[]` reads the current prompt. |
| **Commands** | `pi.registerCommand(name, { description?, getArgumentCompletions?, handler })` |
| **Flags** | `pi.registerFlag(name, { description?, type: "boolean" \| "string", default? })`; `pi.getFlag(name): boolean \| string \| undefined` |
| **Tool gate** | `pi.on("tool_call", (event, ctx) => ({ block?, reason?, input?, additionalContext? }))`. A returned `input` is last-wins and replaces the exec args; `block` short-circuits. |
| **Discovery** | `<cwd>/.omp/extensions/*.{ts,js}` (cwd only, no walk-up) and `<agentDir>/extensions/*.{ts,js}` (default `~/.omp/agent/extensions`; profile `~/.omp/profiles/<name>/agent/extensions`). A directory entry resolves `index.ts` / `index.js`, or a `package.json` carrying `omp.extensions` (legacy `pi.extensions`). Explicit `-e` / `--extension <path>`. Disable with `disabledExtensions: ["extension-module:omp-purge"]`. |
| **Native files** | `SYSTEM.md` = full system-prompt override (`<agentDir>/SYSTEM.md`, and the project config dir); `AGENTS.md` / `CLAUDE.md` = context files (user instructions in the conversation); `modelRoles` in `~/.omp/agent/config.yml`. |
| **Headless** | `omp -p "<prompt>" -e <path>` |

## Install

OMP loads extensions from disk (`.ts` / `.js`); there is no build step.

**Project-level** (recommended): drop this repo at
`<your-project>/.omp/extensions/omp-purge/`. OMP auto-discovers
`<cwd>/.omp/extensions/*.ts` at startup.

**Explicit path**:

```bash
omp -e /path/to/omp-purge/index.ts
```

**Disable** for a run — either in config:

```json
{ "disabledExtensions": ["extension-module:omp-purge"] }
```

or on the command line with `omp --purge-off`.

## Command reference

The toggle state is **per session**: a `/purge on` or `/purge mode …` lasts for
the current session only and does not rewrite `config.json`.

| Command | Effect |
|---|---|
| `/purge` | Toggle injection on/off for this session |
| `/purge on` / `/purge off` | Set the session toggle explicitly |
| `/purge status` | Show enabled state, mode, source, resolved role, active rule, and rule sync state; in `replace` mode it also reports whether the identity line was matched |
| `/purge mode append\|replace\|strict` | Switch the composition mode for this session |
| `/purge source <path>\|chain\|embedded` | Override where the injected text is read from: an explicit file path, the normal priority chain, or the sealed built-in prompt |
| `/purge reload` | Re-read config / inject sources and rebuild the prompt |
| `/purge help` | Command help |

| Rule command | Effect |
|---|---|
| `/rules list` | List rules in `<project>/.omp/rules/` |
| `/rules use <id>` | Activate a rule: write it into `.omp/AGENTS.md` (backing up the original) |
| `/rules create <id>` | Create an empty rule file |
| `/rules delete <id>` | Delete a rule; if it is active, clear the active state |
| `/rules reset` | Restore every backed-up target and clear the active rule |
| `/rules help` | Command help |

## The three modes

| Mode | Composed prompt | Notes |
|---|---|---|
| `append` | Our text appended **after** the native prompt array | Default and safest; mirrors dsh-purge's post-prompt behavior |
| `replace` | Our text, then the native prompt with its identity line removed | If the identity line cannot be matched, the extension falls back to `append` and `/purge status` reports it |
| `strict` | Our text plus a single `Current working directory: <cwd>` line | Nothing else from the native prompt is kept |

## Config

JSON. Project config overrides user config overrides defaults:

- User: `<agentDir>/purge/config.json` (default `~/.omp/agent/purge/config.json`)
- Project: `<cwd>/.omp/purge/config.json`

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

The shipped defaults are `mode: "append"` and `source: "chain"`.

| Key | Meaning |
|---|---|
| `enabled` | Master switch; `false` disables every hook |
| `activeRule` | Rule synced into `<project>/.omp/AGENTS.md` at session start; empty means no auto-sync |
| `rolePrompts` | Per-role prompt overrides; `"*"` is the fallback |
| `modelRoles` | Maps a substring of the model id to a role, used to select `rolePrompts` |
| `capabilityProtocol` | Append the capability-selection section |
| `gate` | Enable the network gate |
| `verbose` | Verbose logging |
| `mode` | Default composition mode: `append` / `replace` / `strict` |
| `source` | Default inject source: a path, `chain`, or `embedded` |

## Flags

| Flag | Effect |
|---|---|
| `--purge-off` | Disable omp-purge for this run |
| `--purge-verbose` | Verbose logging |
| `--purge-mode <append\|replace\|strict>` | Override the composition mode |
| `--purge-source <path>` | Override the inject source |

## Verify

```bash
# Unit + integration tests. Node >= 22 runs .ts directly.
node --test "test/**/*.test.mjs"

# Type check (dev only).
npx tsc --noEmit

# End-to-end: safe dry run, no model call.
node scripts/e2e-omp.mjs --check-only

# End-to-end: one real model call. Opt-in.
node scripts/e2e-omp.mjs
```

The e2e harness creates a throwaway project, copies the extension into
`.omp/extensions/omp-purge/`, and drives the real CLI. It reports two
independent signals:

| Signal | Meaning | Source |
|---|---|---|
| **inject log** | the hook ran and resolved non-empty text | `~/.omp/logs/omp.*.log`, `[omp-purge] inject …` |
| **marker echo** | the injected prompt actually reached the model | the model's answer contains the random marker |

`RESULT: PASS` requires the inject log; the marker echo is reported separately
because it depends on the model complying. Pass `--strict-marker` to require
both, and `OMP_E2E_SHOW_LOG=1` to print the matched log lines.

One environment caveat: if your user-level `<agentDir>/purge/config.json`
defines `rolePrompts` (including `"*"`), that override outranks the temp
project's `prompt-inject.md`, so the marker echo is expected to miss while the
inject log still passes. The log's `source=` field names the layer that won.

## Sealing the default prompt

The built-in default prompt ships as a sealed slot, not plaintext:

```bash
node scripts/seal-default-prompt.mjs   # AES-256-GCM + deflate -> src/inject/slot-table.ts
```

The plaintext source is `src/inject/default-prompt.zh.md`; it is deliberately
excluded from `files` in `package.json`, so npm publishes only the ciphertext.
The runtime falls back to the plaintext file only when the slot is empty or
fails to open.

## Layout

```
omp-purge/
├── index.ts                        entry: export default install
├── src/
│   ├── install.ts                  hooks, commands, flags
│   ├── state.ts                    per-session toggle / mode / source
│   ├── mode.ts                     append / replace / strict composition
│   ├── config.ts                   config merge and defaults
│   ├── paths.ts                    agent dir / project .omp resolution
│   ├── roles.ts                    model id -> role
│   ├── capability.ts               capability protocol text
│   ├── command/
│   │   ├── purge.ts                /purge
│   │   └── rules.ts                /rules
│   ├── inject/
│   │   ├── resolve.ts              role -> project file -> sealed default
│   │   ├── crypto.ts               AES-256-GCM slot codec
│   │   ├── slot-table.ts           generated sealed slot
│   │   └── default-prompt.zh.md    plaintext source (not published)
│   ├── rules/
│   │   ├── store.ts                rule storage, active state
│   │   ├── activate.ts             apply / restore
│   │   └── cwd-scan.ts             AGENTS.md / CLAUDE.md scan
│   └── gate/
│       ├── net-scope.ts            host extraction, DNS, allow list
│       └── hooks.ts                tool_call gate handler
├── scripts/
│   ├── seal-default-prompt.mjs
│   └── e2e-omp.mjs
├── test/
│   ├── smoke.test.mjs              gate / inject / crypto / roles
│   ├── mode.test.mjs               append / replace / strict composition
│   ├── install.test.mjs            wiring against a fake host
│   └── e2e-harness.test.mjs        harness sanity (no model call)
├── presets/
│   └── redteam/
│       ├── rule.md                 red-team rule to copy into .omp/rules/
│       └── config.json             matching purge config
├── docs/
│   ├── omp-extension-api.md
│   └── architecture.md
├── NOTICE
└── LICENSE
```

## A note on `SYSTEM.md`

`<agentDir>/SYSTEM.md` (usually `~/.omp/agent/SYSTEM.md`) is OMP's own native
full system-prompt override, not an omp-purge file. When it is present the
native prompt array that `before_agent_start` receives is already that override.
That matters for the `replace` / `strict` modes: `replace` strips the identity
line from whatever array OMP supplies, and `strict` discards it entirely. Read
your `SYSTEM.md` before choosing these modes.

## Disclaimer

For controlled evaluation of targets **you own locally**; attack tasks are
allowed only for loopback / RFC1918. You bear all legal responsibility for how
you use this. Upstream dsh-purge states the original may not be resold; this
port retains its attribution and NOTICE. Both upstreams are provided as-is,
without warranty.
