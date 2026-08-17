import { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"

export interface ManagerRow {
  readonly id: string
  readonly title: string
  readonly meta: string
  readonly category: string
}

/** Theme tokens the manager needs, resolved by the caller from `ctx.theme`. */
export interface ManagerColors {
  readonly text: RGBA
  readonly subdued: RGBA
  readonly activeText: RGBA
  readonly activeBg: RGBA
}

export interface ManagerAction {
  readonly title: string
  readonly label: string
}

const transparent = RGBA.fromInts(0, 0, 0, 0)

/**
 * The wait manager, a hand-built copy of the host's DialogSelect.
 *
 * The plugin-facing `ui.dialog.select` forwards only title, placeholder,
 * options and current — not `actions` or `footerHints` — so a list with an
 * action footer and direct keybinds has to be rendered by the plugin itself.
 * Layout and tokens are lifted from packages/tui/src/ui/dialog-select.tsx so
 * it reads as native: rows at paddingLeft 3 with the active row painted
 * background.action.primary.focused, category headers indented 3, footer
 * hints as bold title plus subdued key at paddingLeft 4.
 *
 * Keys live in a keymap layer in tui.ts, enabled only while this is open;
 * enter is the search input's own submit.
 */
export const Manager = (props: {
  readonly title: string
  readonly rows: ReadonlyArray<ManagerRow>
  readonly index: number
  readonly empty: string
  readonly actions: ReadonlyArray<ManagerAction>
  readonly colors: ManagerColors
  readonly onQuery: (value: string) => void
  readonly onSubmit: () => void
}): JSX.Element => (
  <box flexDirection="column">
    <box flexDirection="row" justifyContent="space-between" paddingLeft={4} paddingRight={2}>
      <text fg={props.colors.text}>{props.title}</text>
      <text fg={props.colors.subdued}>esc</text>
    </box>

    <box paddingLeft={4} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <input
        focused
        placeholder="Search"
        placeholderColor={props.colors.subdued}
        onInput={(value) => props.onQuery(value)}
        onSubmit={() => props.onSubmit()}
      />
    </box>

    {props.rows.length === 0 ? (
      <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
        <text fg={props.colors.subdued}>{props.empty}</text>
      </box>
    ) : (
      <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
        {props.rows.map((row, index) => (
          <>
            {(index === 0 || props.rows[index - 1]?.category !== row.category) && (
              <box paddingLeft={3} paddingTop={index > 0 ? 1 : 0}>
                <text fg={props.colors.subdued}>{row.category}</text>
              </box>
            )}
            <box
              flexDirection="row"
              paddingLeft={3}
              paddingRight={3}
              backgroundColor={index === props.index ? props.colors.activeBg : transparent}
            >
              <text
                flexGrow={1}
                wrapMode="none"
                fg={index === props.index ? props.colors.activeText : props.colors.text}
                bg={index === props.index ? props.colors.activeBg : transparent}
              >
                {index === props.index ? <b>{row.title}</b> : row.title}
                <span
                  style={{
                    fg: index === props.index ? props.colors.activeText : props.colors.subdued,
                  }}
                >
                  {` ${row.meta}`}
                </span>
              </text>
            </box>
          </>
        ))}
      </box>
    )}

    <box flexDirection="row" gap={2} paddingLeft={4} paddingRight={2}>
      {props.actions.map((action) => (
        <text>
          <b style={{ fg: props.colors.text }}>{action.title} </b>
          <span style={{ fg: props.colors.subdued }}>{action.label}</span>
        </text>
      ))}
    </box>
  </box>
)
