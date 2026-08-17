import type { JSX } from "@opentui/solid"

export interface MenuRow {
  readonly id: string
  readonly label: string
  readonly description: string
}

const accent = "#7aa2f7"
const muted = "#565f89"

/**
 * The wait manager.
 *
 * A navigable list plus a hint line naming the keys that act on whatever is
 * highlighted. The keys themselves are bound by a keymap layer in the plugin
 * setup, which is only enabled while this dialog is open.
 */
export const WaitMenu = (props: {
  readonly title: string
  readonly rows: ReadonlyArray<MenuRow>
  readonly hint: string
  readonly onHighlight: (id: string | undefined) => void
  readonly onSelect: (id: string) => void
}): JSX.Element => (
  <box flexDirection="column" padding={1}>
    <text fg={accent}>{props.title}</text>
    <select
      focused
      showDescription
      wrapSelection
      height={Math.min(14, Math.max(2, props.rows.length * 2))}
      options={props.rows.map((row) => ({
        name: row.label,
        description: row.description,
        value: row.id,
      }))}
      onChange={(_index, option) =>
        props.onHighlight(typeof option?.value === "string" ? option.value : undefined)
      }
      onSelect={(_index, option) => {
        if (typeof option?.value === "string") props.onSelect(option.value)
      }}
    />
    <text fg={muted}>{props.hint}</text>
  </box>
)
