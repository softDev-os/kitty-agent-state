# Kitty Agent State Specification

## Purpose

This change publishes Pi session state to Kitty titles and Hyprland notifications without changing command execution behavior. It provides a Pi-native replacement for ambient agent-state awareness in environments that do not use tmux or Zellij.

## Non-Goals

- tmux/Zellij integration.
- Codex MVP support.
- A global dashboard or cross-session state synchronization.
- Mandatory Kitty remote control or `allow_remote_control` dependency.
- Command confirmation, blocking, or rewriting. Existing Pi or `env-protection.ts` safety flows remain the source of truth; this extension only marks `blocked` and notifies.

## Requirements

### Requirement: Canonical session state machine

The system MUST model each Pi session with exactly three public states: `idle`, `working`, and `blocked`.

- The session MUST begin in `idle`.
- `session_start` MUST initialize session-local metadata and the configured title baseline without changing other sessions.
- The only valid state transitions are `idle` → `working`, `working` → `blocked`, `blocked` → `working`, `working` → `idle`, and `blocked` → `idle`.
- `agent_start` MUST move the session from `idle` to `working`.
- `tool_result` or `tool_execution_end` for a previously blocked tool MUST move the session from `blocked` to `working`.
- `agent_end` and `session_shutdown` MUST move any non-idle state to `idle`.
- Re-emitting the same state MUST be idempotent and MUST NOT create extra state changes or nested title prefixes.

#### Scenario: Agent work begins

- GIVEN a fresh session in `idle`
- WHEN `agent_start` is observed
- THEN the session becomes `working`

#### Scenario: Blocked work resumes

- GIVEN a session in `blocked`
- WHEN the blocked tool completes and the runtime emits `tool_result` or `tool_execution_end`
- THEN the session becomes `working`

#### Scenario: Session ends

- GIVEN a session in `working` or `blocked`
- WHEN `agent_end` or `session_shutdown` is observed
- THEN the session becomes `idle`

### Requirement: Pi ExtensionAPI event coverage

The system MUST observe `session_start`, `agent_start`, `agent_end`, `session_shutdown`, `tool_call`, `tool_execution_start`, `tool_execution_update`, `tool_result`, and `tool_execution_end` when the runtime emits them.

- `session_start` MUST capture session metadata, including `cwd` and `project` when available.
- `tool_call` and `tool_execution_start` MUST be used as the primary observation points for blocked detection.
- `tool_execution_update`, `tool_result`, and `tool_execution_end` MUST be consumed as continuation events when they describe the same tool invocation.
- Missing optional lifecycle events MUST NOT break state transitions or suppress idle restoration to the configured title baseline.

#### Scenario: Tool lifecycle is observed

- GIVEN a live session
- WHEN `tool_call` and `tool_execution_start` are emitted for the same tool
- THEN the extension can classify the tool before execution and keep session context for later notifications

#### Scenario: Optional completion events are absent

- GIVEN a runtime that does not emit `tool_execution_update` or `tool_execution_end`
- WHEN `agent_end` arrives
- THEN the session still returns to `idle` without error

### Requirement: Blocked-state detection

The system MUST enter `blocked` when it observes a tool invocation that is explicitly user-input-seeking or confirmation-seeking, or when it observes a shell/bash command that matches the configured risky-command patterns.

- The built-in blocked-tool set MUST cover explicit input/confirmation tools such as `ask`, `select`, `confirm`, and `prompt`-style tools, plus any tool metadata that marks the invocation as requiring user input.
- The built-in risky-command set MUST cover destructive shell patterns, including recursive deletion, disk formatting/wiping, and raw-device writes.
- Configuration MAY add additional blocked tools and risky-command patterns.
- This extension MUST NOT decide whether the command may proceed; it only marks `blocked` and leaves confirmation ownership with Pi or the existing safety extension.

#### Scenario: User input tool is requested

- GIVEN the session is `working`
- WHEN a tool call is classified as requiring user input
- THEN the session transitions to `blocked` and a notification is emitted

#### Scenario: Risky bash command is detected

- GIVEN the session is `working`
- WHEN a shell command matches a configured risky pattern
- THEN the session transitions to `blocked` and the existing confirmation flow remains external to this extension

### Requirement: Configured title baseline and prefixing

The system MUST derive all active titles from a configured title baseline because Pi does not expose a terminal-title getter.

- `ctx.ui.setTitle` MUST be the primary title backend.
- `kitten @` / Kitty remote control MAY be used only as an explicitly configured fallback; it MUST NOT be a hard dependency.
- `title.baseTitle` MUST define the title restored on `idle` and the suffix used while active.
- While `working`, the displayed title MUST be `● working — <baseTitle>`; while `blocked`, it MUST be `● blocked — <baseTitle>`.
- If `title.baseTitle` is empty, the displayed title MUST be the state prefix without a trailing separator.
- The system MUST avoid nested prefixes by replacing its own prefix rather than stacking prefixes on repeated active transitions.
- When the session becomes `idle` or shuts down, the displayed title MUST be restored to `title.baseTitle`.

#### Scenario: Prefix is applied once

- GIVEN `title.baseTitle` is `Docs`
- WHEN the session becomes `working` and later `blocked`
- THEN the title is first `● working — Docs` and then `● blocked — Docs`, never `● blocked — ● working — Docs`

#### Scenario: Title baseline is restored

