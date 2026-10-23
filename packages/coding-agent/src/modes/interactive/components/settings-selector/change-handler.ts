import type { Transport } from "@octocodeai/octocode-ai";
import type { CachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import type { ScrollViewScrollbar } from "@octocodeai/octocode-tui";
import { HTTP_IDLE_TIMEOUT_CHOICES } from "../../../../core/http-dispatcher.ts";
import type {
	CacheWarmingMode,
	DefaultProjectTrust,
	FullscreenExitOutput,
	MermaidRenderingMode,
	TuiMode,
} from "../../../../core/settings-manager.ts";
import type { SettingsCallbacks } from "./types.ts";

export const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

/** Route a changed settings-list value to its callback. */
export function applySettingChange(callbacks: SettingsCallbacks, id: string, newValue: string): void {
	switch (id) {
		case "cacheRetention":
		case "instructionCacheRetention":
			callbacks.onCachePreferenceChange?.(id, newValue as NonNullable<CachePreferences[typeof id]>);
			break;
		case "show-images":
			callbacks.onShowImagesChange(newValue === "true");
			break;
		case "image-width-cells":
			callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
			break;
		case "auto-resize-images":
			callbacks.onAutoResizeImagesChange(newValue === "true");
			break;
		case "block-images":
			callbacks.onBlockImagesChange(newValue === "true");
			break;
		case "skill-commands":
			callbacks.onEnableSkillCommandsChange(newValue === "true");
			break;
		case "steering-mode":
			callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
			break;
		case "follow-up-mode":
			callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
			break;
		case "transport":
			callbacks.onTransportChange(newValue as Transport);
			break;
		case "http-idle-timeout": {
			const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
			if (choice) {
				callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
			}
			break;
		}
		case "cache-warming-mode":
			callbacks.onCacheWarmingModeChange(newValue as CacheWarmingMode);
			break;
		case "hide-thinking":
			callbacks.onHideThinkingBlockChange(newValue === "true");
			break;
		case "mermaid-rendering":
			callbacks.onMermaidRenderingModeChange(newValue as MermaidRenderingMode);
			break;
		case "cache-miss-notices":
			callbacks.onShowCacheMissNoticesChange(newValue === "true");
			break;
		case "collapse-changelog":
			callbacks.onCollapseChangelogChange(newValue === "true");
			break;
		case "quiet-startup":
			callbacks.onQuietStartupChange(newValue === "header" ? "header" : newValue === "true");
			break;
		case "install-telemetry":
			callbacks.onEnableInstallTelemetryChange(newValue === "true");
			break;
		case "default-project-trust": {
			const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
			if (defaultProjectTrust) {
				callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
			}
			break;
		}
		case "double-escape-action":
			callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
			break;
		case "tree-filter-mode":
			callbacks.onTreeFilterModeChange(newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all");
			break;
		case "show-hardware-cursor":
			callbacks.onShowHardwareCursorChange(newValue === "true");
			break;
		case "editor-padding":
			callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
			break;
		case "output-padding":
			callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
			break;
		case "autocomplete-max-visible":
			callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
			break;
		case "clear-on-shrink":
			callbacks.onClearOnShrinkChange(newValue === "true");
			break;
		case "terminal-progress":
			callbacks.onShowTerminalProgressChange(newValue === "true");
			break;
		case "tui-mode":
			callbacks.onTuiModeChange(newValue as TuiMode);
			break;
		case "fullscreen-exit-output":
			callbacks.onFullscreenExitOutputChange(newValue as FullscreenExitOutput);
			break;
		case "fullscreen-scrollbar":
			callbacks.onFullscreenScrollbarChange(newValue as ScrollViewScrollbar);
			break;
		case "fullscreen-copy-on-select":
			callbacks.onFullscreenCopyOnSelectChange(newValue === "true");
			break;
		case "fullscreen-wheel-scroll-lines":
			callbacks.onFullscreenWheelScrollLinesChange(newValue === "auto" ? "auto" : parseInt(newValue, 10));
			break;
		case "theme":
			callbacks.onThemeChange(newValue);
			break;
	}
}
