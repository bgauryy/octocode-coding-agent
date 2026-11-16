import type { KeybindingsManager } from "@octocodeai/octocode-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui/text";
import type { McpExposure } from "@octocodeai/octocode-contracts/mcp-server";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { formatAudit } from "@octocodeai/octocode-common/tool-audit";
import { MCP_EXPOSURES } from "../../../../mcp/src/api.ts";
import type { Theme } from "../../theme/theme.ts";
import { shortcutText } from "../shared/keys.ts";
import { moveHint, type RankedHint, renderHintLine } from "../../theme/theme-tui-helpers.ts";
import type { McpToolRow, McpServerView, McpToolsSource } from "./mcp-tools.ts";
import type { McpWriteScope } from "../../configuration/adapters/mcp-pins.ts";

/** Tab: direct, then deferred, then hidden, then direct again. */
function nextExposure(state: McpExposure): McpExposure {
	return MCP_EXPOSURES[(MCP_EXPOSURES.indexOf(state) + 1) % MCP_EXPOSURES.length];
}

/**
 * Space: a visible tool is hidden; a hidden one returns to the server's default (its pin is removed). When that
 * default is hidden too, the tool is pinned `direct` instead, so the key always changes what the row shows.
 */
function spaceExposure(row: McpToolRow, defaultState: McpExposure): McpExposure | null {
	if (row.state !== "hidden") return "hidden";
	return row.pin && defaultState !== "hidden" ? null : "direct";
}

/** The rows above the tools: `Available to` and `Default for tools`. */
const SERVER_ROWS = 2;

export type McpToolsResult = "stay" | "back";

/** The tool rows of one MCP server, plus its `Available to` and `Default for tools` rows. Writes happen as each key is pressed. */
export class McpToolsView {
	private view: McpServerView;
	/** 0 is the `Available to` row, 1 the `Default for tools` row; tool `n` is row `n + 2`. */
	private selected = 0;
	private visibleRows = 5;
	private flash: { text: string; level: "success" | "warning" } | undefined;
	private wrote = false;
	private readonly server: string;
	private readonly source: McpToolsSource;
	private readonly scope: McpWriteScope;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	constructor(server: string, source: McpToolsSource, scope: McpWriteScope, theme: Theme, keys: KeybindingsManager) {
		this.server = server;
		this.source = source;
		this.scope = scope;
		this.theme = theme;
		this.keys = keys;
		this.view = source.view(server, scope);
	}

	/** Whether a change was saved while this view was open. */
	get changed(): boolean {
		return this.wrote;
	}

	private get rowCount(): number {
		return this.view.tools.length + SERVER_ROWS;
	}

	private write(action: () => string): void {
		if (this.view.blocked) {
			this.flash = { text: this.view.blocked, level: "warning" };
			return;
		}
		try {
			this.flash = { text: action(), level: "success" };
			this.wrote = true;
		} catch (error) {
			this.flash = { text: errorMessage(error), level: "warning" };
		}
		this.refresh();
	}

	private refresh(): void {
		const name = this.toolRow()?.name;
		this.view = this.source.view(this.server, this.scope);
		if (name !== undefined) {
			const index = this.view.tools.findIndex((row) => row.name === name);
			this.selected = index >= 0 ? index + SERVER_ROWS : 0;
		}
	}

	private toggleAvailable(): void {
		const every = !this.view.everyAgent;
		this.write(() => this.source.assign(this.server, this.scope, every));
	}

	private cycleDefault(): void {
		const next = nextExposure(this.view.defaultState);
		this.write(() => this.source.setExposure(this.server, this.scope, next));
	}

	private toolRow(): McpToolRow | undefined {
		return this.selected >= SERVER_ROWS ? this.view.tools[this.selected - SERVER_ROWS] : undefined;
	}

	private pin(row: McpToolRow, next: McpExposure | null): void {
		this.write(() => this.source.pin(this.server, this.scope, row.name, next));
	}

	private move(delta: number): void {
		this.selected = Math.min(this.rowCount - 1, Math.max(0, this.selected + delta));
	}

