# 📊 Claude Code Status Line

A compact, single-file status line for [Claude Code](https://claude.com/claude-code), powered by Node.js.

![Node.js](https://img.shields.io/badge/runtime-Node.js-339933?logo=nodedotjs&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)
![Network](https://img.shields.io/badge/network%20requests-none-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

```
📁 xurxomr │ 🌿 main │ Opus 5/high │ ctx [███░░░░░░░] 74% left 260k/1M │ 5h [█░░░░░░░░░] 11% 2h04m │ 7d 1% │ $0.92 │ Reviewing the script
```

Everything is flush left and ordered by importance. There is no right-hand zone:
nothing is positioned or padded, so nothing can drift out of place.

## ✨ Features

- 📁 **Directory** and 🌿 **git branch** of the current workspace
- 🤖 **Model** and effort level, e.g. `Opus 5/high`
- 🧠 **Context window** as a bar, with what is left and a token counter
- ⏱️ **5-hour and 7-day rate limits**, with time until the 5-hour reset
- 💲 **Session cost**
- 📝 **Current task**, taken from the in-progress to-do
- 📏 **Adapts to narrow terminals** by dropping the least important segments first
- 🔒 **Local only**: no network requests, no credential access, no dependencies

## 🚀 Installation

Requires [Node.js](https://nodejs.org/). From the repository root:

```bash
node install.js             # copy the files to ~/.claude/statusline and add statusLine to settings.json
node install.js --dry-run   # show what would happen, change nothing
node install.js --force     # replace a different statusLine that is already configured
```

Then restart Claude Code.

The installer honors `CLAUDE_CONFIG_DIR` if you use it. Before overwriting a file
that differs (including `settings.json`) it saves a `.bak-<timestamp>` copy, and it
stops without touching anything if `settings.json` is not valid JSON.

<details>
<summary>🔧 Manual installation</summary>

Copy this folder's files to `~/.claude/statusline/` and add this to
`~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node ~/.claude/statusline/statusline.js"
}
```

</details>

> [!TIP]
> On Windows, if the bar does not show up, Claude Code probably cannot find
> `node`. Open a **new** terminal after installing Node.js and start Claude Code
> from there, or put the full path to `node.exe` in the `command`.

## 🔌 How it connects to Claude Code

The connection is the `statusLine` entry above, and nothing else.

> [!NOTE]
> **This is not a hook.** Hooks are a different mechanism: they live under the
> `hooks` key of `settings.json`, bind to lifecycle events (`PreToolUse`, `Stop`,
> `SessionStart`…) and are never auto-discovered from a directory. Claude Code does
> not run anything just because it sits in a particular folder. This folder only
> groups what belongs to this module, and the path in `settings.json` is the one
> thing that links it to Claude Code.

### 📜 Contract

Claude Code runs the command on every refresh (debounced to 300 ms), passes a JSON
object on stdin and draws whatever the script writes to stdout.

| Field | Used for |
|---|---|
| `workspace.current_dir` (or `cwd`) | the directory segment |
| `model.display_name` | model name |
| `effort.level` | effort level, attached to the model with `/` |
| `context_window.used_percentage` | fill of the context bar |
| `context_window.remaining_percentage` | fallback if the previous one is missing |
| `context_window.total_input_tokens` / `context_window_size` | token counter |
| `rate_limits.five_hour.used_percentage` / `resets_at` | 5-hour limit |
| `rate_limits.seven_day.used_percentage` | weekly limit |
| `cost.total_cost_usd` | accumulated session cost |
| `session_id`, `transcript_path` | to locate the current task |

Everything comes from that JSON or from local `git`.

## ⚙️ Configuration

Settings are environment variables, set in the `command` itself, for example
`"command": "CC_BAR_WIDTH=14 node ~/.claude/statusline/statusline.js"`.

| Variable | Default | What it does |
|---|---|---|
| `CC_BAR_WIDTH` | `10` | cells per bar |
| `CC_BAR_FULL` | `█` | fill character (use `#` if your font lacks the glyph) |
| `CC_BAR_EMPTY` | `░` | empty character |
| `CC_STATUS_MARGIN` | `2` | columns reserved when deciding what fits |
| `CC_GREY_BOOST` | `0` | lightens the three greys at once (useful 0–6; beyond that they saturate to white and the hierarchy is lost) |
| `CC_PANIC_AT` | `90` | severity at which 💀 and blinking appear |
| `CC_TASK_MAX` | `40` | maximum width of the task before it is truncated |
| `CC_STATUS_DEBUG` | — | `1` prints failures to stderr instead of swallowing them |
| `CC_STATUS_DUMP` | — | a file path: the raw stdin JSON is written there on every render |

> [!NOTE]
> Claude Code rotates system notifications (MCP errors, auto-update, low-context
> warning) through the right side of this same row. In narrow terminals they can
> truncate the end of the line. Raise `CC_STATUS_MARGIN` if that bothers you.

## 🧪 Try it by hand

`sample.json` is an example session with every field filled in:

```bash
COLUMNS=200 node ~/.claude/statusline/statusline.js < ~/.claude/statusline/sample.json
```

To compare grey levels and pick the one that reads best in your terminal:

```bash
cd ~/.claude/statusline
for b in 0 2 4 6; do printf 'boost=%-2s ' $b; CC_GREY_BOOST=$b COLUMNS=200 node statusline.js < sample.json; done
```

Run from an interactive shell with no stdin, it prints a line with default values,
which is enough to check that Node executes it without errors.

## 🔍 Details that are not obvious

<details>
<summary><b>Terminal width</b></summary>

It comes from `$COLUMNS`, which Claude Code exports before running the script. It
cannot come from the terminal: Claude Code captures stdout instead of attaching it
to the console, so there is no tty to query and `tput cols` always returns its
default (80). It is only used to decide which segments fit; if it goes stale after
a resize, the only effect is that a segment is missing or extra. Nothing shifts.

</details>

<details>
<summary><b>Measuring width</b></summary>

Knowing whether something fits requires its width *in cells*, which is neither the
byte count nor the code point count: ANSI escapes take 0, emoji take 2 and
variation selectors take 0. `cellWidth()` computes that.

</details>

<details>
<summary><b>Bar direction</b></summary>

In both bars the filled blocks are what has been **consumed**. The context label
says what is left (`74% left`) and the limit labels say what has been spent
(`11%`), which is why each number carries its own word.

</details>

<details>
<summary><b>Graceful degradation</b></summary>

Each segment has a priority. If the terminal is narrow, the least important ones
are removed (7d, task, cost, 5h, branch…) so the line never wraps to two rows.
Directory, model and context are never removed.

</details>

<details>
<summary><b>Current task (the fragile segment)</b></summary>

Claude Code does not expose to-dos on stdin, so they have to be read from internal
state. The script first tries `~/.claude/todos/` (which no longer exists in
2.1.268; older status lines used it) and then the tail of the transcript. If it
finds nothing, the segment simply does not appear.

</details>

## 🎨 Colors

Three explicit greys from the 256-color ramp, by role of the text:

| Level | Code | Where |
|---|---|---|
| `sep` | 243 | the `│` dividers and the bar in `Opus 5/high` |
| `muted` | 246 | supporting data: tokens, cost, effort, task |
| `label` | 249 | the words that name a value: `ctx`, `5h`, `7d` |

`dim` (SGR 2) and *bright black* (SGR 90) are deliberately avoided. Both darken
the text, and combined (`\x1b[2;90m`) they leave it almost unreadable on a dark
background; how much they darken also depends on the terminal palette rather than
the script. A number from the ramp looks the same everywhere.

## 📄 License

[MIT](LICENSE)

---

<p align="center">
  <sub><i>"There are 10 kinds of terminals: those wide enough for your status line, and <code>COLUMNS=80</code>."</i><br>
  — Orven</sub>
</p>
