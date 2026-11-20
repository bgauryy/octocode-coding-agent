import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { builtinDescription } from "../../core/slash-commands.ts";
import type { CommandContext } from "../../core/features/index.ts";
import { cancelledText, type Subcommand, say, wordCompletions } from "../shared/commands.ts";
import { worktreeNames } from "../worktrees/names.ts";
import { MAIN_CHECKOUT, switchToWorktree } from "../worktrees/switch.ts";
import { collectRealms, type RealmDependencies } from "./collect.ts";
import { findRealm, type Realm, type RealmView } from "./model.ts";
import { realmDetail, realmList, realmListParts, switchProblem, switchTarget } from "./render.ts";

const USAGE = "Usage: /realm [<name> [switch|resume]]";

export interface RealmCommandDependencies extends RealmDependencies {
	/** The session's folder, for completing names: the process directory does not follow `switch` or `/resume`. */
	cwd?: () => string | undefined;
	/** The clock, for tests. */
	now?: () => number;
}

/** `/realm <name> switch`: the worktree switch (idle only, the old session stays saved), after saying why a realm cannot be entered. */
async function switchTo(realm: Realm, ctx: CommandContext): Promise<void> {
	const problem = switchProblem(realm);
	if (problem) return say(ctx, `Cannot switch to ${realm.name}. ${problem}`, "warning");
	await switchToWorktree(switchTarget(realm), ctx);
}

/** `/realm <name> resume`: a picker of the saved sessions started in the realm, or their ids as text without a UI. */
async function resumeFrom(realm: Realm, ctx: CommandContext): Promise<void> {
	if (realm.sessions.length === 0) return say(ctx, `No saved session was started in ${realm.name}.`);
	if (!ctx.hasUI || !ctx.ui.pickSession) {
		const rows = realm.sessions.map(
			(session) => `  ${session.live ? "live" : "saved"} ${session.name ?? "(unnamed)"} · ${session.id}`,
		);
		return say(ctx, [`Sessions started in ${realm.name} (open one with /resume all <id>):`, ...rows].join("\n"));
	}
	const picked = await ctx.ui.pickSession({
		initialScope: "all",
		onlySessions: new Set(realm.sessions.map((session) => session.id)),
	});
	if (!picked) return;
	const session = realm.sessions.find((candidate) => candidate.id === picked.id);
	if (session?.current) return say(ctx, "That is the current session.");
	// Another process may have it open; two writers on one transcript need the user's say.
	if (
		session?.live &&
		!(await ctx.ui.confirm(
			"Session is running",
			"Another Octocode process has this session open. Resume it here as well?",
		))
	)
		return say(ctx, cancelledText("resumed"));
	await ctx.switchSession(picked.path);
}

/** The realm's page: its detail and the actions that apply, until the user goes back. Resolves true once an action ended the page. */
async function realmPage(realm: Realm, view: RealmView, ctx: CommandContext, now: number): Promise<boolean> {
	const switchLabel = `Switch this session to ${realm.name}`;
	const resumeLabel = `Resume a session from ${realm.name}`;
	const options = [
		...(switchProblem(realm) ? [] : [switchLabel]),
		...(realm.sessions.length > 0 ? [resumeLabel] : []),
		"Back",
	];
	const choice = await ctx.ui.select(realmDetail(realm, view, now).join("\n"), options);
	if (choice === switchLabel) await switchTo(realm, ctx);
	else if (choice === resumeLabel) await resumeFrom(realm, ctx);
	return choice === switchLabel || choice === resumeLabel || choice === undefined;
}

/** The realm list as a picker: Enter opens a realm's page, Escape closes. Running work is never touched. */
async function listPage(ctx: CommandContext, deps: RealmCommandDependencies): Promise<void> {
	for (;;) {
		const { view, sessionsProblem } = await collectRealms(ctx, deps);
		const now = (deps.now ?? Date.now)();
		const { header, rows, footer } = realmListParts(view, now, sessionsProblem);
		const picked = await ctx.ui.select([...header, ...footer].join("\n"), rows);
		const realm = picked === undefined ? undefined : view.realms[rows.indexOf(picked)];
		if (!realm) return;
		if (await realmPage(realm, view, ctx, now)) return;
	}
}

/** `/realm`: the repository's checkout, worktrees and sessions in one place, with `switch` and `resume` per realm. */
export function realmCommand(deps: RealmCommandDependencies): Subcommand {
	return {
		description: builtinDescription("realm"),
		argumentHint: "[<name> [switch|resume]]",
		complete: (prefix) => {
			const acting = /^(\S+)\s+(.*)$/su.exec(prefix);
			if (acting)
				return (
					wordCompletions(["switch", "resume"], acting[2])?.map((item) => ({
						...item,
						value: `${acting[1]} ${item.value}`,
					})) ?? null
				);
			const cwd = deps.cwd?.();
			return wordCompletions([MAIN_CHECKOUT, ...(cwd ? worktreeNames(cwd) : [])], prefix);
		},
		handler: async (args, ctx) => {
			const words = args.split(/\s+/u).filter(Boolean);
			const [name, action, ...extra] = words;
			if (extra.length > 0 || (action !== undefined && action !== "switch" && action !== "resume"))
				return say(ctx, USAGE, "warning");
			try {
				if (!name && ctx.hasUI) return await listPage(ctx, deps);
				const { view, sessionsProblem } = await collectRealms(ctx, deps);
				const now = (deps.now ?? Date.now)();
				if (!name) return say(ctx, realmList(view, now, sessionsProblem).join("\n"));
				const realm = findRealm(view, name);
				if (!realm)
					return say(
						ctx,
						`No realm named ${name}. Realms: ${view.realms.map((candidate) => candidate.name).join(", ")}.`,
						"warning",
					);
				if (action === "switch") return await switchTo(realm, ctx);
				if (action === "resume") return await resumeFrom(realm, ctx);
				if (ctx.hasUI) {
					await realmPage(realm, view, ctx, now);
					return;
				}
				say(ctx, realmDetail(realm, view, now).join("\n"));
			} catch (error) {
				say(ctx, errorMessage(error), "error");
			}
		},
	};
}
