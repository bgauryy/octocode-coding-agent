import fs from "node:fs";
import os from "node:os";
import { stripRowMarks } from "@octocodeai/octocode-tui";
import { resolveConfiguredCache } from "../../src/core/cache-configuration.ts";
import type { FeatureSetup, CommandContext, FeatureContext } from "../../src/core/features/index.ts";
import type { ModelRegistry } from "../../src/core/model-registry.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";

type EditorFactory = ReturnType<FeatureContext["ui"]["getEditorComponent"]>;

export const fakeCachePolicy: ModelRegistry["getCachePolicy"] = (model, settings, options) =>
	resolveConfiguredCache(model, undefined, options, settings);

/** The billing facts a registry gives subagent routing: every provider metered, unattended use allowed. */
export const meteredBilling = {
	getProviderBilling: (): "plan" | "metered" => "metered",
	allowsUnattendedUse: (): boolean => true,
	getModelOrigin: (): "built-in" => "built-in",
};

/** Identity theme: colours and styles pass text through, so rendered components read as plain text. */
export const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
} as never;

/** The text a rendered component shows at `width`, lines trimmed at the end. */
/** The rows as the terminal draws them: zero-width row marks for transcript search dropped, trailing blanks trimmed. */
export function rendered(component: { render(width: number): string[] }, width = 200): string {
	return component
		.render(width)
		.map((line) => stripRowMarks(line).trimEnd())
		.join("\n");
}

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Where each flat host member lives on the grouped setup, for fakes written as one flat object. */
const SETUP_MEMBERS = {
	on: "bus.on",
	registerTool: "tools.register",
	registerTools: "tools.registerAll",
	registerCommand: "commands.register",
	registerMessageRenderer: "renderers.message",
	registerEntryRenderer: "renderers.entry",
	registerToolRenderer: "renderers.tool",
	sendMessage: "session.sendMessage",
	sendUserMessage: "session.sendUserMessage",
	appendEntry: "session.appendEntry",
	setSessionName: "session.setName",
	getSessionName: "session.getName",
	setLabel: "session.setLabel",
	createUsageRecorder: "usage.createRecorder",
	recordUsage: "usage.record",
	getActiveTools: "tools.getActive",
	getHiddenDeclarations: "tools.getHiddenDeclarations",
	getAllTools: "tools.getAll",
	setActiveTools: "tools.setActive",
	selectsTools: "tools.selects",
	setToolPolicy: "tools.setPolicy",
	getSettings: "settings.get",
	getCommands: "resources.getCommands",
	getSkillDirectories: "resources.getSkillDirectories",
	getSkillResourceSnapshot: "resources.getSkillResourceSnapshot",
	setModel: "models.setModel",
	getThinkingLevel: "models.getThinkingLevel",
	registerProvider: "providers.register",
	registerMcpServer: "mcpServers.register",
	getMcpServers: "mcpServers.list",
	events: "channels",
} as const satisfies Record<string, string>;

/**
 * A setup over a flat fake: each slice method calls the flat member of the same old name at call time, so the
 * flat object stays the one recorder. A slice method may be replaced on the setup itself.
 */
export function groupSetup(flat: Record<string, unknown>): FeatureSetup {
	const setup: Record<string, unknown> = {};
	for (const [name, place] of Object.entries(SETUP_MEMBERS)) {
		const [slice, member] = place.split(".");
		if (!member) {
			Object.defineProperty(setup, slice, {
				get: () => flat[name],
				set: (value) => {
					flat[name] = value;
				},
				enumerable: true,
			});
			continue;
		}
		const group = (setup[slice] ??= {}) as Record<string, unknown>;
		// A member the flat fake lacks stays absent, as an optional host member is.
		if (typeof flat[name] !== "function") continue;
		group[member] = (...args: unknown[]) => (flat[name] as (...args: unknown[]) => unknown)(...args);
	}
	return setup as unknown as FeatureSetup;
}

/**
 * Add the setup slices to a flat fake in place: each slice method calls the flat member of the old name at call time,
 * so the test keeps asserting on and replacing the flat members. Slices the fake already has gain only missing members.
 */
