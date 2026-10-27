import { CACHE_RETENTIONS } from "@octocodeai/octocode-ai/providers/model-schema";
import type { ImageProtocol, SettingItem } from "@octocodeai/octocode-tui";
import type { SettingsCallbacks, SettingsConfig } from "./types.ts";

/** Add cache, image, editor and terminal items at their positions in the main settings list. */
export function addConditionalItems(
	items: SettingItem[],
	config: SettingsConfig,
	callbacks: SettingsCallbacks,
	supportsImages: ImageProtocol,
): void {
	if (config.cachePreferences && callbacks.onCachePreferenceChange) {
		for (const [field, label] of [
			["instructionCacheRetention", "Instruction cache retention"],
			["cacheRetention", "History cache retention"],
		] as const) {
			items.push({
				id: field,
				label,
				currentValue: config.cachePreferences[field] ?? "short",
				values: [...CACHE_RETENTIONS],
				description:
					"Saved default; environment and model overrides take priority. Long writes may cost more. See /session for effective durations.",
			});
		}
	}

	// Only show image toggle if terminal supports it
	if (supportsImages) {
		items.splice(0, 0, {
			id: "show-images",
			label: "Show images",
			description: "Render images inline in terminal",
			currentValue: config.showImages ? "true" : "false",
			values: ["true", "false"],
		});
		items.splice(2, 0, {
			id: "image-width-cells",
			label: "Image width",
			description: "Preferred inline image width in terminal cells",
			currentValue: String(config.imageWidthCells),
			values: ["60", "80", "120"],
		});
	}

	// Image auto-resize toggle (always available, affects both attached and read images)
	items.splice(supportsImages ? 3 : 1, 0, {
		id: "auto-resize-images",
		label: "Auto-resize images",
		description: "Resize large images to 2000x2000 max for better model compatibility",
		currentValue: config.autoResizeImages ? "true" : "false",
		values: ["true", "false"],
	});

	// Block images toggle (always available, insert after auto-resize-images)
	const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
	items.splice(autoResizeIndex + 1, 0, {
		id: "block-images",
		label: "Block images",
		description: "Prevent images from being sent to LLM providers",
		currentValue: config.blockImages ? "true" : "false",
		values: ["true", "false"],
	});

	// Skill commands toggle (insert after block-images)
	const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
	items.splice(blockImagesIndex + 1, 0, {
		id: "skill-commands",
		label: "Skill commands",
		description: "Register skills as /skill:name commands",
		currentValue: config.enableSkillCommands ? "true" : "false",
		values: ["true", "false"],
	});

	// Hardware cursor toggle (insert after skill-commands)
	const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
	items.splice(skillCommandsIndex + 1, 0, {
		id: "show-hardware-cursor",
		label: "Show hardware cursor",
		description: "Use the terminal cursor instead of Octocode's drawn cursor",
		currentValue: config.showHardwareCursor ? "true" : "false",
		values: ["true", "false"],
	});

	// Editor padding toggle (insert after show-hardware-cursor)
	const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
	items.splice(hardwareCursorIndex + 1, 0, {
		id: "editor-padding",
		label: "Editor padding",
		description: "Horizontal padding for input editor (0-3)",
		currentValue: String(config.editorPaddingX),
		values: ["0", "1", "2", "3"],
	});

	// Output padding toggle (insert after editor-padding)
	const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
	items.splice(editorPaddingIndex + 1, 0, {
		id: "output-padding",
		label: "Output padding",
		description: "Horizontal padding for messages, tool output, and command output",
		currentValue: String(config.outputPad),
		values: ["0", "1"],
	});

	// Autocomplete max visible toggle (insert after output-padding)
	const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
	items.splice(outputPaddingIndex + 1, 0, {
		id: "autocomplete-max-visible",
		label: "Autocomplete max items",
		description: "Max visible items in autocomplete dropdown (3-20)",
		currentValue: String(config.autocompleteMaxVisible),
		values: ["3", "5", "7", "10", "15", "20"],
	});

	// Clear on shrink toggle (insert after autocomplete-max-visible)
	const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
	items.splice(autocompleteIndex + 1, 0, {
		id: "clear-on-shrink",
		label: "Clear on shrink",
		description: "Clear empty rows when content shrinks (may cause flicker)",
		currentValue: config.clearOnShrink ? "true" : "false",
		values: ["true", "false"],
	});

	// Terminal progress toggle (insert after clear-on-shrink)
	const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
	items.splice(clearOnShrinkIndex + 1, 0, {
		id: "terminal-progress",
		label: "Terminal progress",
		description: "Show OSC 9;4 progress indicators in the terminal tab bar",
		currentValue: config.showTerminalProgress ? "true" : "false",
		values: ["true", "false"],
	});

	// Reduce motion (insert after terminal-progress)
	const terminalProgressIndex = items.findIndex((item) => item.id === "terminal-progress");
	items.splice(terminalProgressIndex + 1, 0, {
		id: "reduce-motion",
		label: "Reduce motion",
		description: "Freeze spinners and shimmer; elapsed times still update (auto follows OCTOCODE_REDUCE_MOTION)",
		currentValue: String(config.reduceMotion),
		values: ["auto", "true", "false"],
	});
}
