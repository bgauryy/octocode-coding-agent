import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DialogOptions } from "../../src/core/features/types.ts";
import { DialogSelectorComponent } from "../../src/modes/interactive/components/dialog-selector.ts";
import { askInTerminal } from "../../src/modes/interactive/interactive-mode/ask-dialog.ts";
import type { SelectorCard } from "../../src/modes/interactive/interactive-mode/host.ts";
import { renderAskCard } from "../../src/octocode/ask/card.ts";
import { questionView } from "../../src/octocode/ask/dialog/view.ts";
import { fromAskUser } from "../../src/octocode/ask/question.ts";
import { registerAskUser } from "../../src/octocode/native/tools/ask-user/tool.ts";
import type { AskView } from "../../src/octocode/shared/ask-view.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import type { PermissionRequest } from "../../src/octocode/permission/request.ts";
import {
	ALLOW_ONCE,
	DENY,
	DENY_NOTE,
	NOTE_TITLE,
	selectAnswer,
	sessionOption,
} from "../../src/octocode/permission/ask/text.ts";
import { admitExternalMessage } from "../../src/octocode/permission/external-message.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

beforeAll(() => initTheme("dark", false));

const plain = (lines: string[]): string[] => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
const BODY = Array.from({ length: 12 }, (_, i) => `line ${i + 1} of the sender's message`).join("\n");
const SENDER = "octocode-agent-main-6c9a8aad";
const claim = (text = BODY) => ({
	from: SENDER,
	process: { id: "oc-6c9a8a#2779", name: SENDER },
	details: ["pid 2779", "in /Users/bgaryy/code/octocodecode"],
	text,
});

interface Asked {
	title: string;
	options: string[];
	opts: DialogOptions | undefined;
	/** What the footer reports while the selector is open. */
	blocked?: { kind: string; message: string } | undefined;
	/** The card the terminal draws over the selector. */
	card?: SelectorCard | undefined;
}

/** The terminal's `ui.ask` over a host whose selector reports each dialog to `record`: approvals arrive as cards. */
function terminal(
	record: (asked: Asked) => string | undefined | Promise<string | undefined>,
	input: () => Promise<string | undefined> = async () => undefined,
) {
	return askInTerminal({
		showSelectorDialog: async (title, options, opts, blocked, card) => record({ title, options, opts, blocked, card }),
		showInputDialog: input,
		showConfirmDialog: async () => false,
	});
}

/** A workspace-mode session whose select answers with `answer` (given what was asked) and records every ask. */
function session(answer: (asked: Asked) => string | undefined | Promise<string | undefined>) {
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { OCTOCODE_PERMISSION: "workspace" }, isSubagent: false });
	const ctx = fakeCtx({ cwd: tmp("octocode-ask-card-"), hasUI: true });
	const asked: Asked[] = [];
	const input = vi.fn(async () => undefined as string | undefined);
	Reflect.set(
		ctx.ui,
		"ask",
		terminal((entry) => {
			asked.push(entry);
			return answer(entry);
		}, input),
	);
	permission.start(ctx);
	const admit = (text?: string) =>
		admitExternalMessage(permission, ctx, claim(text), { self: "octocode-b", planning: false });
	return { asked, admit, input };
}

/** Draws `asked` as the terminal does and drives `keys`; resolves with what the user chose. */
function drive(asked: Asked, keys: string[], width = 80): { chosen: string | undefined; frames: string[][] } {
	let chosen: string | undefined;
	const selector = new DialogSelectorComponent(
		asked.title,
		asked.options,
		(option) => (chosen = option),
		() => (chosen = undefined),
		asked.card ? { ask: asked.card.view, ...(asked.card.onWriteIn ? { onWriteIn: asked.card.onWriteIn } : {}) } : {},
	);
	const frames = [plain(selector.render(width))];
	for (const key of keys) {
		selector.handleInput(key);
		frames.push(plain(selector.render(width)));
	}
	return { chosen, frames };
}

