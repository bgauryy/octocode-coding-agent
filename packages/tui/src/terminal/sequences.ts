/** Escape sequences both renderers and the base TUI read or write. */

/** What a terminal with focus reporting (`?1004h`) sends when it gains focus. */
export const FOCUS_IN = "\x1b[I";
/** What a terminal with focus reporting sends when it loses focus. */
export const FOCUS_OUT = "\x1b[O";
/** Begin a synchronized update (mode 2026): the terminal shows the frame once it ends. */
export const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
/** End a synchronized update. */
export const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
/** Leading OSC 133 prompt, command and output marks of a row (BEL or ST terminated). */
export const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
/** An OSC 133 prompt-start mark at the start of a row. */
export const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
