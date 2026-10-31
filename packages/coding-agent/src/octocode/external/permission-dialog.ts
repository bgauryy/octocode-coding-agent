import type { ExtensionContext } from "../../core/extensions/index.ts";
import { interactive } from "../shared/interactive.ts";
import { withDialog } from "../shared/locks.ts";
import { redactSecrets, visibleControls } from "../shared/sanitize.ts";
import type { ExternalPolicy } from "./manager.ts";

/**
 * An external ACP agent's permission request, put to the person: only `allow_once` and `reject_once` are offered (a
 * standing grant would outlive this prompt), through the one dialog queue. No UI, an abort, or no answer cancels.
 */
export const externalPermissionDialog: ExternalPolicy["permission"] =
	(ctx: ExtensionContext) => async (request, signal) => {
		const cancelled = { outcome: { outcome: "cancelled" as const } };
		if (!interactive(ctx, false) || signal.aborted) return cancelled;
		const options = request.options.filter((option) => option.kind === "allow_once" || option.kind === "reject_once");
		if (options.length === 0) return cancelled;
		return withDialog(async () => {
			if (signal.aborted) return cancelled;
			const labels = options.map((option, index) => `${index + 1}. ${visibleControls(option.name)}`);
			const details = visibleControls(redactSecrets(JSON.stringify(request.toolCall, null, 2)));
			const title = `External agent permission\n${details}`;
			const allow = options.findIndex((option) => option.kind === "allow_once");
			const reject = options.findIndex((option) => option.kind === "reject_once");
			const selected = await ctx.ui.select(title, labels, {
				signal,
				// An external agent may ask while no run is active; a person is still what it waits for.
				approval: true,
				blocking: true,
				// A transport may offer this pair without inventing an option the external agent did not advertise.
				...(allow >= 0 && reject >= 0
					? {
							permission: {
								toolCallId: request.toolCall.toolCallId,
								toolName: "external",
								targets: [details],
								allowOnce: labels[allow],
								rejectOnce: labels[reject],
							},
						}
					: {}),
			});
			if (signal.aborted) return cancelled;
			const index = selected ? labels.indexOf(selected) : -1;
			return index < 0 ? cancelled : { outcome: { outcome: "selected" as const, optionId: options[index].optionId } };
		}, signal);
	};
