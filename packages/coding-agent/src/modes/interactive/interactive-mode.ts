import "./mcp-ui-install.ts";
/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating execution to the application port.
 */

import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { FullscreenExitOutput } from "../../core/settings-manager.ts";
import type { LatestOctocodeRelease } from "../../utils/version-check.ts";
import { createInteractiveModeHost } from "./interactive-mode/create-host.ts";
import type { InteractiveModeHost } from "./interactive-mode/host.ts";
import * as startup from "./interactive-mode/startup.ts";
import type { InteractiveModeOptions } from "./interactive-mode/types.ts";

export { createInteractiveTui, createInteractiveTuiReference } from "./tui-renderer.ts";
export { formatCrashExtensionHint, formatResumeCommand } from "./interactive-mode/helpers.ts";
export type { InteractiveModeOptions } from "./interactive-mode/types.ts";

export class InteractiveMode {
	/** The mode's state and methods; the collaborator modules receive it and read the live state when used. */
	private readonly host: InteractiveModeHost;

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.host = createInteractiveModeHost(runtimeHost, options);
	}

	init(): Promise<void> {
		return this.host.init();
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	run(): Promise<void> {
		return startup.run(this.host);
	}

	renderInitialMessages(): void {
		this.host.renderInitialMessages();
	}

	getUserInput(): Promise<string> {
		return this.host.getUserInput();
	}

	// UI helpers

	clearEditor(): void {
		this.host.clearEditor();
	}

	showError(errorMessage: string): void {
		this.host.showError(errorMessage);
	}

	showWarning(warningMessage: string): void {
		this.host.showWarning(warningMessage);
	}

	showNewVersionNotification(release: LatestOctocodeRelease): void {
		this.host.showNewVersionNotification(release);
	}

	showPackageUpdateNotification(packages: string[]): void {
		this.host.showPackageUpdateNotification(packages);
	}

	stop(fullscreenExitOutput?: FullscreenExitOutput): void {
		this.host.stop(fullscreenExitOutput);
	}
}
