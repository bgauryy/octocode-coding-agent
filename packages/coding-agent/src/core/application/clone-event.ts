import type { ApplicationEvent } from "@octocodeai/octocode-contracts";
import { cloneDisplay } from "./normalize.ts";

/** Isolate subscriber-owned objects while sharing immutable strings, without serializing growing reply text. */
export function cloneApplicationEvent(event: ApplicationEvent): ApplicationEvent {
	if (event.type !== "message.delta") return cloneDisplay(event);
	const { text, delta, content, ...metadata } = event;
	return {
		...cloneDisplay(metadata),
		delta,
		...(text === undefined ? {} : { text }),
		...(content === undefined
			? {}
			: {
					content: content.map((block) => {
						if (!("text" in block) || block.text === undefined) return cloneDisplay(block);
						const { text, ...metadata } = block;
						return { ...cloneDisplay(metadata), text };
					}),
				}),
	};
}
