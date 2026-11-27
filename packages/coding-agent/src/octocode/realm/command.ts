import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { builtinDescription } from "../../core/slash-commands.ts";
import type { CommandContext } from "../../core/features/index.ts";
import { cancelledText, type Subcommand, say, wordCompletions } from "../shared/commands.ts";
import { type Notice, noticeText } from "../../theme/notice.ts";
import { worktreeNames } from "../worktrees/names.ts";
import { MAIN_CHECKOUT, switchToWorktree } from "../worktrees/switch.ts";
import { collectPlaces, type PlaceDependencies } from "./collect.ts";
import { collectRealm, realmLines, type RealmSource } from "./process.ts";
import { findPlace, type Place, type PlaceView } from "./model.ts";
import { placeDetail, placeList, placeListParts, sessionState, switchProblem, switchTarget } from "./render.ts";

const USAGE = "Usage: /realm places [<name> [switch|resume]]";
const REALM_USAGE = "Usage: /realm [places [<name> [switch|resume]]]";

export interface RealmCommandDependencies extends PlaceDependencies {
	/** This process's team row and children, for the bare `/realm`. */
	realm: RealmSource;
	/** The session's folder, for completing names: the process directory does not follow `switch` or `/resume`. */
	cwd?: () => string | undefined;
	/** The clock, for tests. */
	now?: () => number;
}

/** `/realm <name> switch`: the worktree switch (idle only, the old session stays saved), after saying why a place cannot be entered. */
async function switchTo(place: Place, ctx: CommandContext): Promise<void> {
	const problem = switchProblem(place);
	if (problem) return say(ctx, `Cannot switch to ${place.name}. ${problem}`, "warning");
	await switchToWorktree(switchTarget(place), ctx);
}

/** `/realm <name> resume`: a picker of the saved sessions started in the place, or their ids as text without a UI. */
async function resumeFrom(place: Place, ctx: CommandContext): Promise<void> {
	if (place.sessions.length === 0) return say(ctx, `No saved session was started in ${place.name}.`);
	if (!ctx.hasUI || !ctx.ui.pickSession) {
		const notice: Notice = {
			title: `Sessions started in ${place.name}`,
			rows: place.sessions.map((session) => [sessionState(session), `${session.name ?? "(unnamed)"} · ${session.id}`]),
			hint: "open one with /resume all <id>",
		};
		return say(ctx, noticeText(notice));
	}
	const picked = await ctx.ui.pickSession({
		initialScope: "all",
		onlySessions: new Set(place.sessions.map((session) => session.id)),
	});
	if (!picked) return;
	const session = place.sessions.find((candidate) => candidate.id === picked.id);
	if (!session) return say(ctx, `The selected session does not belong to ${place.name}.`, "warning");
	if (session.current) return say(ctx, "That is the current session.");
	// Another process may have it open; two writers on one transcript need the user's say.
	if (
		session.live &&
		!(await ctx.ui.confirm(
			"Session is running",
			"Another Octocode process has this session open. Resume it here as well?",
		))
	)
		return say(ctx, cancelledText("resumed"));
	await ctx.switchSession(session.file);
}

/** The place's page: its detail and the actions that apply, until the user goes back. Resolves true once an action ended the page. */
async function placePage(place: Place, view: PlaceView, ctx: CommandContext, now: number): Promise<boolean> {
	const switchLabel = `Switch this session to ${place.name}`;
	const resumeLabel = `Resume a session from ${place.name}`;
	const options = [
		...(switchProblem(place) ? [] : [switchLabel]),
		...(place.sessions.length > 0 ? [resumeLabel] : []),
		"Back",
	];
	const choice = await ctx.ui.select(placeDetail(place, view, now).join("\n"), options);
	if (choice === switchLabel) await switchTo(place, ctx);
	else if (choice === resumeLabel) await resumeFrom(place, ctx);
	return choice === switchLabel || choice === resumeLabel || choice === undefined;
}

/** The place list as a picker: Enter opens a place's page, Escape closes. Running work is never touched. */
async function listPage(ctx: CommandContext, deps: RealmCommandDependencies): Promise<void> {
	for (;;) {
		const { view, sessionsProblem } = await collectPlaces(ctx, deps);
		const now = (deps.now ?? Date.now)();
		const { header, rows, footer } = placeListParts(view, now, sessionsProblem);
		const picked = await ctx.ui.select([...header, ...footer].join("\n"), rows);
		const place = picked === undefined ? undefined : view.places[rows.indexOf(picked)];
		if (!place) return;
		if (await placePage(place, view, ctx, now)) return;
	}
}

/** `/realm places`: the repository's checkout, worktrees and sessions in one place, with `switch` and `resume` per place. */
function placesCommand(deps: RealmCommandDependencies): Subcommand {
	return {
		description: "The repository's checkout, worktrees and sessions",
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
				const { view, sessionsProblem } = await collectPlaces(ctx, deps);
				const now = (deps.now ?? Date.now)();
				if (!name) return say(ctx, placeList(view, now, sessionsProblem).join("\n"));
				const place = findPlace(view, name);
				if (!place)
					return say(
						ctx,
						`No place named ${name}. Places: ${view.places.map((candidate) => candidate.name).join(", ")}.`,
						"warning",
					);
				if (action === "switch") return await switchTo(place, ctx);
				if (action === "resume") return await resumeFrom(place, ctx);
				if (ctx.hasUI) {
					await placePage(place, view, ctx, now);
					return;
				}
				say(ctx, placeDetail(place, view, now).join("\n"));
			} catch (error) {
				say(ctx, errorMessage(error), "error");
			}
		},
	};
}

/** `/realm`: this process's session, place, live children and isolated results to merge; `places` lists the repository's places. */
export function realmCommand(deps: RealmCommandDependencies): Subcommand {
	const places = placesCommand(deps);
	return {
		description: builtinDescription("realm"),
		argumentHint: "[places [<name> [switch|resume]]]",
		complete: (prefix) => {
			const inner = /^places\s+(.*)$/su.exec(prefix);
			if (!inner) return wordCompletions([["places", "the repository's checkouts, worktrees and sessions"]], prefix);
			return places.complete?.(inner[1])?.map((item) => ({ ...item, value: `places ${item.value}` })) ?? null;
		},
		handler: async (args, ctx) => {
			const [first, ...rest] = args.split(/\s+/u).filter(Boolean);
			if (first === "places") return places.handler(rest.join(" "), ctx);
			if (first) return say(ctx, REALM_USAGE, "warning");
			try {
				const realm = await collectRealm(ctx.cwd, deps.realm);
				say(ctx, realmLines(realm, (deps.now ?? Date.now)(), deps.realm.id()).join("\n"));
			} catch (error) {
				say(ctx, errorMessage(error), "error");
			}
		},
	};
}
