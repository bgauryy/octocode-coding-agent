import { resultPurposeData, type ToolDisplay } from "@octocodeai/octocode-contracts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { genericToolDisplay } from "../../core/application/transcript-display.ts";
import type { FeatureSetup, ToolDisplayFunction, ToolDisplayInput } from "../../core/features/types.ts";
import { callReasonText } from "./call-reason.ts";
import { displayText } from "../render/display.ts";
import { toolHint } from "../../utils/tool-hint.ts";

/**
 * A tool's display with Octocode's policy added: the generic display (the argument label and the result text) for a
 * tool without its own, and the reason line every surface shows, decided once here.
 */
export function octocodeToolDisplay(toolName: string, own?: ToolDisplayFunction): ToolDisplayFunction {
	return (input: ToolDisplayInput): ToolDisplay => {
		const display =
			own?.(input) ?? genericToolDisplay(toolName, toolHint(input.args), displayText(input.result), input.status);
		const reason = display.reason ?? callReasonText(toolName, input.args, resultPurposeData(asRecord(input.result)));
		return reason ? { ...display, reason } : display;
	};
}

/** Every registered tool gets a display; a call to an unknown tool keeps the host's generic one. */
export function registerToolDisplays(api: FeatureSetup): void {
	api.renderers.tool((toolName, next) => {
		const base = next();
		return base ? { ...base, display: octocodeToolDisplay(toolName, base.display?.bind(base)) } : undefined;
	});
}
