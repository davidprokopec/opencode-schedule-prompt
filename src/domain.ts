import type { Session } from "@opencode-ai/schema/session"
import type { Duration } from "effect"

/**
 * Identifier of a pending wait, unique per plugin activation.
 *
 * Kept short and human typeable (`w1`, `w2`, ...) because the user cancels a
 * wait by pasting it back into `/wait-cancel`.
 */
export type WaitID = string

/** A prompt that has been accepted but is not delivered to the session yet. */
export interface Wait {
  readonly id: WaitID
  readonly sessionID: Session.ID
  readonly prompt: string
  readonly duration: Duration.Duration
  /** Epoch millis when the wait was created. */
  readonly createdAt: number
  /** Epoch millis when the prompt is delivered. */
  readonly firesAt: number
}
