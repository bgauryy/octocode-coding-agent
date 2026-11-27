import { Type } from "typebox";
import { Value } from "typebox/value";
import { activeCommandSandbox } from "../../../../utils/command-sandbox.ts";

/** The refusal of `sandbox: false` when the `sandbox.allowUnsandboxed` setting is false. */
const UNSANDBOXED_REFUSED =
	"sandbox: false is refused: the sandbox.allowUnsandboxed setting is false, so every agent command runs sandboxed. Change the command to fit the sandbox, or ask the user to change that setting.";

const FLAG = Type.Boolean();

/**
 * Whether a call's `sandbox` field asks to run outside the sandbox, read as argument validation will coerce it (`"false"`,
 * `0` and `"0"` become `false`). Only `true` (or a value that coerces to it) and an absent field (`null` counts as absent)
 * keep the command sandboxed; anything else asks, so no spelling slips past the gate as sandboxed.
 */
export function asksUnsandboxed(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	return Value.Convert(FLAG, value) !== true;
}

/**
 * Throws when the call asks to run outside the sandbox (`asksUnsandboxed`) and `sandbox.allowUnsandboxed` is false. Run
 * on the raw arguments, before the permission gate would ask, and again on the validated ones before the command starts.
 */
export function refuseUnsandboxed(value: unknown): void {
	if (asksUnsandboxed(value) && activeCommandSandbox()?.allowsUnsandboxed === false)
		throw new Error(UNSANDBOXED_REFUSED);
}