describe("external-message ask card", () => {
	it("keeps the wire title and options, and gives the card the same labels", async () => {
		const { asked, admit } = session(() => ALLOW_ONCE);
		await admit();
		const [ask] = asked;
		expect(ask.title.split("\n").slice(0, 5)).toEqual([
			"Let this external message reach the agent?",
			`  from ${SENDER} (external, not you)`,
			"  pid 2779",
			"  in /Users/bgaryy/code/octocodecode",
			`  ${BODY.replaceAll("\n", "⏎")}`,
		]);
		expect(ask.blocked?.kind).toBe("permission");
		expect(ask.card?.view.options.map((option) => option.label)).toEqual(ask.options);
		expect(ask.options).toContain(sessionOption(`messages from ${SENDER}`));
	});

	it("renders at 80 columns: bold question, dim sender, 3 quoted lines collapsed, all lines on tab, no ⏎", async () => {
		const { asked, admit } = session(() => ALLOW_ONCE);
		await admit();
		const view = asked[0].card?.view as AskView;
		const raw = renderAskCard(view, { cursor: 0, expanded: false }, theme, 80);
		expect(raw[0]).toContain(theme.fg("accent", theme.bold("Let this external message reach the agent?")));
		expect(plain(raw).join("\n")).toContain("(external, not you) · pid 2779 · in /Users/b");
		const { frames } = drive(asked[0], ["\t"]);
		const [collapsed, expanded] = frames.map((frame) => frame.join("\n"));
		expect(collapsed).toContain("│ line 2 of the sender's message");
		expect(collapsed).not.toContain("line 3 of");
		expect(collapsed).toContain("… +10 lines · tab");
		expect(collapsed).toContain("› 1. Allow once — only this one; the next one asks again");
		// Descriptions show under the highlighted option only; tab shows them all.
		expect(collapsed).not.toContain("the agent is told you refused");
		expect(expanded).toContain("the agent is told you refused");
		expect(collapsed).toContain("Deny and tell the agent why… ✎");
		expect(collapsed).toContain("tab details");
		expect(collapsed).not.toContain("⏎");
		expect(expanded).toContain("│ line 12 of the sender's message");
		expect(expanded).not.toContain("+10 lines");
		expect(expanded).toMatch(/▸ effect: /);
		for (const frame of frames) for (const line of frame) expect(line.length).toBeLessThanOrEqual(80);
	});

	it("allows from the collapsed card without expanding it", async () => {
		const { asked, admit } = session((entry) => drive(entry, ["\r"]).chosen);
		await expect(admit()).resolves.toBeUndefined();
		expect(asked).toHaveLength(1);
	});

	it("maps each choice to the same verdict and grant as before", async () => {
		const cases: Array<[string, "allowed" | "denied", number]> = [
			[ALLOW_ONCE, "allowed", 2],
			[sessionOption(`messages from ${SENDER}`), "allowed", 1],
			[sessionOption("all external messages"), "allowed", 1],
			[DENY, "denied", 2],
		];
		for (const [choice, outcome, asks] of cases) {
			// The first ask takes `choice`; a second one, if any, allows.
			const { asked, admit } = session((entry) =>
				asked.length === 1 && entry.options.includes(choice) ? choice : ALLOW_ONCE,
			);
			const first = admit().then(
				() => "allowed",
				(error: Error) => {
					expect(error.message).toContain("The user of octocode-b denied this message.");
					return "denied";
				},
			);
			expect(await first).toBe(outcome);
			// A grant answers the next message unasked; once and deny ask again.
			await admit();
			expect([choice, asked.length]).toEqual([choice, asks]);
		}
	});

	// The write-in is the 6th row: a process's message also offers "Deny messages from <process> for this session" after Deny.
	it("sends the inline write-in's note to the sender without a second dialog", async () => {
		const { admit, input } = session((entry) => drive(entry, ["6", "\r", ..."use staging".split(""), "\r"]).chosen);
		await expect(admit()).rejects.toThrow("denied this message, saying: use staging.");
		expect(input).not.toHaveBeenCalled();
	});

	it("returns to the options when Esc closes the write-in", async () => {
		const { asked, admit } = session(() => ALLOW_ONCE);
		await admit();
		const { chosen, frames } = drive(asked[0], ["6", "\r", "x", "\x1b", "4", "\r"]);
		expect(frames[3].join("\n")).toContain("Tell the agent why: x");
		expect(frames[4].join("\n")).not.toContain("Tell the agent why:");
		expect(chosen).toBe(DENY);
	});

	it("still asks for the note in a second dialog where no card is drawn", async () => {
		const { admit, input } = session(() => DENY_NOTE);
		input.mockResolvedValueOnce("later please");
		await expect(admit()).rejects.toThrow("saying: later please");
		expect(input).toHaveBeenCalledWith(NOTE_TITLE, "what to do instead", expect.anything());
	});
});

