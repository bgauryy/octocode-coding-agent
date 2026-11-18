import { type Component, Container, type TUI, Text, animationClock, createChatViewport, setKeybindings } from "@octocodeai/octocode-tui";
import type { StatusEntry } from "../../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { SessionInfo } from "../../src/core/session-manager.ts";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { QueueListComponent } from "../../src/modes/interactive/components/queue-list.ts";
import { SessionSelectorComponent } from "../../src/modes/interactive/components/session-selector.ts";
import { WorkingStatusIndicator } from "../../src/modes/interactive/components/status-indicator.ts";
import { UserMessageComponent } from "../../src/modes/interactive/components/user-message.ts";
import { STATUS } from "../../src/octocode/shared/status.ts";
import { footerLines, type FooterState } from "../../src/octocode/ui/footer/rows.ts";
import { CustomEditor } from "../../src/theme/custom-editor.ts";
import { loadTheme } from "../../src/theme/theme-loader.ts";
import { setTerminalColors } from "../../src/theme/theme-terminal.ts";
import { getEditorTheme, setThemeInstance, theme } from "../../src/theme/theme.ts";
import { qaTool } from "./tui-design-qa-tools.ts";
import { qaTranscript } from "./tui-design-qa-transcript.ts";

export const QA_STATES = ["idle", "running", "warning", "error", "queue", "session-picker", "tool-queries", "tool-results", "transcript-tools", "transcript-messages"] as const;
export interface QaConfig {
	theme: "dark" | "light";
	width: 40 | 80 | 120;
	mode: "regular" | "fullscreen";
	state: (typeof QA_STATES)[number];
}
export const QA_MATRIX: QaConfig[] = (["dark", "light"] as const).flatMap((theme) =>
	([40, 80, 120] as const).flatMap((width) => (["regular", "fullscreen"] as const).flatMap((mode) =>
		QA_STATES.map((state) => ({ theme, width, mode, state })))),
);
export const qaId = (config: QaConfig) => `${config.theme}-${config.width}-${config.mode}-${config.state}`;

function syntheticFooter(config: QaConfig): Component {
	const storage: StatusEntry = config.state === "error"
		? { text: "Database unavailable", tone: "error" }
		: config.state === "warning" ? { text: "Session save delayed", tone: "warning" }
			: { text: "Session saved", tone: "success" };
	const state: FooterState = {
		model: "qa-model", kind: "local", thinking: "high",
		context: { percent: config.state === "error" ? 92 : config.state === "warning" ? 65 : 12.5, limit: 200_000 },
		usage: { input: 20_000, cacheRead: 8_000, cacheWrite: 2_000, output: 1_250, cost: 0.042, unpriced: false },
		running: config.state === "running", compactions: 2, cwd: "/synthetic/project", sessionName: "TUI visual audit",
		chip: { icon: "", mode: "workspace", counters: "", key: "shift+tab" },
	};
	const statuses = new Map<string, StatusEntry>([["storage", storage], [STATUS.timers, { text: "Timer spend $0.01", tone: "muted" }]]);
	if (config.state === "running") {
		statuses.set(STATUS.running, { text: "2 agents · 1 bash · 1 timer", tone: "accent" });
		statuses.set(STATUS.hooks, { text: "hook 3s", tone: "muted" });
	}
	if (config.state === "warning" || config.state === "error") statuses.set(STATUS.wakeRetry, { text: "Retry in 4s · network unavailable", tone: "warning" });
	if (config.state === "queue") statuses.set(STATUS.queued, { text: "2 queued", tone: "accent" });
	return { render: (width) => footerLines(state, "main", statuses, theme, width), invalidate() {} };
}

export function buildQaScene(config: QaConfig, ui: TUI): { components: Component[]; layoutRoot: Component; dispose(): void } {
	animationClock.setReducedMotion(true);
	const light = config.theme === "light";
	setTerminalColors({ foreground: light ? { r: 0, g: 0, b: 0 } : { r: 229, g: 229, b: 231 }, background: light ? { r: 255, g: 255, b: 255 } : { r: 16, g: 16, b: 20 } });
	setThemeInstance(loadTheme(config.theme, "truecolor"));
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const disposables: Array<{ dispose(): void }> = [];
	const document = new Container();
	document.addChild(new Text(theme.fg("muted", "SYNTHETIC HEADLESS QA"), 0, 0));
	document.addChild(new Text(qaId(config), 0, 0));
	const pendingMessages = new Container();
	const status = new Container();
	const editor = new Container();
	const footer = syntheticFooter(config);
	if (config.state === "session-picker") {
		const sessions: SessionInfo[] = ["TUI visual audit", "Rendering regression", "Session recovery"].map((name, index) => ({
			id: `synthetic-${index}`, path: `/synthetic/session-${index}.jsonl`, cwd: "/synthetic/project", name,
			created: new Date("2026-01-01T12:00:00Z"), modified: new Date("2026-01-01T12:00:00Z"),
			messageCount: 12 + index, firstMessage: `Inspect ${name.toLowerCase()} and preserve useful details`, allMessagesText: name,
		}));
		const picker = new SessionSelectorComponent(async () => sessions, async () => sessions, () => {}, () => {}, () => {}, () => ui.requestRender(), { keybindings: keys, initialSort: "recent", viewportRows: () => ui.terminal.rows });
		editor.addChild(picker);
		disposables.push(picker);
	} else {
		if (config.state === "tool-queries" || config.state === "tool-results") {
			const tool = qaTool(ui, config.state);
			document.addChild(tool);
			disposables.push(tool);
		} else if (config.state === "transcript-tools" || config.state === "transcript-messages") {
			document.addChild(qaTranscript(ui, config.state));
		} else {
		document.addChild(new UserMessageComponent("Review rendering, session status, and queued work."));
		const assistant = new AssistantMessageComponent();
		assistant.updateMessage({ id: "qa-answer", role: "assistant", text: "Useful data stays visible. **State labels** accompany color.\n\n- Sessions remain selectable\n- Commands show keyboard actions", complete: true });
		document.addChild(assistant);
		disposables.push(assistant);
		}
		if (config.state === "queue") {
			const queue = new QueueListComponent(() => {}, () => {});
			queue.setRows([{ mode: "steer", text: "Prioritize the failing session save", notes: ["1 attachment"] }, { mode: "followUp", text: "Then inspect the footer at narrow widths", notes: [] }]);
			queue.focused = true;
			editor.addChild(queue);
		} else {
			const input = new CustomEditor(ui, getEditorTheme(), keys);
			input.setText("/help");
			editor.addChild(input);
		}
		if (config.state === "running") {
			const working = new WorkingStatusIndicator(ui, "Working · checking rendering", { frames: ["●"] });
			status.addChild(working);
			disposables.push(working);
		} else if (config.state === "warning" || config.state === "error") {
			status.addChild(new Text(theme.fg(config.state, config.state === "error" ? "Error: database unavailable. Changes remain in memory." : "Warning: session save delayed. Retry is pending."), 1, 0));
		} else status.addChild(new Text(theme.fg("muted", "Ready · enter send · / commands"), 1, 0));
	}
	const components: Component[] = [document, pendingMessages, status, editor, footer];
	const viewport = createChatViewport({ document, pendingMessages, status, editor, footer, scrollbar: "hidden" });
	return { components, layoutRoot: viewport.root, dispose: () => { for (const component of disposables) component.dispose(); } };
}
