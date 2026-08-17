import type { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"

export interface MenuRow {
  readonly id: string
  readonly label: string
  readonly meta: string
}

export interface MenuColors {
  readonly text: RGBA
  readonly subdued: RGBA
  readonly key: RGBA
  readonly selectedBackground: RGBA
  readonly selectedText: RGBA
  readonly background: RGBA
}

export interface MenuAction {
  readonly label: string
  readonly key: string
}

/**
 * The wait manager, laid out like the built in queued prompts dialog: a title
 * row, a search field, one line per entry with right aligned detail, and a
 * footer naming each action and its key.
 *
 * Colours come from the resolved theme rather than literals so the dialog
 * follows whatever theme the user runs.
 */
export const WaitMenu = (props: {
  readonly title: string
  readonly rows: ReadonlyArray<MenuRow>
  readonly selected: number
  readonly actions: ReadonlyArray<MenuAction>
  readonly colors: MenuColors
  readonly empty: string
  readonly onQuery: (value: string) => void
}): JSX.Element => (
  <box flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
    <box flexDirection="row" justifyContent="space-between">
      <text fg={props.colors.text}>{props.title}</text>
      <text fg={props.colors.subdued}>esc</text>
    </box>

    <box paddingTop={1} paddingBottom={1}>
      <input focused placeholder="Search" onInput={(value) => props.onQuery(value)} />
    </box>

    {props.rows.length === 0 ? (
      <text fg={props.colors.subdued}>{props.empty}</text>
    ) : (
      props.rows.map((row, index) => (
        <box
          flexDirection="row"
          justifyContent="space-between"
          flexGrow={1}
          backgroundColor={
            index === props.selected ? props.colors.selectedBackground : props.colors.background
          }
        >
          <text
            fg={index === props.selected ? props.colors.selectedText : props.colors.text}
            bg={
              index === props.selected ? props.colors.selectedBackground : props.colors.background
            }
          >
            {row.label}
          </text>
          <text
            fg={index === props.selected ? props.colors.selectedText : props.colors.subdued}
            bg={
              index === props.selected ? props.colors.selectedBackground : props.colors.background
            }
          >
            {row.meta}
          </text>
        </box>
      ))
    )}

    <box flexDirection="row" paddingTop={1}>
      {props.actions.map((action) => (
        <box flexDirection="row" paddingRight={2}>
          <text fg={props.colors.text}>{action.label}</text>
          <text fg={props.colors.key}>{` ${action.key}`}</text>
        </box>
      ))}
    </box>
  </box>
)
