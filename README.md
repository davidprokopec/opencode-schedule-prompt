# opencode-schedule-prompt

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

```jsonc
// opencode.json(c)
{
  "plugins": ["opencode-schedule-prompt"],
}
```

With options:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-schedule-prompt",
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
`@opencode-ai/plugin@0.0.0-beta-17498` (`opencode2 --version` → `v0.0.0-beta-17498`).
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

## Pending waits do not survive a restart

Waits are held in memory for the lifetime of the plugin. They are dropped when
OpenCode restarts, when the plugin is disabled, and when it reloads — which
OpenCode does whenever a watched config file changes. A dropped wait is silently
gone; it does not fire late.

For a two minute wait this never matters. For an eight hour one, treat `/wait`
as best effort.

## How it works, and why it is shaped this way

V2 slash commands are prompt templates. A plugin can define one, but it cannot
attach a handler to it, so `/wait` cannot run plugin code directly.

So `/wait` expands to a short template that instructs the agent to call the
plugin's `wait_schedule` tool once and do nothing else. That tool parses the
duration itself, registers the wait, and returns immediately. The delay is a
fiber owned by the plugin's scope, not an open turn.

The cost is one cheap model round trip at scheduling time. The benefit is that
duration parsing, timing, delivery, and cancellation are all deterministic
plugin code rather than something the model is trusted to get right.

The plugin registers three tools — `wait_schedule`, `wait_list`, `wait_cancel` —
which the agent may also use on its own, without a slash command, when it
decides something should happen later.

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run check   # typecheck + lint + test
```

To run it against a local checkout, point a config entry at the file:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-schedule-prompt/src/index.ts"],
}
```

OpenCode does not install dependencies for local plugin paths, so `bun install`
in this directory first.

## License

MIT