describe("askUser card", () => {
	const forwarded = {
		question: "jolly asks (message #7):\nA\nB\nC\nD\nE\n\nWhich scope?",
		forwarded: { label: "jolly asks (message #7):", text: "A\nB\nC\nD\nE", ask: "Which scope?" },
		options: [
			{ label: "Small (Recommended)", description: "One file" },
			{ label: "Large", description: "Whole repo" },
		],
	};

	it("renders the child's name and verbatim question above the parent question without collapsing it", () => {
		const view = questionView(fromAskUser([forwarded])[0]);
		const collapsed = plain(renderAskCard(view, { cursor: 0, expanded: false }, theme, 80));
		expect(collapsed).toEqual([
			" jolly asks (message #7):",
			" A",
			" B",
			" C",
			" D",
			" E",
			"",
			" Which scope?",
			"",
			"› 1. Small (Recommended) ★",
			"     One file",
			"  2. Large",
			"     Whole repo",
			"  3. Write an answer ✎",
		]);
		const expanded = plain(renderAskCard(view, { cursor: 2, expanded: true }, theme, 80));
		expect(expanded.slice(0, 8)).toEqual(collapsed.slice(0, 8));
		expect(expanded).toContain("› 3. Write an answer ✎");
	});

	it('drops identical and "Other" options and caps the count, saying so', async () => {
		const fake = fakeHost();
		registerAskUser(fake.api);
		const tool = fake.tools.get("askUser");
		const seen: string[][] = [];
		const ctx = fakeCtx({ cwd: ".", mode: "rpc", ui: { selects: ["1. A"] } });
		const select = ctx.ui.select.bind(ctx.ui);
		Reflect.set(ctx.ui, "select", (title: string, options: string[], opts?: DialogOptions) => {
			seen.push(options);
			return select(title, options, opts);
		});
		const labels = ["A", "A", "Other", "B", "C", "D", "E", "F", "G"];
		const result = await tool!.execute(
			"c",
			{ questions: [{ question: "Which?", options: labels.map((label) => ({ label, description: `why ${label}` })) }] },
			undefined,
			undefined,
			ctx,
		);
		expect(seen[0]).toEqual(["1. A — why A", "2. B — why B", "3. C — why C", "4. D — why D", "Write an answer"]);
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining(
				'(Not asked: 1 duplicate option and 1 "Other" option (the UI adds a write-in) and 3 options past the first 4.)',
			),
		});
	});
});

