import { PERMISSION_MODES, type PermissionMode } from "../mode.ts";

/** The stricter of two modes: the one that asks about more. */
const stricterMode = (a: PermissionMode, b: PermissionMode): PermissionMode =>
	PERMISSION_MODES[Math.min(PERMISSION_MODES.indexOf(a), PERMISSION_MODES.indexOf(b))];

/** The mode that judges a call held to `ceiling`: the stricter of the two, except that `bypass` is never held. */
export const heldTo = (mode: PermissionMode, ceiling: PermissionMode): PermissionMode =>
	mode === "bypass" ? mode : stricterMode(mode, ceiling);

/**
 * A ceiling on the session's mode while one turn runs: work an unverified caller started (the local session API) is held
 * to it, so a session in `full` asks about, or refuses, what the ceiling asks about. It only tightens: a session already
 * stricter keeps its own mode, and the user's mode choice is never changed.
 */
export class TurnCap {
	#ceiling: PermissionMode | undefined;

	/** Holds calls to at most `ceiling` until `set(undefined)`. */
	set(ceiling: PermissionMode | undefined): void {
		this.#ceiling = ceiling;
	}

	get active(): PermissionMode | undefined {
		return this.#ceiling;
	}

	/** The mode that judges a call while the cap holds. */
	apply(mode: PermissionMode): PermissionMode {
		return this.#ceiling ? heldTo(mode, this.#ceiling) : mode;
	}
}
