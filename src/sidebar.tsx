import type { JSX } from "@opentui/solid"

export interface Row {
  readonly id: string
  readonly prompt: string
  readonly countdown: string
  readonly mine: boolean
}

const accent = "#7aa2f7"
const muted = "#565f89"
const normal = "#c0caf5"

/**
 * The pending waits, rendered into the session sidebar.
 *
 * Nothing here imports `solid-js`. The plugin would resolve its own copy,
 * which need not be the same instance the TUI runs, and a mismatched instance
 * shares neither owner nor tracking scope.
 */
export const Waits = (props: {
  readonly rows: ReadonlyArray<Row>
  readonly title: string
  readonly onOpen: (id: string) => void
}): JSX.Element => (
  <box flexDirection="column" paddingTop={1}>
    <text fg={accent}>{props.title}</text>
    {props.rows.map((row) => (
      <box
        flexDirection="row"
        justifyContent="space-between"
        // On release, not press: opening on mousedown leaves the click's
        // mouseup to land outside the new dialog, which closes it instantly.
        onMouseUp={() => props.onOpen(row.id)}
      >
        <text fg={row.mine ? normal : muted}>
          {row.id} {row.prompt}
        </text>
        <text fg={muted}>{row.countdown}</text>
      </box>
    ))}
  </box>
)
