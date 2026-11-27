/**
 * The permission mode names, a leaf so `--help` and flag parsing (`cli/args/flags.ts`) list them without loading the
 * mode table, its key hints and the terminal UI they come from. `mode.ts` says what each mode allows.
 */

/** From the strictest to the widest: an index comparison says which of two modes asks about more. */
export const PERMISSION_MODES = ["manual", "workspace", "full", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The modes `/permissions`, the editor shortcut and `--permission-mode` choose; `bypass` has its own start flag. */
export const CHOOSABLE_MODES = ["manual", "workspace", "full"] as const satisfies readonly PermissionMode[];
