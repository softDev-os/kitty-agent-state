# kitty-agent-state

Pi extension for Kitty + Hyprland users. It publishes agent state visually and audibly:

- Kitty tab title through Pi `ctx.ui.setTitle`
- Hyprland notifications through `hyprctl notify`
- Sounds through `paplay`
- Config at `~/.config/kitty-agent-state/config.json`
- Debug log at `~/.local/state/kitty-agent-state/debug.log`

## States

- `● working — <project>` (title only; no notification, no sound)
- `● blocked — <project>` / `🔴 Pi necesita atención — <project>`
- `<project>` / `🟢 Pi terminó — <project>`

## Install

```bash
./install.sh
```

Then ensure Pi loads the extension from `~/.pi/agent/settings.json` and run `/reload` inside Pi.

Example config:

```json
{
  "title": { "baseTitle": "" },
  "notifications": { "enabled": true, "states": ["blocked", "idle"] }
}
```

Leave `baseTitle` empty to derive the project name from the current working directory.
Set `KITTY_AGENT_STATE=0` to disable the extension for a session.

## OpenSpec

Canonical spec is in `openspec/specs/kitty-agent-state/spec.md`.

## Inspiration

Built with reference to [gentle-agent-state](https://github.com/Gentleman-Programming/gentle-agent-state) by Gentleman Programming — the original tmux/Zellij agent-state tool. This is a ground-up adaptation for Kitty + Hyprland environments, rewritten as a native Pi extension.