export function asSetup<T extends object>(flat: T): T & FeatureSetup {
	const record = flat as Record<string, unknown>;
	for (const [name, place] of Object.entries(SETUP_MEMBERS)) {
		const [slice, member] = place.split(".");
		if (!member) {
			if (!(slice in record) && name in record) {
				Object.defineProperty(record, slice, {
					get: () => record[name],
					set: (value) => {
						record[name] = value;
					},
				});
			}
			continue;
		}
		if (typeof record[name] !== "function") continue;
		const group = (record[slice] ??= {}) as Record<string, unknown>;
		group[member] ??= (...args: unknown[]) => (record[name] as (...args: unknown[]) => unknown)(...args);
	}
	return flat as T & FeatureSetup;
}

/** Records every registration an Octocode extension makes and lets a test fire its events. */
export function fakeHost(settings: Record<string, unknown> = {}) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	const renderers = new Map<string, any>();
	const sent: Array<{ message: any; options: any }> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	let activeTools: string[] | undefined;
	const registerToolBatches: string[][] = [];
	const api = {
		getSettings: (): Record<string, unknown> => settings,
		getThinkingLevel: () => "off",
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
		registerToolBatches,
		registerTools(batch: Array<{ name: string }>) {
			registerToolBatches.push(batch.map((tool) => tool.name));
			for (const tool of batch) tools.set(tool.name, tool);
		},
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerMessageRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
		registerEntryRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
		// The tool display resolver (octocode/ui/tool-display.ts) registers here; the fake draws nothing.
		registerToolRenderer: () => {},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
		sendUserMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		// As the real host: registration activates only direct and model-only tools, and not those with `defaultActive: false`.
		getHiddenDeclarations: () => [],
		getActiveTools: () =>
			activeTools ??
			[...tools.values()]
				.filter(
					(tool) =>
						tool.defaultActive !== false &&
						(tool.exposure === undefined || ["direct", "model-only"].includes(tool.exposure)),
				)
				.map((tool) => tool.name),
		getAllTools: () => [...tools.values()],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		getCommands: () => [],
		getSkillDirectories: () => [],
		getSkillResourceSnapshot: (_names?: readonly string[]) => ({
			version: 1 as const,
			resources: [],
			explicitSkills: [],
		}),
		events: { on: () => () => undefined, emit: () => undefined },
		// Names only: a method renamed on the host fails here instead of quietly going unused in every test.
	} satisfies Partial<Record<keyof typeof SETUP_MEMBERS | "registerToolBatches", unknown>>;
	const emit = async (event: string, payload: unknown, ctx: unknown) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	};
	/** Runs every handler for `event` in order and returns the last one's result, as Octocode does for most events. */
	const fire = async (event: string, payload: unknown, ctx: unknown) => (await emit(event, payload, ctx)).at(-1);
	return {
		api: groupSetup(api),
		/** The flat recorder behind `api`. */
		flat: api as Record<string, unknown>,
		tools,
		commands,
		handlers,
		renderers,
		sent,
		entries,
		emit,
		fire,
	};
}

export interface FakeUi {
	notes: Array<{ message: string; type?: string }>;
	statuses: Map<string, string | undefined>;
	/** The tone each status was set with (absent: none). */
	statusTones: Map<string, string>;
	widgets: Map<string, unknown>;
	footer?: unknown;
	header?: unknown;
	editor?: EditorFactory | undefined;
	title?: string;
	selects: Array<string | undefined>;
	inputs: Array<string | undefined>;
	confirms: boolean[];
	custom?: (factory: any) => Promise<unknown>;
}

