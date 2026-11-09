import { Container, type SettingItem, SettingsList, Text } from "@octocodeai/octocode-tui";
import { appliesText, formatResult } from "../../../configuration/command.ts";
import type { ConfigEntry, ConfigOp, ConfigResult, ConfigScope } from "../../../configuration/index.ts";
import { getSettingsListTheme, theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { ExtensionInputComponent } from "./extension-input.ts";

export type SelectorScope = Exclude<ConfigScope, "run">;

export interface ConfigurationSelectorOptions {
	entries: readonly ConfigEntry[];
	/** Applies one change through the catalog; a refusal is a result, not an exception. */
	apply(op: ConfigOp): Promise<ConfigResult>;
	/** The entry as it is now, after a change. */
	get(id: string): Promise<ConfigEntry | undefined>;
	onClose(): void;
	requestRender(): void;
	/** Whether project scope can be written (the folder is trusted). */
	projectAvailable: boolean;
	scope?: SelectorScope;
	/** Rows that open their own live editor, such as the interface settings that apply to the running terminal. */
	extraItems?: readonly SettingItem[];
}

const MAX_VISIBLE = 12;

/** What the row shows for `entry` in `scope`: that scope's own value, else the value that applies. */
function shown(entry: ConfigEntry, scope: SelectorScope): string {
	const value = entry.scopes[scope] ?? entry.value;
	const type = entry.valueType.type;
	if (type === "toggle") return value === false ? "off" : "on";
	if (value === undefined) return "(unset)";
	return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * `/configuration` with no arguments: every catalog entry grouped by kind (the list is sorted by kind, ids start with it).
 * Enter or Space toggles or cycles a value, or opens an input for a number, text or JSON; Tab switches between global and
 * project scope; typing filters.
 */
export class ConfigurationSelectorComponent extends Container {
	private scope: SelectorScope;
	private entries: Map<string, ConfigEntry>;
	private list: SettingsList;
	private readonly header = new Text("", 1, 0);
	private readonly notice = new Text("", 1, 0);

	private readonly options: ConfigurationSelectorOptions;

	constructor(options: ConfigurationSelectorOptions) {
		super();
		this.options = options;
		this.scope = options.scope ?? "global";
		this.entries = new Map(options.entries.map((entry) => [entry.id, entry]));
		this.list = this.buildList();
		this.rebuild();
	}

	getScope(): SelectorScope {
		return this.scope;
	}

	private rebuild(): void {
		this.clear();
		this.header.setText(this.headerText());
		this.addChild(new DynamicBorder());
		this.addChild(this.header);
		this.addChild(this.list);
		this.addChild(this.notice);
		this.addChild(new DynamicBorder());
	}

	private headerText(): string {
		const other = this.scope === "global" ? "project" : "global";
		const tab = this.options.projectAvailable ? `Tab: ${other}` : "project scope needs a trusted folder";
		return `${theme.fg("accent", "Configuration")}  ${theme.fg("muted", `writes ${this.scope} (${tab})`)}`;
	}

	private item(entry: ConfigEntry): SettingItem {
		const base: SettingItem = {
			id: entry.id,
			label: entry.locked ? `${entry.id} (locked)` : entry.id,
			description: [
				entry.description,
				`set by ${entry.setBy}; ${appliesText(entry.appliesWhen)}.`,
				entry.locked,
				entry.detail,
			]
				.filter(Boolean)
				.join(" "),
			currentValue: shown(entry, this.scope),
		};
		if (entry.locked) return base;
		const type = entry.valueType;
		if (type.type === "toggle") return { ...base, values: ["on", "off"] };
		if (type.type === "boolean") return { ...base, values: ["true", "false"] };
		if (type.type === "enum") return { ...base, values: [...type.values] };
		return {
			...base,
			submenu: (current, done) =>
				new ExtensionInputComponent(
					`${entry.id} (${this.scope})`,
					undefined,
					(value) => done(value.trim()),
					() => done(),
					{
						initialValue: current === "(unset)" ? "" : current,
						description: "Empty removes the value from this scope.",
					},
				),
		};
	}

	private buildList(): SettingsList {
		const items = [...(this.options.extraItems ?? []), ...[...this.entries.values()].map((entry) => this.item(entry))];
		return new SettingsList(
			items,
			MAX_VISIBLE,
			getSettingsListTheme(),
			(id, value) => void this.change(id, value),
			this.options.onClose,
			{ enableSearch: true },
		);
	}

	private async change(id: string, value: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) return;
		const scope = this.scope;
		const type = entry.valueType.type;
		const op: ConfigOp =
			type === "toggle"
				? { verb: value === "on" ? "enable" : "disable", id, scope }
				: value === ""
					? { verb: "unset", id, scope }
					: { verb: "set", id, value, scope };
		const result = await this.options.apply(op);
		const fresh = await this.options.get(id);
		if (fresh) {
			this.entries.set(id, fresh);
			this.list.updateValue(id, shown(fresh, scope));
		}
		const color = result.status === "applied" ? "success" : "error";
		this.notice.setText(
			formatResult(result)
				.map((line) => theme.fg(color, line))
				.join("\n"),
		);
		this.options.requestRender();
	}

	/** Tab switches the scope the next change writes to; everything else is the list's. */
	handleInput(data: string): void {
		if (data === "\t") {
			if (!this.options.projectAvailable) return;
			this.scope = this.scope === "global" ? "project" : "global";
			this.list = this.buildList();
			this.notice.setText("");
			this.rebuild();
			this.options.requestRender();
			return;
		}
		this.list.handleInput(data);
	}
}
