/**
 * TUI component for managing package resources (enable/disable)
 */

import { Container, type Focusable, Spacer } from "@octocodeai/octocode-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { buildGroups, type ConfigWriteScope, type ScopedResolvedPaths } from "./config-selector/groups.ts";
import { ConfigSelectorHeader } from "./config-selector/header.ts";
import { ResourceList } from "./config-selector/resource-list.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export type { ScopedResolvedPaths } from "./config-selector/groups.ts";

export class ConfigSelectorComponent extends Container implements Focusable {
	private header: ConfigSelectorHeader;
	private resourceList: ResourceList;
	private writeScope: ConfigWriteScope;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.resourceList.focused = value;
	}

	constructor(
		resolvedPaths: ScopedResolvedPaths,
		settingsManager: SettingsManager,
		cwd: string,
		agentDir: string,
		onClose: () => void,
		onExit: () => void,
		requestRender: () => void,
		terminalHeight?: number,
		writeScope: ConfigWriteScope = "global",
		projectModeAvailable = true,
	) {
		super();

		this.writeScope = writeScope;
		const groupsByScope = {
			global: buildGroups(resolvedPaths.global, agentDir),
			project: buildGroups(resolvedPaths.project, agentDir),
		};

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.header = new ConfigSelectorHeader(this.writeScope, projectModeAvailable);
		this.addChild(this.header);
		this.addChild(new Spacer(1));

		// Resource list
		this.resourceList = new ResourceList(
			groupsByScope,
			settingsManager,
			cwd,
			agentDir,
			terminalHeight,
			this.writeScope,
		);
		this.resourceList.onCancel = onClose;
		this.resourceList.onExit = onExit;
		this.resourceList.onToggle = () => requestRender();
		if (projectModeAvailable) {
			this.resourceList.onSwitchMode = () => {
				this.switchWriteScope();
				requestRender();
			};
		}
		this.addChild(this.resourceList);

		// Bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private switchWriteScope(): void {
		this.writeScope = this.writeScope === "global" ? "project" : "global";
		this.header.setWriteScope(this.writeScope);
		this.resourceList.setWriteScope(this.writeScope);
	}

	getResourceList(): ResourceList {
		return this.resourceList;
	}
}