/** A ctx whose ui records notifications, statuses and widgets and answers dialogs from queued replies. */
export function fakeCtx(options: {
	cwd: string;
	hasUI?: boolean;
	mode?: string;
	idle?: boolean;
	ui?: Partial<FakeUi>;
	model?: unknown;
}): CommandContext & { ui: FakeUi & FeatureContext["ui"] } {
	const state: FakeUi = {
		notes: [],
		statuses: new Map(),
		statusTones: new Map(),
		widgets: new Map(),
		selects: [],
		inputs: [],
		confirms: [],
		...options.ui,
	};
	const ui = {
		// No terminal, as over RPC: nothing to listen to. First, so a test's own `ui.onTerminalInput` (in `state`) wins.
		onTerminalInput: () => () => undefined,
		...state,
		notify: (message: string, type?: string) => state.notes.push({ message, type }),
		setStatus: (key: string, text: string | undefined, tone?: string) => {
			state.statuses.set(key, text);
			if (tone && text !== undefined) state.statusTones.set(key, tone);
			else state.statusTones.delete(key);
		},
		setWidget: (key: string, content: unknown) =>
			content === undefined ? state.widgets.delete(key) : state.widgets.set(key, content),
		setFooter: (factory: unknown) => {
			(ui as FakeUi).footer = factory;
			return (ui as FakeUi).footer;
		},
		setHeader: (factory: unknown) => {
			(ui as FakeUi).header = factory;
			return (ui as FakeUi).header;
		},
		setEditorComponent: (factory: EditorFactory | undefined) => {
			(ui as FakeUi).editor = factory;
			return (ui as FakeUi).editor;
		},
		getEditorComponent: () => (ui as FakeUi).editor,
		setTitle: (title: string) => {
			(ui as FakeUi).title = title;
			return (ui as FakeUi).title;
		},
		setWorkingMessage: (message?: string) => {
			(ui as FakeUi & { working?: string }).working = message;
			return (ui as FakeUi & { working?: string }).working;
		},
		setWorkingIndicator: (indicator: unknown) => {
			(ui as FakeUi & { indicator?: unknown }).indicator = indicator;
			return (ui as FakeUi & { indicator?: unknown }).indicator;
		},
		select: async () => state.selects.shift(),
		input: async () => state.inputs.shift(),
		confirm: async () => state.confirms.shift() ?? false,
		custom: (factory: unknown) => (state.custom ? state.custom(factory) : Promise.resolve(undefined)),
		theme,
	};
	// Share the recording arrays with the returned ui so tests can read them.
	Object.assign(ui, {
		notes: state.notes,
		statuses: state.statuses,
		widgets: state.widgets,
		selects: state.selects,
		inputs: state.inputs,
		confirms: state.confirms,
	});
	return {
		cwd: options.cwd,
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		ui,
		isIdle: () => options.idle ?? true,
		isProjectTrusted: () => true,
		abort: () => undefined,
		failRun: () => undefined,
		hasPendingMessages: () => false,
		isMessageQueued: () => false,
		replaceQueuedMessage: () => false,
		signal: undefined,
		sessionManager: {
			getSessionId: () => "session-test",
			getEntries: () => [],
			getBranch: () => [],
			getSessionFile: () => undefined,
			getHeader: () => null,
			getCwd: () => options.cwd,
			getSessionName: () => undefined,
			buildSessionProjection: () => ({ entries: [], messages: [] }),
		},
		model: options.model,
		modelRegistry: {
			getAvailable: () => [],
			getAll: () => [],
			isModelHidden: () => false,
			find: () => undefined,
			getCachePolicy: fakeCachePolicy,
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
			billedBySubscription: () => false,
			getProviderKind: () => "API key",
			...meteredBilling,
		} satisfies Pick<
			ModelRegistry,
			| "getAvailable"
			| "getAll"
			| "isModelHidden"
			| "find"
			| "getCachePolicy"
			| "getProviderAuthStatus"
			| "billedBySubscription"
			| "getProviderKind"
			| "getProviderBilling"
			| "allowsUnattendedUse"
		>,
		getContextUsage: () => undefined,
	} as never;
}

/** A started permission state in `mode` (default workspace: in-repo work runs, anything else asks). */
export function fakePermission(
	mode: PermissionMode = "workspace",
	options: { api?: FeatureSetup; isSubagent?: boolean; stderr?: (text: string) => void; snapshotMs?: number } = {},
): Permission {
	const permission = new Permission({
		api: options.api ?? fakeHost().api,
		env: { OCTOCODE_PERMISSION: mode },
		isSubagent: options.isSubagent ?? false,
		stderr: options.stderr ?? (() => undefined),
		...(options.snapshotMs ? { snapshotMs: options.snapshotMs } : {}),
	});
	// The OS temp folder: tests/setup-env.ts saved a trust decision for it.
	permission.start({
		cwd: fs.realpathSync(os.tmpdir()),
		isProjectTrusted: () => true,
		hasUI: false,
		sessionManager: { getEntries: () => [], getSessionFile: () => undefined },
	} as never);
	return permission;
}
