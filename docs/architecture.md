# Architecture

omp-purge is a thin adapter: OMP's extension hooks are wired in one place, and
each hook delegates to a small, independently testable module.

## Load and wiring

```
index.ts
  └─ export default install ──────────────► src/install.ts
                                               ├─ registerFlag  --purge-off
                                               ├─ registerFlag  --purge-verbose
                                               ├─ registerFlag  --purge-mode
                                               ├─ registerFlag  --purge-source
                                               ├─ registerCommand /purge ──► src/command/purge.ts
                                               │                                 └─► src/state.ts
                                               ├─ registerCommand /rules ──► src/command/rules.ts
                                               ├─ on before_agent_start ───► inject + capability + mode
                                               ├─ on agent_start ──────────► rules/activate.ts
                                               └─ on tool_call ────────────► gate/hooks.ts
```

`src/install.ts` is the only file that touches the OMP API. Every other module
takes plain values and returns plain values, which is what makes the unit tests
possible without OMP installed.

## Request path

On `before_agent_start`:

```
event.systemPrompt (string[])
        │
        ▼
src/config.ts      loadConfig(cwd)      project > user > defaults
        │
        ▼
src/roles.ts       resolveRole(ctx,cfg) model id -> role
        │
        ▼
src/inject/resolve.ts
        │  rolePrompts[role]                     -> source "role"
        │  else <project>/.omp/prompt-inject.md  -> source "prompt"
        │  else sealed default   ──► inject/crypto.ts openSlot(slot-table.ts)
        │                                        -> source "default"
        ▼
src/mode.ts        compose(base, injected, mode)
        │  append  : [...base, injected]
        │  replace : [injected, ...base minus identity line]
        │  strict  : [injected, "Current working directory: <cwd>"]
        ▼
{ systemPrompt: string[] }
```

`src/capability.ts` contributes the capability-selection section, appended when
`capabilityProtocol` is enabled. If the gate or the extension is disabled the
handler returns `void`, and the native prompt is left untouched.

## Module map

| Module | Responsibility |
|---|---|
| `index.ts` | Extension entry; re-exports `install` as the default |
| `src/install.ts` | Registers flags, commands, and the three hooks; reads `getFlag` |
| `src/state.ts` | Per-session toggle / mode / source; reset at `session_start`, never persisted |
| `src/mode.ts` | Composes the native and injected prompts per mode |
| `src/config.ts` | Merges defaults, user config, project config |
| `src/paths.ts` | Resolves `agentDir`, project `.omp`, rules dir, atomic writes |
| `src/roles.ts` | Maps the current model id to a role |
| `src/capability.ts` | Capability-selection prompt text |
| `src/command/purge.ts` | `/purge` handler and per-session toggle state |
| `src/command/rules.ts` | `/rules` handler |
| `src/inject/resolve.ts` | Priority chain: role → project file → sealed default |
| `src/inject/crypto.ts` | AES-256-GCM + deflate slot codec |
| `src/inject/slot-table.ts` | Generated sealed slot (do not edit) |
| `src/rules/store.ts` | Rule files, metadata, active state |
| `src/rules/activate.ts` | Apply a rule to `AGENTS.md` / `CLAUDE.md`, restore backups |
| `src/rules/cwd-scan.ts` | Scans cwd → repo root for instruction files |
| `src/gate/net-scope.ts` | Host extraction, DNS resolution, loopback/RFC1918 test |
| `src/gate/hooks.ts` | `tool_call` handler; blocks public targets and cheats |

## State on disk

All project state lives under `<cwd>/.omp/`:

```
.omp/
├── AGENTS.md                     active rule target (native context file)
├── AGENTS.md.omp-purge-rule.bak  backup made before activation
├── prompt-inject.md              optional inject override
├── purge/config.json             project config
└── rules/
    ├── <id>.md                   rule body
    ├── <id>.json                 rule metadata (name, target)
    ├── state.json                active rule id
    ├── cwd-selections.json       scanned-file selection
    └── workspace-policy.json     workspace policy
```

User state lives under `<agentDir>/` (`~/.omp/agent/` by default):
`purge/config.json` and `purge/prompt-inject.md`.

## Hook mapping

| OMP hook | omp-purge behavior |
|---|---|
| `before_agent_start` | Build the inject text, append the capability section, compose by mode, return `{ systemPrompt }` |
| `agent_start` | Sync `activeRule` into the target context file |
| `tool_call` | Run the network gate; return `{ block, reason }` on a hit |
| `registerCommand` | `/purge` and `/rules` |
| `registerFlag` | `--purge-*` overrides |

## Failure policy

Every hook wraps its body in `try/catch` and fails soft:

- `before_agent_start` returns `void` on error, so the native prompt is used.
- `agent_start` logs a warning and continues.
- `tool_call` returns `void` on error, so the call proceeds.
- The slot codec returns `""` on any decrypt/inflate failure, and
  `resolveInjectText` then falls back to the plaintext file.

This mirrors the upstreams: a broken inject source degrades to the host default
rather than tearing down the session.

## Upstream mapping

| Local module | Upstream source |
|---|---|
| `src/rules/store.ts`, `src/rules/activate.ts`, `src/rules/cwd-scan.ts` | dsh-purge `lib/rules.js` |
| `src/gate/net-scope.ts`, `src/gate/hooks.ts` | dsh-purge `lib/net-scope.js` |
| `src/capability.ts` | dsh-purge `lib/capability-protocol.js` |
| `src/inject/crypto.ts` | dsh-purge `lib/table-key.js`, `lib/table-read.js` |
| `src/inject/resolve.ts`, `src/paths.ts` | dsh-purge `lib/core.js` (`normalizeOverride`, `hashOverride`, `resolveInjectText`, `readPromptInjectFileSync`) |
| `src/inject/default-prompt.zh.md`, `src/inject/slot-table.ts` | dsh-purge `lib/default-prompt-inject.zh.md` |
| `src/mode.ts`, `src/command/purge.ts` | pi-purge: `/purge`, `append`/`replace`/`strict`, per-session toggle, identity stripping |

Not ported: host JS source patching (`ALL_PATCHES`), shim injection, host
restart, update checks, and the Cordis web/desktop dock UI. OMP offers no
equivalent seam for any of them.
