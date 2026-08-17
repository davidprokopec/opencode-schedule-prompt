# opencode-waits

Defer a prompt in [OpenCode V2](https://opencode.ai/v2/docs/). Say what you want
and when you want it, and OpenCode sends it to itself later.

```
/wait 1hour implement this
/wait 60s run the test suite again
/wait 2h30m check whether the deploy settled
```

`/wait` returns straight away. Nothing runs, no context is held open, and no
tokens are burned while the timer is pending. When the delay elapses the plugin
submits the prompt text into the same session as an ordinary user prompt, and
OpenCode acts on it exactly as if you had typed it yourself.

## Install

The plugin has two halves and needs an entry in **two** config files. The TUI
half provides the commands; the server half owns the timers so a wait still
fires once the TUI is closed.

```jsonc
// opencode.json(c) — the server half
{
  "plugins": ["opencode-waits"],
}
```

```jsonc
// cli.json — the TUI half, which provides /wait
{
  "plugins": ["opencode-waits/tui"],
}
```

With options:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-waits",
      "options": {
        "delivery": "queue",
      },
    },
  ],
}
```

| Option     | Values              | Default | Behaviour                                                                             |
| ---------- | ------------------- | ------- | ------------------------------------------------------------------------------------- |
| `delivery` | `"queue"`, `"steer"` | `queue` | `queue` waits for any turn in progress to finish. `steer` injects into the running turn. |

### Compatibility

The V2 plugin API is beta. This release is built and verified against
`@opencode-ai/plugin@0.0.0-beta-17519` (`opencode2 --version` → `v0.0.0-beta-17519`).
If your OpenCode is on a different beta build, check for a matching release of
this plugin.

## Commands

| Command                 | Effect                                                     |
| ----------------------- | ---------------------------------------------------------- |
| `/wait <duration> <prompt>` | Schedule `<prompt>` for delivery after `<duration>`.   |
| `/wait-list`            | Show the waits still pending in this session.               |
| `/wait-cancel <id>`     | Cancel one wait, e.g. `/wait-cancel w1`.                    |
| `/wait-cancel all`      | Cancel every wait pending in this session.                  |

Waits are per session. `/wait-list` and `/wait-cancel` never see or touch waits
belonging to another session.

## Durations

`<duration>` is the first whitespace-separated argument; everything after it is
the prompt.

| Form            | Meaning              |
| --------------- | -------------------- |
| `500ms`         | milliseconds         |
| `60s`, `90 sec` | seconds              |
| `5m`, `5min`    | minutes              |
| `1h`, `1hour`   | hours                |
| `3d`, `3 days`  | days                 |
| `1w`            | weeks                |
| `2h30m`         | compound             |
| `1.5h`          | fractional           |
| `60`            | bare number, seconds |

`m` is minutes and `ms` is milliseconds. A bare number is only accepted on its
own, so `1h30` is rejected as ambiguous rather than guessed at. The maximum is
30 days.

## Waits survive restarts

Each pending wait is a JSON file under
`$XDG_DATA_HOME/opencode-waits/waits/` (a directory of one file per
wait, so the two halves never clobber each other's records). On startup the
server half arms everything it finds, and fires anything already overdue
immediately.

If delivery fails — most likely because you are still rate limited — the wait is
re-armed after 5m, 15m and 45m before being given up. If the target session no
longer exists, the wait is dropped.

## How it works, and why it is split in two

A slash command defined by a *server* plugin is only a prompt template. Running
one submits a prompt and schedules model execution — so it fails exactly when
you are rate limited and most want to defer work.

A **TUI** slash command does not. The prompt matches `/wait …` and calls the
plugin before any model dispatch, so scheduling costs no model call at all. That
is why the trigger lives in the TUI half.

Timers cannot live there, though: they would die when you close the TUI. So the
TUI half only records the wait to disk, and the **server** half — running in the
background service — owns the timers and delivers the prompt.

The plugin can also expose `wait_schedule`, `wait_list` and `wait_cancel` as
tools so the agent can schedule work itself. They are **off by default**, since
every exposed tool costs schema tokens in every request:

```jsonc
{ "package": "opencode-waits", "options": { "tools": true } }
```

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run check   # typecheck + lint + test
```

To run it against a local checkout, point a config entry at the file:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-waits/src/index.ts"],
}
```

OpenCode does not install dependencies for local plugin paths, so `bun install`
in this directory first.

## License

MIT