describe("compact permission card", () => {
	const CWD = "/Users/bgaryy/code/octocodecode";
	const FILES = Array.from(
		{ length: 9 },
		(_, i) => `${CWD}/packages/coding-agent/src/octocode/area${i}/module-${i}.ts`,
	);
	const requests: Record<string, PermissionRequest> = {
		"bash mv": {
			action: "shell",
			reasons: ["provenance"],
			title: "Run this shell command?",
			what: [
				`cd ${CWD}/packages/coding-agent/src/octocode && mv -n ask/view.ts shared/ask-view.ts && ls -la shared ask`,
			],
			effect: "runs a command as you",
			undo: "none",
			risk: "can change files",
			reason: "contains text from agent misty-prawn (3m ago)",
			purpose: "Move the ask model to the shared leaf so the permission card and askUser import one owner",
		},
		"file edit": {
			action: "file.workspace",
			reasons: ["provenance"],
			reason: "contains text from agent misty-prawn (3m ago)",
			title: "Edit these files?",
			what: FILES,
			effect: "changes files in the repository",
			undo: "git restore",
			purpose: "Point every importer at the shared ask view",
			grant: { key: `${CWD}/packages`, label: `file changes under ${CWD}/packages` },
		},
		"agent spawn": {
			action: "agent.spawn",
			reasons: ["provenance"],
			title: "Start this subagent?",
			what: ["implementer calm-nautilus: B128 compact permission card, edit four files, run the focused tests"],
			effect: "starts a subagent",
			undo: "stop it",
			reason: "contains text from agent misty-prawn (3m ago)",
			purpose: "Delegate the card change",
		},
		"external message": {
			action: "message.external",
			title: "Let this external message reach the agent?",
			what: [`from ${SENDER} (external, not you)`, "pid 2779", `in ${CWD}`, BODY],
			view: { meta: [`from ${SENDER} (external, not you)`, "pid 2779", `in ${CWD}`], body: BODY },
			effect: "starts or steers a turn",
			undo: "none once read",
			purpose: "",
			grant: { key: SENDER, label: `messages from ${SENDER}` },
		},
	};

	/** Asks `request` in workspace mode as selectAnswer does and returns what the select received. */
	async function asked(request: PermissionRequest): Promise<Asked> {
		let seen: Asked | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				ask: terminal((entry) => {
					seen = entry;
					return DENY;
				}),
			},
		} as unknown as Parameters<typeof selectAnswer>[0];
		await selectAnswer(ctx, request, "workspace", false, "");
		return seen as Asked;
	}

	it("keeps the wire title and choices byte-identical for the bash mv request", async () => {
		const ask = await asked(requests["bash mv"]);
		expect(ask.title).toBe(
			[
				"Run this shell command?",
				`  ${requests["bash mv"].what[0]}`,
				"▸ effect: runs a command as you",
				"▸ undo: none",
				"▸ why it asks: contains text from agent misty-prawn (3m ago)",
				"▸ risk: can change files",
				`  agent says (unverified): ${requests["bash mv"].purpose}`,
			]
				.join("\n")
				.replace(/^▸/gm, "  ▸"),
		);
		expect(ask.options).toEqual([ALLOW_ONCE, DENY, DENY_NOTE]);
	});

	for (const [name, request] of Object.entries(requests))
		for (const width of [100, 200])
			it(`${name}: collapsed card is at most 10 rows at ${width} columns and tab shows everything`, async () => {
				const ask = await asked(request);
				const view = ask.card?.view as AskView;
				// The card only changes how the terminal draws: the title carries every target and the agent's reason.
				for (const target of request.what) expect(ask.title).toContain(target.replace(/\r\n|\r|\n/g, "⏎"));
				const collapsed = plain(renderAskCard(view, { cursor: 0, expanded: false }, theme, width));
				const expanded = plain(renderAskCard(view, { cursor: 0, expanded: true }, theme, width));
				expect(collapsed.length).toBeLessThanOrEqual(10);
				expect(collapsed.length).toBeLessThan(expanded.length);
				for (const line of [...collapsed, ...expanded]) expect(line.length).toBeLessThanOrEqual(width);
				const text = collapsed.join("\n");
				if (request.purpose) expect(text).toContain(`agent says (unverified): ${request.purpose.slice(0, 40)}`);
				expect(text).toContain("asks: ");
				expect(text).toContain("tab details");
				expect(expanded.join("\n")).toMatch(/▸ effect: /);
				expect(expanded.join("\n")).toMatch(/▸ undo: /);
				for (const option of ask.options) expect(text).toContain(option.replace(" ✎", ""));
			});

	it("shows two target rows and counts the rest for a file edit", async () => {
		const view = (await asked(requests["file edit"])).card?.view as AskView;
		const collapsed = plain(renderAskCard(view, { cursor: 0, expanded: false }, theme, 100)).join("\n");
		expect(collapsed).toContain("area0/module-0.ts");
		expect(collapsed).toContain("area1/");
		expect(collapsed).not.toContain("area2/");
		expect(collapsed).toContain("… +7 lines · tab");
		expect(plain(renderAskCard(view, { cursor: 0, expanded: true }, theme, 100)).join("\n")).toContain("module-8.ts");
	});

	it("gives a provenance ask the reason first and offers any option list", async () => {
		const request = { ...requests["agent spawn"], reason: "contains text from agent misty-prawn (3m ago)" };
		const view = (await asked(request)).card?.view as AskView;
		const row = plain(renderAskCard(view, { cursor: 0, expanded: false }, theme, 100)).find((line) =>
			line.includes("asks:"),
		);
		expect(row).toContain("asks: contains text from agent misty-prawn (3m ago)");
	});
});

describe("compact permission card frame", () => {
	it("draws the bash mv card within 16 rows at 100 columns, selector rows included", async () => {
		const request: PermissionRequest = {
			action: "shell",
			reasons: ["provenance"],
			title: "Run this shell command?",
			what: [
				"cd /Users/bgaryy/code/octocodecode/packages/coding-agent/src/octocode && mv -n ask/view.ts shared/ask-view.ts",
			],
			effect: "runs a command as you",
			undo: "none",
			reason: "contains text from agent misty-prawn (3m ago)",
			purpose: "Move the ask model to the shared leaf",
		};
		let seen: Asked | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				ask: terminal((entry) => {
					seen = entry;
					return DENY;
				}),
			},
		} as unknown as Parameters<typeof selectAnswer>[0];
		await selectAnswer(ctx, request, "workspace", false, "");
		const { frames } = drive(seen as Asked, [], 100);
		// Borders, the selector's spacer rows and the hint are the selector's: 6 rows around the card.
		expect(frames[0].length).toBeLessThanOrEqual(16);
		expect(frames[0].filter((line) => line.trim() !== "").length).toBeLessThanOrEqual(12);
		console.log(frames[0].join("\n"));
	});
});
