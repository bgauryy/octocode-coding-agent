import { renderPrompt } from "../../core/prompt-template.ts";
import path from "node:path";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { cancelledText, notify, type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { sessionFolder } from "../shared/home.ts";
import { confirmAction } from "../shared/page.ts";
import { withDialog } from "../shared/locks.ts";
import { plural } from "../shared/text.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Checkpoints, RewindResult } from "./checkpoint.ts";
import { inheritCheckpoints, sessionIdOf } from "./checkpoint-store.ts";

/** The named answers of the rewind prompts: the safe one first, never Yes/No. */
const REWIND = "Rewind";
const KEEP_FILES = "Keep current files";
const RESTORE_FILES = "Restore files";

/*
 * Checkpoints wired to the session (the store is checkpoint.ts): turns, `/rewind`, anchor labels, and the
 * restore offer before a fork or a tree move.
 */

/** The label Octocode puts on turns that changed files ("✎ 3 files"); any other label is the user's and is left alone. */
const CHANGED_LABEL_MARK = "✎";
const CHANGED_LABEL = /^✎ \d+ files?$/;

/** A session's checkpoint folder: `<session folder>/checkpoints` (not created). */
const checkpointDir = (id: string): string => sessionFolder("checkpoints", id);

/** The parent session file of a fork: the fork event's, else the session header's (`octocode --fork <file>` starts as 'startup'). */
function parentSessionFile(
	event: { reason?: string; previousSessionFile?: string } | undefined,
	ctx: FeatureContext,
): string | undefined {
	if (event?.reason === "fork" && event.previousSessionFile) return event.previousSessionFile;
	return ctx.sessionManager.getHeader?.()?.parentSession || undefined;
}

function describe(result: RewindResult, cwd: string, turns: number): string {
	const show = (files: string[]) => files.map((file) => path.relative(cwd, file) || file).join(", ");
	const lines = [
		`Rewound ${turns} turn${turns === 1 ? "" : "s"}: restored ${result.restored.length} file${result.restored.length === 1 ? "" : "s"}${result.restored.length ? ` (${show(result.restored)})` : ""}.`,
	];
	if (result.partly.length)
		lines.push(
			`Partly restored, an older change could not be undone (its checkpoint is kept, rewind again to retry): ${show(result.partly)}.`,
		);
	if (result.skipped.length) lines.push(`Left alone, changed since the agent's edit: ${show(result.skipped)}.`);
	for (const copy of result.recovery ?? [])
		lines.push(
			`A concurrent change to ${show([copy.path])} was preserved at ${copy.savedAt}; inspect both files before retrying.`,
		);
	return lines.join("\n");
}

/** The entry a tree navigation to `targetId` lands on: Octocode puts a user or custom message back in the editor and stops at its parent. */
function treeLeaf(ctx: FeatureContext, targetId: string): string | null {
	const target = ctx.sessionManager.getEntry(targetId);
	if (!target) return targetId;
	const editable = (target.type === "message" && target.message.role === "user") || target.type === "custom_message";
	return editable ? target.parentId : targetId;
}

/**
 * Wire checkpoints to the session: one directory per session, a turn per user prompt, `/rewind`, and a restore
 * offer before a fork or a tree navigation leaves turns that changed files.
 */
export function registerCheckpoints(
	api: FeatureSetup,
	checkpoints: Checkpoints,
	forget: (file: string) => void,
	commands: Subcommands,
): void {
	// A rewind turn is one user prompt (typed or over RPC), not every run (team messages and job reports are not turns).
	// The first run opens one even without a prompt event; a prompt typed mid-run (a steer or follow-up) opens its turn at
	// the next run, so edits in flight settle in the turn they were captured in.
	let [begun, pending] = [false, false];
	let currentContext: FeatureContext | undefined;
	const begin = () => {
		checkpoints.beginTurn();
		begun = true;
		pending = false;
		return undefined;
	};
	api.bus.on("session_start", async (event, ctx) => {
		currentContext = ctx;
		[begun, pending] = [false, false];
		const id = ctx.sessionManager.getSessionId();
		const dir = checkpointDir(id);
		// A fork starts with the parent's checkpoints on its branch (in-memory parents have no file and pass nothing on);
		// inheritCheckpoints does nothing once the fork has a journal, so a later resume inherits nothing again.
		const parentFile = parentSessionFile(event, ctx);
		const parent = parentFile ? await sessionIdOf(parentFile) : undefined;
		if (parent && parent !== id) {
			const branch = ctx.sessionManager.getBranch().map((entry) => entry.id);
			await inheritCheckpoints(checkpointDir(parent), dir, branch).catch((error: unknown) => {
				if (ctx.hasUI)
					notify(
						ctx.ui,
						`Octocode could not carry the checkpoints to this fork (${errorMessage(error)}); /rewind will not reach the parent's turns.`,
						"warning",
					);
			});
		}
		checkpoints.open(dir);
	});
	const branchIds = (ctx: FeatureContext, from?: string) => ctx.sessionManager.getBranch(from).map((entry) => entry.id);
	api.bus.on("input", async (event) => {
		if (event.source !== "feature") {
			if (event.streamingBehavior === undefined) begin();
			else pending = true;
		}
		return undefined;
	});
	api.bus.on("agent_start", async () => {
		if (!begun || pending) begin();
		return undefined;
	});

	// /tree and /fork show which turns changed files: each anchor (the turn's user message) is labelled "✎ N files".
	const relabel = (ctx: FeatureContext, anchors: Iterable<string>) => {
		const files = checkpoints.filesByAnchor();
		for (const anchor of new Set(anchors)) {
			if (!ctx.sessionManager.getEntry(anchor)) continue;
			const count = files.get(anchor)?.size ?? 0;
			const want = count ? `${CHANGED_LABEL_MARK} ${plural(count, "file")}` : undefined;
			const have = ctx.sessionManager.getLabel(anchor);
			if (have === want || (have !== undefined && !CHANGED_LABEL.test(have))) continue;
			api.session.setLabel(anchor, want);
		}
	};
	// Anchors whose checkpoints were pruned since keep an Octocode label that no longer holds: relabel those too.
	const labelled = (ctx: FeatureContext) =>
		branchIds(ctx).filter((id) => CHANGED_LABEL.test(ctx.sessionManager.getLabel(id) ?? ""));
	api.bus.on("agent_end", async (_event, ctx) =>
		relabel(ctx, [...checkpoints.filesByAnchor().keys(), ...labelled(ctx)]),
	);

	const apply = async (turns: number[], ctx: FeatureContext): Promise<RewindResult> => {
		const anchors = checkpoints
			.list()
			.filter((entry) => turns.includes(entry.turn) && entry.anchor !== undefined)
			.map((entry) => entry.anchor!);
		const result = await checkpoints.rewind(turns);
		relabel(ctx, anchors);
		for (const file of [...result.restored, ...result.partly]) forget(file);
		say(
			ctx,
			describe(result, ctx.cwd, turns.length),
			result.skipped.length || result.partly.length ? "warning" : "info",
		);
		return result;
	};

	commands.add("rewind", {
		description: "Undo file changes of recent turns",
		argumentHint: "[turns]",
		complete: (prefix) => {
			const count = currentContext ? checkpoints.turnsOn(branchIds(currentContext)).length : 0;
			return wordCompletions(
				Array.from({ length: count }, (_, index) => [String(index + 1), `Undo ${index + 1} turn${index ? "s" : ""}`]),
				prefix,
			);
		},
		handler: async (args, ctx) => {
			const value = args.trim();
			const count = value === "" ? 1 : Number(value);
			if ((value !== "" && !/^\d+$/.test(value)) || !Number.isSafeInteger(count) || count < 1)
				return say(ctx, "Usage: /rewind [turns] (positive integer)", "warning");
			// Only this branch's turns: after a /tree move, turns on the branch left behind are not this conversation's.
			const turns = checkpoints.turnsOn(branchIds(ctx)).slice(0, count);
			if (turns.length === 0) {
				say(ctx, "No file changes to rewind on this branch.");
				return;
			}
			// Restoring overwrites workspace files and cannot itself be undone: with nobody to ask, the count must be typed.
			if (!ctx.hasUI && value === "")
				return say(
					ctx,
					"/rewind asks for confirmation; without an interactive session, name the turns: /rewind <turns>.",
					"warning",
				);
			// Ask first when someone can answer.
			if (
				ctx.hasUI &&
				!(await confirmAction(
					(title, options) => ctx.ui.select(title, options),
					`Rewind file changes?\nRestore the files the last ${turns.length === 1 ? "turn" : `${turns.length} turns`} on this branch changed to their earlier content. Files changed since are left alone. This cannot be undone.`,
					[REWIND],
				))
			)
				return say(ctx, cancelledText("rewound"));
			const result = await apply(turns, ctx);
			// The model still believes its edits are in place: tell it on its next turn (never triggers one itself).
			if (result.restored.length + result.partly.length > 0) {
				await api.session.sendMessage(
					{
						customType: "octocode-rewind",
						content: renderPrompt("notices/rewind.md", { what: describe(result, ctx.cwd, turns.length) }),
						display: false,
					},
					{ triggerTurn: false },
				);
			}
		},
	});

	// The restore is asked before a fork or tree move but done only once the move happened: the move can still be
	// cancelled (Esc during the branch summary, a fork Octocode refuses), and the files must then stay as they are.
	let chosen: number[] | undefined;
	const offer = async (turns: number[], ctx: FeatureContext, signal?: AbortSignal): Promise<void> => {
		chosen = undefined;
		if (turns.length === 0) return;
		const files = new Set(
			checkpoints
				.list()
				.filter((entry) => turns.includes(entry.turn))
				.map((entry) => entry.path),
		).size;
		const title = `The agent changed ${files} file${files === 1 ? "" : "s"} after this point. Restore them?`;
		const choice = await withDialog(
			() => ctx.ui.select(title, [KEEP_FILES, RESTORE_FILES], signal ? { signal } : undefined),
			signal,
		);
		if (choice === RESTORE_FILES) chosen = turns;
	};
	const restoreChosen = async (ctx: FeatureContext) => {
		const turns = chosen;
		chosen = undefined;
		if (turns) await apply(turns, ctx);
	};

	api.bus.on("session_before_fork", async (event, ctx) => {
		if (ctx.hasUI) await offer(checkpoints.turnsFrom(branchIds(ctx), event.entryId), ctx);
		return undefined;
	});
	// Octocode tears the parent session down only once the fork is certain; its checkpoints are still open here.
	api.bus.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "fork") await restoreChosen(ctx);
		else chosen = undefined;
	});

	// /tree moves the leaf in place: turns on the current branch that the new position does not include are abandoned.
	api.bus.on("session_before_tree", async (event, ctx) => {
		if (!ctx.hasUI) return undefined;
		const leaf = treeLeaf(ctx, event.preparation.targetId);
		const keep = new Set(leaf === null ? [] : branchIds(ctx, leaf));
		await offer(checkpoints.turnsLeaving(branchIds(ctx), keep), ctx, event.signal);
		return undefined;
	});
	api.bus.on("session_tree", async (_event, ctx) => restoreChosen(ctx));
}
