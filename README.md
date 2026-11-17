# Cua computer control for DeepSeek Harness

[![npm version](https://img.shields.io/npm/v/dsh-plug-computeruse.svg)](https://www.npmjs.com/package/dsh-plug-computeruse)
[![license](https://img.shields.io/npm/l/dsh-plug-computeruse.svg)](LICENSE)

**English** · [简体中文](README.zh.md)

Let your DeepSeek Harness agent actually use the computer — click, type, read the screen — on Windows, macOS and Linux.

The Cua Driver core ships inside this plugin. **Nothing else to install, no MCP server, no PATH setup, no driver to fetch.** Add the plugin and your agent can drive the desktop.

```
"Open the calculator and work out 847 × 392"
"Find the invoice PDF in Downloads and read me the total"
"Fill in this form with the details from my last email"
```

---

## Why this plugin

Most desktop-automation setups ask you to install a driver, start a daemon, and wire up a transport before the agent can do anything. This one is a single plugin.
| | |
| --- | --- |
| **Batteries included** | The Cua Driver SDK and its native binary install with the plugin. Nothing else to fetch or configure. |
| **Scope it to one app** | Point it at a single app and the agent physically cannot screenshot or touch anything else. Enforced by the plugin, not by good behaviour. |
| **Approve what matters** | Clicks and typing can ask you first; reading the screen never interrupts you. |
| **Nothing piles up** | Screenshots are pruned on a timer and wiped when the turn ends. |
| **See where it's working** | A per-session focus cursor marks the area the agent is about to act on. |
| **Configure it in the UI** | A real settings page under **Settings → Cua computer control**. Changes apply immediately. |

---

## Install

**From npm**

In DeepSeek Harness, open **Plugins** in the sidebar → **Add plugin** → enter:

```
dsh-plug-computeruse
```

**From a local checkout or GitHub**

Same **Add plugin** dialog — give it the absolute path to this folder, or the repository URL.

Then **start a new session** so the tool is registered. The first install pulls the Cua Driver SDK and its platform binary (about 28 MB).

> Requires DeepSeek Harness `>=0.2.2-rc.3 <0.3.0` and Node 20+.

---

## Quick start

Ask in plain language. The agent picks the tool and the arguments:

```
Take a screenshot of the calculator and tell me what's on screen.
```

Or drive it explicitly:

```json
{
  "action": "call",
  "name": "get_window_state",
  "arguments": {
    "include_accessibility_tree": true,
    "include_screenshot": true,
    "session": "my-task"
  }
}
```

A good loop is **look → act → look again**: read a fresh state, act on it, then verify the result. Never reuse element tokens from an older snapshot, and treat a returned action as "sent", not "done".

---

## Settings

**Settings → Cua computer control** — the same place as other third-party plugins such as Trae and WorkBuddy.

| Setting | Default | What it does |
| --- | --- | --- |
| Control scope | Whole desktop | `One app only` pins every call to one application |
| Pinned app | — | Executable name (e.g. `CalculatorApp.exe`) or process id |
| Approval before acting | State-changing actions | `All actions`, `State-changing actions`, or `Never ask` |
| Show a focus cursor | On | Marks the area the agent is about to act on |
| Keep screenshots for | 900 s | Disk screenshots expire after this; cleared at turn end |
| Limit screenshot long edge | Driver default | Smaller images mean fewer tokens |
| Call timeout | 120000 ms | Upper bound for a single driver call |

Saving applies **immediately** — no restart, no new session.

> `allowTools` and `session` are configuration-file only. Everything above is in the UI.

---

## Locking it to one app

This is the feature that makes unattended automation safe to leave running.

```yaml
scope: window
app:
  name: WXWork.exe
```

With `scope: window`:

- Whole-screen capture is **refused** — the error tells the agent to use `get_window_state` instead.
- Calls without a window target are bound to the pinned app automatically.
- A window belonging to any other app is **rejected**, naming the app it is pinned to.
- The app keeps working after a restart when pinned by name, not by pid.

The refusal is enforced in code, not requested from the model:

```
dsh-cua: scope is "window", so get_desktop_state is not available.
Use get_window_state on the pinned app instead, or set scope to "desktop" in the plugin configuration.
```

---

## How screenshots are handled

Screenshots go to the model as attachments — they never touch your disk in the normal path. Only when the model can't take images, or the attachment service is unavailable, do they land in `<session dir>/.dsh-cua/`. Those files are:

1. **Swept on a timer** (every 60 s by default) once older than the retention window.
2. **Pruned after every call** that settles.
3. **Deleted at turn end** — the whole directory goes.

Set retention to `0` to keep them only for the current turn.

---

## Requirements

The driver is bundled, but the operating system still has the final say:

- **Windows** — a logged-in interactive desktop session.
- **macOS** — grant Accessibility and Screen Recording to the app running DeepSeek Harness. On macOS the driver prefers its own signed helper app (bundled with the plugin) so macOS attributes those permissions correctly, and falls back to the in-process runtime.
- **Linux** — X11 or XWayland.

---

## Good to know

- **No floating stop button yet.** Control comes from approvals, the one-app scope, and disabling the plugin. A floating overlay with a force-stop is planned.
- **Screenshots and UI text go to your model.** Point this at a provider whose privacy terms you accept.
- **"Action sent" ≠ "UI changed".** Re-read or call `verify_state` before trusting the result. After a timeout, check the state before retrying.
- **Some apps resist pinning** — fullscreen-exclusive or windowless apps can't be scoped.
- **`get_desktop_state` takes no `include_screenshot`** — it always captures. Use `max_image_dimension` / `screenshot_out_file`.
- **`get_window_state` accessibility walks have a 1000 ms budget**; past it you get `degraded: true` and a partial tree. Raise `timeout_ms` or cap `max_elements`.

---

## If enabling fails with EPERM

A rare install problem shows up as:

```
启用失败: EPERM: operation not permitted, realpath
'...\node_modules\dsh-plug-computeruse\node_modules\.pnpm\...'
```

That is a **stale nested `node_modules`** inside the plugin folder, usually left by an earlier install of an older copy. Its symlinks point at packages the profile root already provides, and Node cannot traverse them.

From `1.3.1` the plugin checks this at activation and tells you the exact folder to remove. To repair manually:

1. Disable the plugin in **Plugins**.
2. Delete `<profile>\node_modules\dsh-plug-computeruse\node_modules`.
3. Enable the plugin again.

The profile root already carries every dependency, so nothing needs reinstalling. `cua_driver` with `action: "status"` reports `Installation: dependencies resolve` on a healthy install.

---

## Development

```sh
pnpm run check     # syntax check every module
pnpm test          # 74 unit tests
```

A live check against a real desktop (read-only calls plus the calculator — it never types into a chat window):

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; & $env:DSH_NODE_EXECUTABLE test/integration-live.mjs
```

Covered by the live check: whole-desktop capture allowed on `desktop` scope, refused on `window` scope, other apps refused, approval returns `ask` for state-changing calls and allows read-only ones, and the screenshot directory is empty after a turn ends.

---

## License

Plugin code is MIT. The bundled Cua Driver follows its own upstream license — see [trycua/cua](https://github.com/trycua/cua).
