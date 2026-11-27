import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { Message } from "@octocodeai/octocode-ai/compat";
import { convertToLlm } from "../messages.ts";
import type { SettingsManager } from "../settings-manager.ts";

/** `convertToLlm` that replaces images with a text placeholder while the `blockImages` setting is on. */
export function createConvertToLlmWithBlockImages(
	settingsManager: Pick<SettingsManager, "getBlockImages">,
): (messages: AgentMessage[]) => Message[] {
	return (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) => (c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c))
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};
}
