# OMP extension API (verified reference)

This page records the extension API surface omp-purge relies on. Every fact
here was verified by reading
`@oh-my-pi/pi-coding-agent@18.13.3`, `src/extensibility/extensions/types.ts`.
It is not a complete API reference — only the contracts this repository uses.

## Entry point

```ts
export default function (pi: ExtensionAPI) { /* ... */ }
```

- Sync or async factory.
- Called at load, sequentially after the concurrent import phase.
- Session actions are **not** available at load time.

## Hooks

### `before_agent_start` — system prompt injection

```ts
pi.on("before_agent_start", (event, ctx) => ({ systemPrompt: string[] }));
```

| Name | Type / behavior |
|---|---|
| `event.systemPrompt` | `string[]` — the native prompt prepared for this request |
| `event.reason` | `"prompt" \| "revive"`; the handler result is **discarded** for `revive` |
| return `systemPrompt` | A **replacement policy**: applied to the next request and its continuations until the next preparation |
| chaining | Handlers run in registration order; each sees the policy from the previous one |
| `ctx.getSystemPrompt()` | `(): string[]` — reads the current prompt |

Return `void` (or `undefined`) to leave the prompt untouched.

### `tool_call` — tool gate

```ts
pi.on("tool_call", (event, ctx) => ({
  block?: boolean;
  reason?: string;
  input?: Record<string, unknown>;
  additionalContext?: string;
}));
```

| Field | Behavior |
|---|---|
| `block` | Short-circuits the call; `reason` is surfaced to the model |
| `input` | Last-wins; replaces the exec arguments |
| `additionalContext` | Added to the call context |

## Commands

```ts
pi.registerCommand(name, { description?, getArgumentCompletions?, handler });
```

## Flags

```ts
pi.registerFlag(name, { description?, type: "boolean" | "string", default? });
pi.getFlag(name); // boolean | string | undefined
```

## Discovery

| Location | Pattern |
|---|---|
| Project | `<cwd>/.omp/extensions/*.{ts,js}` — cwd only, no walk-up |
| User | `<agentDir>/extensions/*.{ts,js}` — default `~/.omp/agent/extensions` |
| Profile | `~/.omp/profiles/<name>/agent/extensions` |
| Explicit | `-e` / `--extension <path>` |

A directory entry resolves to:

- `index.ts` / `index.js`, or
- a `package.json` carrying `omp.extensions` (legacy key: `pi.extensions`).

Disable a loaded extension by module name:

```json
{ "disabledExtensions": ["extension-module:omp-purge"] }
```

## Files OMP already reads natively

| File | Meaning |
|---|---|
| `SYSTEM.md` | Full system-prompt override (`<agentDir>/SYSTEM.md`, and the project config dir) |
| `AGENTS.md` / `CLAUDE.md` | Context files — user instructions in the conversation |
| `modelRoles` in `~/.omp/agent/config.yml` | Model-role mapping |

## Headless

```bash
omp -p "<prompt>" -e <path>
```

## Minimal extension

```ts
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => ({
    systemPrompt: [...event.systemPrompt, "extra"],
  }));
}
```

## Structural typing

omp-purge does **not** import `ExtensionAPI` from the OMP package. `src/install.ts`
declares a local *structural* interface covering just the members it calls
(`on`, `registerFlag`, `getFlag`, `logger`). TypeScript's structural typing makes
the real `pi` object assignable to it, so the repository type-checks without the
OMP package installed. The local declaration mirrors the verified signatures
above; if OMP changes them, the compiler will not catch it — the contract is
documented here instead.
