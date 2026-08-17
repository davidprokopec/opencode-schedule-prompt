export interface Definition {
  readonly name: string
  readonly description: string
  readonly template: string
}

/**
 * The fallback trigger for clients without a plugin runtime — the web and
 * desktop apps only list plugins in settings, they cannot run one. A server
 * command is a prompt template, so each of these costs one model turn: the
 * template's only job is to make the agent call the matching tool once, with
 * the argument text passed straight through. In the TUI the client-side slash
 * commands intercept /wait before submission, so these never fire there.
 */
export const definitions: ReadonlyArray<Definition> = [
  {
    name: "wait",
    description: "Send a prompt to this session after a delay, e.g. /wait 1hour do it",
    template: [
      "The user wants a prompt delivered later, not now.",
      "",
      "Call the `wait_schedule` tool exactly once with:",
      "",
      "- `duration`: $1",
      "- `prompt`: the text between the OPENCODE_WAIT_PROMPT markers below, copied verbatim,",
      "  without the marker lines",
      "",
      "OPENCODE_WAIT_PROMPT",
      "$2",
      "OPENCODE_WAIT_PROMPT",
      "",
      "Do not start the requested work, do not read any files, and do not call any other tool.",
      "After `wait_schedule` returns, reply with one short line repeating what it reported.",
    ].join("\n"),
  },
  {
    name: "wait-list",
    description: "Browse pending scheduled prompts and cancel one",
    template: [
      "Call the `wait_list` tool exactly once and do not call any other tool.",
      "Reply with its output and nothing else.",
    ].join("\n"),
  },
  {
    name: "wait-cancel",
    description: "Cancel a scheduled prompt by id, or all of them",
    template: [
      "Call the `wait_cancel` tool exactly once and do not call any other tool.",
      "",
      "The user wrote: $ARGUMENTS",
      "",
      "If that text is `all`, call the tool with `all` set to true.",
      "Otherwise call the tool with `id` set to that text exactly.",
      "If the text is empty, call the tool with no arguments.",
      "Reply with the tool's output and nothing else.",
    ].join("\n"),
  },
]