- GIVEN `title.baseTitle` is `Docs` and the session is `working`
- WHEN `agent_end` or `session_shutdown` is observed
- THEN the title returns to `Docs`

#### Scenario: Kitty remote control is absent

- GIVEN Kitty remote control is unavailable
- WHEN the session becomes `working`
- THEN the title still changes using `ctx.ui.setTitle`

### Requirement: Hyprland notifications on transitions

The system MUST emit a Hyprland notification on every state transition by default, including transitions to `idle`.

- Notifications MUST use concise, actionable copy with the current project when known, e.g. `🔴 Pi necesita atención — .pi`.
- The visual style MUST use the Tokyo Night palette: working blue (`#7aa2f7`), blocked red (`#f7768e`), idle green (`#9ece6a`), with `rgba(...ff)` Hyprland color formatting.
- The system SHOULD publish notifications and audible sounds only for attention-worthy or completion states (`blocked`, `idle`) by default; `working` SHOULD remain silent because the user just initiated the prompt.
- Notification or sound failures MUST be non-fatal and MUST be logged rather than thrown.
- Re-emitting the same state MUST NOT create duplicate notifications.

#### Scenario: Working transition updates title only

- GIVEN a session with `cwd=/home/me/project` and project `project-x`
- WHEN the session enters `working`
- THEN the Kitty title updates to the working state
- AND no Hyprland notification is emitted
- AND no audible sound is played for the `working` transition

#### Scenario: Shutdown notifies idle

- GIVEN a session in `blocked`
- WHEN `session_shutdown` is observed
- THEN a notification is emitted for `idle` and the session title is restored to `title.baseTitle`

### Requirement: Configuration file and environment guards

The system MUST read configuration from `~/.config/kitty-agent-state/config.json` by default and MUST support an environment override path.

- If `KITTY_AGENT_STATE_CONFIG` points to a readable file, that file MUST be loaded instead of the default path.
- If `KITTY_AGENT_STATE=0`, `PI_SUBAGENT_CHILD=1`, or `HERDR_ENV=1` is present, the extension MUST remain disabled and MUST NOT publish titles or notifications.
- The config schema MUST provide sensible defaults for master enable, title publishing, notification publishing, blocked-tool patterns, risky-command patterns, and debug-log path.
- Invalid or missing config MUST fall back to defaults and MUST be logged.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master enable switch. |
| `title.enabled` | boolean | `true` | Enables title publishing. |
| `title.workingPrefix` | string | `● working —` | Prefix for working state; includes the separator and trailing space. |
| `title.blockedPrefix` | string | `● blocked —` | Prefix for blocked state; includes the separator and trailing space. |
| `title.baseTitle` | string | project/cwd-derived label or empty string | Title baseline used for active suffixes and idle restoration. |
| `title.remoteControlFallback` | boolean | `false` | Optional Kitty remote-control fallback when `ctx.ui.setTitle` is unavailable. |
| `notifications.enabled` | boolean | `true` | Enables Hyprland notifications. |
| `notifications.states` | array | `['blocked', 'idle']` | States that notify by default. |
| `blockedDetection.inputTools` | array | `['ask', 'askuserquestion', 'select', 'confirm', 'prompt', 'requestuserinput']` | Tools treated as user-input/confirmation tools. |
| `blockedDetection.riskyBashPatterns` | array | built-in destructive patterns | User-extendable shell-pattern matchers. |
| `logging.path` | string | `~/.local/state/kitty-agent-state/debug.log` | Append-only debug log file. |

#### Scenario: Override path is used

- GIVEN `KITTY_AGENT_STATE_CONFIG` points to a valid config file
- WHEN the extension starts
- THEN the values from that file are used

#### Scenario: Disable guard is respected

- GIVEN `PI_SUBAGENT_CHILD=1`
- WHEN the extension loads
- THEN it does nothing visible in Pi

### Requirement: Debug logging and failure isolation

The system MUST append diagnostic details to `~/.local/state/kitty-agent-state/debug.log` when config loading, title publishing, notification publishing, or pattern classification fails.

- Backend failures MUST NOT throw into Pi lifecycle callbacks.
- The debug log MUST be best-effort and MUST not block state publication.
- The log directory MUST be created on demand if it does not exist.

#### Scenario: Hyprland is unavailable

- GIVEN a state transition occurs and `hyprctl` is missing
- WHEN the notification backend fails
- THEN Pi continues running and the failure is recorded in the debug log

### Requirement: Multi-session independence

The system MUST keep state, configured title baseline, and notification context isolated per Pi session.

- A transition in one session MUST NOT alter another session's state or title.
- Notification content SHOULD identify the active session context so that parallel sessions remain distinguishable.

#### Scenario: Two sessions diverge

- GIVEN session A is `working` and session B is `idle`
- WHEN session A becomes `blocked`
- THEN session B remains `idle` with its configured `title.baseTitle`

### Requirement: Manual verification without a test runner

The system MUST be verifiable in a live Pi session without a unit-test runner.

- The acceptance path MUST be observable through title changes, Hyprland notifications, and debug-log entries.
- The extension MUST not require any test harness beyond manual runtime inspection.

#### Scenario: Live smoke check

- GIVEN a Pi session with the extension loaded
- WHEN an agent starts, a risky command is issued, and the session shuts down
- THEN a reviewer can confirm `working` → `blocked` → `idle` via the title, notifications, and debug log
