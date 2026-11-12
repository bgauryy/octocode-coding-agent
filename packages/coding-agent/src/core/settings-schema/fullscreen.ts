import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** The fullscreen-mode settings of the root schema. */
export const FullscreenSettingsProperties = {
	fullscreenExitOutput: Type.Optional(
		Type.Union([Type.Literal("transcript"), Type.Literal("resume-hint")], {
			description: "No effect in regular TUI mode.",
			default: SETTINGS_DEFAULTS.fullscreenExitOutput,
		}),
	),
	fullscreenScrollbar: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("hidden")], {
			description: "No effect in regular TUI mode.",
			default: SETTINGS_DEFAULTS.fullscreenScrollbar,
		}),
	),
	fullscreenCopyOnSelect: Type.Optional(
		Type.Boolean({
			description: "No effect in regular TUI mode.",
			default: SETTINGS_DEFAULTS.fullscreenCopyOnSelect,
		}),
	),
	fullscreenWheelScrollLines: Type.Optional(
		Type.Union([Type.Number(), Type.Literal("auto")], {
			description: "Lines scrolled per wheel event in fullscreen mode; numeric values are clamped from 1 to 100.",
			default: SETTINGS_DEFAULTS.fullscreenWheelScrollLines,
		}),
	),
	fullscreenFrameQueueLimitKiB: Type.Optional(
		Type.Number({
			description:
				"Queued output in KiB past which fullscreen frames are dropped while the terminal is not reading, then repainted whole once it reads again; 0 keeps every frame. Clamped to 64 to 65536.",
			default: SETTINGS_DEFAULTS.fullscreenFrameQueueLimitKiB,
		}),
	),
};
