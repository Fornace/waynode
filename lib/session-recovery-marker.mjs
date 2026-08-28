// Stable marker stored in pi's user-message entry for internal continuation
// prompts. The projection renders it as a human recovery event, never a user
// bubble, while pi still receives the instruction in its model context.
export const RECOVERY_MARKER = "<!-- waynode:recovery --> ";
