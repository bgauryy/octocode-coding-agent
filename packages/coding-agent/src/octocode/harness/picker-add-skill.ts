import { Input, type KeybindingsManager, truncateToWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Theme } from "../../theme/theme.ts";
import { shortcutText } from "../shared/keys.ts";

/** A folder of skills, scanned and ready to save: the preview text, and the folder as it is written to settings. */
export interface SkillFolderPreview {
	folder: string;
	lines: string[];
}

/** What the page asks of its host: scan a folder (throws a user-facing message), and save one that was scanned. */
export interface AddSkillActions {
	preview: (input: string) => SkillFolderPreview;
	save: (folder: string) => string;
}

/**
 * The "+ Add skill from a folder" page: a path, then the scan of the skills it holds, then Enter saves. Esc steps back
 * (from the scan to the path) or leaves; nothing is written before the last Enter.
 */
export class AddSkillPage {
	readonly title = "Add skill from a folder";
	private readonly input = new Input({ prompt: " Folder: ", placeholder: "~/path/to/skills" });
	private scanned: SkillFolderPreview | undefined;
	private problem: string | undefined;
	private readonly actions: AddSkillActions;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly saved: (message: string) => void;
	constructor(actions: AddSkillActions, theme: Theme, keys: KeybindingsManager, saved: (message: string) => void) {
		this.saved = saved;
		this.actions = actions;
		this.theme = theme;
		this.keys = keys;
		this.input.focused = true;
	}

	/** True when the page is finished (saved, or cancelled with nothing written); false: it stays open. */
	handleInput(data: string): boolean {
		if (this.keys.matches(data, "tui.select.cancel")) {
			if (!this.scanned) return true;
			this.scanned = undefined;
			return false;
		}
		if (!this.keys.matches(data, "tui.select.confirm")) {
			if (!this.scanned) {
				this.problem = undefined;
				this.input.handleInput(data);
			}
			return false;
		}
		try {
			if (this.scanned) {
				this.saved(this.actions.save(this.scanned.folder));
				return true;
			}
			this.scanned = this.actions.preview(this.input.getValue());
			this.problem = undefined;
		} catch (error) {
			this.problem = errorMessage(error);
		}
		return false;
	}

	render(width: number, height: number): string[] {
		const t = this.theme;
		const body = this.scanned
			? this.scanned.lines.flatMap((line) =>
					wrapTextWithAnsi(sanitizeTerminalText(line), width - 2).map((l) => ` ${l}`),
				)
			: [
					...this.input.render(width),
					...(this.problem ? [t.fg("warning", ` ${sanitizeTerminalText(this.problem)}`)] : []),
				];
		const hint = this.scanned
			? ` Enter add · ${shortcutText("tui.select.cancel", this.keys)} back (nothing is written)`
			: ` Enter scan · ${shortcutText("tui.select.cancel", this.keys)} cancel`;
		const lines = [` ${t.fg("accent", t.bold(this.title))}`, ...body].slice(0, Math.max(1, height - 1));
		return [...lines, t.fg("muted", hint)].map((line) => truncateToWidth(line, width, "…"));
	}
}
