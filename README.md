# omp-purge

Ports [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)'s capabilities to
[Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) as a native **TypeScript extension**.

> Fork/derivative of `dsh-purge` (fork: `maple323/dsh-purge`).
> Upstream is Apache-2.0; see [NOTICE](./NOTICE).

## Capabilities

| Capability | Implementation |
|---|---|
| **Prompt injection chain** | `before_agent_start` returns a `systemPrompt` override. Priority: `rolePrompts[role]` > `<project>/.omp/prompt-inject.md` > sealed built-in default |
| **Rule sets** | Activating writes `rules/<id>.md` into `<project>/.omp/AGENTS.md` (OMP native context-file, priority 100) with `.bak` backup + restore |
| **Network gate** | `tool_call` hook: resolve host→IP, allow only loopback / RFC1918; block attack-word requests targeting public hosts; hard-block cheats |
| **Capability protocol** | Appends "read the skill/MCP catalog, then call what matches the task" |
| **Role-routed prompts** | Reads the current OMP model, maps it to a role (`default/smol/slow/plan/...`), picks a prompt variant |

## Differences from dsh-purge

dsh-purge is a Cordis plugin that **patches the official DSH JS sources** to bypass
approval/sandbox, injects shims, restarts the host, and ships a web/desktop dock UI.
OMP is a **Rust core + TS extension layer** with no patchable JS host — so:

- Ported: injection chain, rule sets, CWD scan, network gate, capability protocol, sealed-slot codec.
- Not ported: host-source patching, shims, host restart, update checks, dock UI (no equivalent).
- Approval bypass → approximated via the `tool_call` / `tool_approval_requested` hooks.

## Install

OMP loads extensions from disk (`.ts`/`.js`); no build step.

**Project-level** (recommended): drop this repo at
`<your-project>/.omp/extensions/omp-purge/` — OMP auto-discovers
`<cwd>/.omp/extensions/*.ts` at startup.

**Explicit path**: `omp -e /path/to/omp-purge/index.ts`

Disable: `disabledExtensions: ["extension-module:omp-purge"]`, or run with `omp --purge-off`.

## Config

Project overrides user:

- User: `<agentDir>/purge/config.json` (default `~/.omp/agent/purge/config.json`)
- Project: `<cwd>/.omp/purge/config.json`

```json
{
  "enabled": true,
  "activeRule": "redteam",
  "capabilityProtocol": true,
  "gate": true,
  "rolePrompts": { "plan": "…", "task": "…", "*": "" },
  "modelRoles": { "plan": "gpt-5-plan" }
}
```

Flags: `--purge-off`, `--purge-verbose`.

## Verify

```bash
node --test test/     # pure-algorithm smoke tests (Node >= 22 runs .ts directly)
```

End-to-end: drop into `<testproject>/.omp/extensions/omp-purge/`, start OMP, ask "who are you"
(injected persona should show), gate a public host vs `127.0.0.1`, set `activeRule` and check
`.omp/AGENTS.md`.

## Sealing the default prompt

The built-in default prompt ships as plaintext (`src/inject/default-prompt.zh.md`) and is
runtime-overridable by `prompt-inject.md`. To ship only ciphertext:

```bash
node scripts/seal-default-prompt.mjs   # writes src/inject/slot-table.ts (AES-256-GCM + deflate)
```

## Disclaimer

For controlled evaluation of targets **you own locally**; attack tasks are allowed only for
loopback / RFC1918. You bear all legal responsibility. Upstream dsh-purge states the original
may not be resold; this fork retains its attribution and NOTICE.