	handleInput(data: string): McpToolsResult {
		if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "tui.editor.cursorLeft")) return "back";
		const row = this.toolRow();
		if (this.keys.matches(data, "tui.select.up")) this.move(-1);
		else if (this.keys.matches(data, "tui.select.down")) this.move(1);
		else if (this.keys.matches(data, "tui.select.pageUp")) this.move(-this.visibleRows);
		else if (this.keys.matches(data, "tui.select.pageDown")) this.move(this.visibleRows);
		else if (data === " " || this.keys.matches(data, "tui.select.confirm")) {
			if (row) this.pin(row, spaceExposure(row, this.view.defaultState));
			else if (this.selected === 0) this.toggleAvailable();
			else this.cycleDefault();
		} else if (this.keys.matches(data, "tui.input.tab")) {
			if (row) this.pin(row, nextExposure(row.state));
			else if (this.selected === 0) this.toggleAvailable();
			else this.cycleDefault();
		}
		return "stay";
	}

	private rowLine(row: McpToolRow, selected: boolean): string {
		const t = this.theme;
		const box =
			row.state === "direct"
				? t.fg("success", "[x]")
				: row.state === "deferred"
					? t.fg("accent", "[~]")
					: t.fg("dim", "[ ]");
		const name = sanitizeTerminalText(row.name);
		const pending = row.live !== undefined && row.live !== row.state ? " · from the next session" : "";
		const audit = row.audit ? ` · ${formatAudit(row.audit)}${row.audit.reason ? ` · ${row.audit.reason}` : ""}` : "";
		const note = `${row.state}${row.pin ? " · pinned" : ""}${pending}${audit}`;
		return `${selected ? t.fg("accent", "> ") : "  "}${box} ${selected ? t.bold(name) : name}  ${t.fg("dim", note)}`;
	}

	private availableText(): string {
		return this.view.everyAgent ? "every agent" : "only agents that name it";
	}

	/** The lines between the picker's borders, at most `height` of them. */
	render(width: number, height: number): string[] {
		const t = this.theme;
		const w = Math.max(20, width);
		const view = this.view;
		const lines: string[] = [];
		const push = (line: string) => lines.push(truncateToWidth(line, w, "…"));
		const name = sanitizeTerminalText(view.name);
		push(` ${t.fg("accent", t.bold(`Harness › MCPs › ${name}`))}`);
		const count = `${view.tools.length} tool${view.tools.length === 1 ? "" : "s"}`;
		push(
			t.fg(
				"muted",
				` ${view.connected ? "connected" : "not connected"} · ${count}${view.target ? ` · writes ${view.target}` : ""}`,
			),
		);
		if (!view.connected)
			push(t.fg("muted", " Connect to list tools: switch the server on in MCPs. Showing pinned tools only."));
		const footer: string[] = [];
		const selectedRow = this.toolRow();
		if (height >= 12 && this.selected === 0)
			footer.push(
				...wrapTextWithAnsi(
					`Every agent: its default tool selection includes this server. Only agents that name it: just agents whose profile tools: lists mcp__${sanitizeTerminalText(view.name)}__ get it; pick that per agent in the profile.`,
					w - 2,
				)
					.slice(0, 3)
					.map((line) => t.fg("dim", ` ${line}`)),
			);
		if (this.flash)
			footer.push(
				...wrapTextWithAnsi(sanitizeTerminalText(this.flash.text), w - 2)
					.slice(0, 3)
					.map((line) => t.fg(this.flash!.level, ` ${line}`)),
			);
		const hints: RankedHint[] = [
			moveHint(2),
			["Space", selectedRow ? "hide/show" : "switch", 0],
			...(selectedRow || this.selected === 1
				? ([[shortcutText("tui.input.tab", this.keys), "direct/deferred/hidden", 1]] as RankedHint[])
				: []),
			["←/Esc", "back", 0],
		];
		footer.push(renderHintLine(hints, w));
		const rows: string[] = [
			`${this.selected === 0 ? t.fg("accent", "> ") : "  "}Available to: ${this.selected === 0 ? t.bold(this.availableText()) : this.availableText()}`,
			`${this.selected === 1 ? t.fg("accent", "> ") : "  "}Default for tools: ${this.selected === 1 ? t.bold(view.defaultState) : view.defaultState}`,
			...view.tools.map((row, index) => this.rowLine(row, index + SERVER_ROWS === this.selected)),
		];
		const available = Math.max(1, height - lines.length - footer.length);
		this.visibleRows = available;
		const start = Math.max(0, Math.min(this.selected - Math.floor(available / 2), rows.length - available));
		for (const row of rows.slice(start, start + available)) push(row);
		for (const line of footer) push(line);
		return lines.slice(0, height);
	}
}
