import { envFlag, PARENT_ID_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { inputOrigin } from "../../core/input-origin.ts";
import { EXTERNAL_MESSAGE_TYPE } from "../shared/messages.ts";
import type { FeatureSetup } from "../../core/features/index.ts";
import type { LiveLoop } from "../events/loop/live.ts";
import { makeSource, userSource, withSource } from "../events/source.ts";
import type { Held } from "./gate.ts";

/** The loop's record of a typed input: the session queues the text itself, so nothing is left to send for it. */
const NOTHING_TO_SEND: Held = {
	labels: [],
	message: { customType: "octocode-input", content: "", display: false },
	options: {},
	done: { resolve: () => undefined, reject: () => undefined },
};

/**
 * Each prompt a user sends joins the loop as Q1 with
 * the channel it came from, so the coalescing window never holds it: the events the window holds go out with it, behind it
 * in order. The text itself still takes the session's own prompt path (images, queueing, compaction hold) and reaches the
 * model with its source header, which says whether it carries the user's authority (only the terminal does).
 *
 * Input a feature sends (`source: feature`) is not the user's and is left as it is. A skill or template command starts with
 * `/` and is expanded after this handler runs, so it takes no header.
 */
export function installLiveInput(api: FeatureSetup, loop: () => LiveLoop<Held> | undefined): void {
	api.bus.on("before_agent_start", async (event) => {
		// Admission, the permission ceiling, and the sender's reply receipt belong to the API-started run.
		if (event.messageType === "custom" && event.message.customType === EXTERNAL_MESSAGE_TYPE)
			await loop()?.joinStartingRun();
	});
	api.bus.on("input", async (event) => {
		const live = loop();
		if (!live || event.source === "feature") return { action: "continue" as const };
		const origin = inputOrigin();
		const channel = origin === "terminal" && event.source === "rpc" ? "rpc" : origin;
		// A child receives its assignment through the CLI. It already carries its parent's identity.
		const assignment = channel === "terminal" && envFlag(process.env, SUBAGENT_ENV);
		const source = assignment
			? makeSource("peer", process.env[PARENT_ID_ENV] ?? "parent", "in-process", "self-reported")
			: userSource(channel);
		live.input(event.text, NOTHING_TO_SEND, source);
		const handoff = live.pendingHandoff();
		if (handoff) await handoff;
		if (assignment || event.text.startsWith("/")) return { action: "continue" as const };
		return { action: "transform" as const, text: withSource({ content: event.text }, [source]).content };
	});
}
