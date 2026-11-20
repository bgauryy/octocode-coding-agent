import { truncateToWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui/text";
import { styledLine } from "@octocodeai/octocode-common/sanitize";
import type { StatusEntry } from "../../../core/footer-data-provider.ts";
import { paintStatus } from "../../../theme/status.ts";
import { PERMISSION_ID } from "../../permission/mode.ts";
import { STATUS } from "../../shared/status.ts";
import { fitFooterLine, fitFooterZones, type FooterPaint, type FooterPart } from "./fit.ts";
import { chipPart, healthParts, plainRow, PRIORITY, sigmaText, wherePart } from "./parts.ts";
import type { FooterState } from "./state.ts";

export { contextBar } from "./parts.ts";
export type { FooterState } from "./state.ts";

/**
 * Octocode's two-line footer. Line 1 has three zones: environment on the left (cwd ⎇ branch, the permission chip, the
 * plan mark), health in the center (context fill, tokens spent, the cached share, as one string) and totals on the
 * right (running work, queued messages, what full mode ran, a running hook or a pending retry, and the one total cost
 * `Σ`). Line 2 is the model as `model:effort` with its kind, session name and compactions on the left, and details on
 * the right (steps, backlog, the GitHub token, the last run's speed, timer judging spend, other statuses, hints).
 * Every part of a line shrinks in one priority order (`PRIORITY`); the session's own figures are in /status.
 * Alerts that do not fit use up to three extra rows. Rendering is pure in (state, branch, statuses, width).
 */

/** Status keys this footer places itself; any other feature's status is appended to line 2's details. */
const OWN = {
	permission: PERMISSION_ID,
	plan: STATUS.plan,
	team: STATUS.team,
	running: STATUS.running,
	queued: STATUS.queued,
	speed: STATUS.speed,
	hooks: STATUS.hooks,
	backlog: STATUS.backlog,
	steps: STATUS.steps,
	wakeRetry: STATUS.wakeRetry,
	timers: STATUS.timers,
} as const;
/** Commands worth knowing, shown last and only when the line has room. */
const HINTS = "/providers · /model · /resume";
const HINTS_PRIORITY = 2;
/** Line-1 details moved to line 2 rank just above the hints, below every detail of line 2's own. */
const MOVED = HINTS_PRIORITY + 1;

const isAlert = (entry: StatusEntry | undefined) => entry?.tone === "error" || entry?.tone === "warning";

export function footerLines(
	state: FooterState,
	branch: string | null,
	statuses: ReadonlyMap<string, StatusEntry>,
	theme: FooterPaint,
	width: number,
): string[] {
	// Statuses are data: each is painted in its tone with this frame's theme, so a theme switch reaches every one.
	// A status may carry its own colours; any other control goes, and it stays on one row (`styledLine`).
	const text = (key: string) => styledLine(statuses.get(key)?.text ?? "");
	const status = (key: string, shown = text(key)) => paintStatus({ text: shown, tone: statuses.get(key)?.tone }, theme);
	const sigma = sigmaText(state, theme);
	// `5 agents · 1 bash · 1 timer` collapses to its first count, which stays: work running is never hidden.
	const running = text(OWN.running);
	const firstCount = running.split(" · ")[0];
	const team = statuses.get(OWN.team);
	const counters = state.chip?.counters ?? "";
	const top = fitFooterZones(
		{
			left: [
				wherePart(state, branch, theme, width),
				chipPart(state.chip, theme),
				{ text: status(OWN.plan), priority: PRIORITY.plan, keep: true },
			],
			center: healthParts(state, theme),
			right: [
				{
					text: running ? status(OWN.running) : "",
					...(firstCount !== running ? { short: status(OWN.running, firstCount) } : {}),
					priority: PRIORITY.runningCollapse,
					floor: PRIORITY.runningFloor,
					keep: true,
					details: true,
				},
				// `team off` or `team retrying` describes work state and stays; the routine count gives way.
				// As an alert it has the alert rows below: on a row too narrow it leaves whole instead of showing a cut copy.
				{
					text: status(OWN.team),
					priority: isAlert(team) ? PRIORITY.wakeRetry : PRIORITY.team,
					keep: isAlert(team),
					spills: isAlert(team),
					details: true,
				},
				// Messages waiting for the run to end: the user should see theirs did not get lost.
				{ text: status(OWN.queued), priority: PRIORITY.queued, keep: true, details: true },
				// What full mode ran unasked (`12 actions · 2 ⚠`).
				{ text: counters ? theme.fg("muted", counters) : "", priority: PRIORITY.actions, details: true },
				// Its clock grows: it gives way first, so nothing else moves with it.
				{ text: status(OWN.hooks), priority: PRIORITY.hooks, details: true },
				// A turn that a provider error ended, waiting to try again: work the user would otherwise think had stopped.
				{
					text: status(OWN.wakeRetry),
					priority: PRIORITY.wakeRetry,
					keep: true,
					spills: isAlert(statuses.get(OWN.wakeRetry)),
					details: true,
				},
				{ text: sigma, priority: PRIORITY.sigma, keep: true, details: true },
			],
		},
		theme,
		width,
	);

	// `model:effort`, the spelling the agents panel uses for `name:effort`; the short form cuts it to a third of the row.
	const model = plainRow(`${state.model ?? "no model"}${state.thinking ? `:${state.thinking}` : ""}`);
	const shortModel = plainRow(truncateToWidth(model, Math.max(1, Math.floor(width / 3)), "…"));
	const identity: FooterPart[] = [
		{
			text: theme.fg("accent", model),
			priority: 94,
			keep: true,
			...(shortModel !== model ? { short: theme.fg("accent", shortModel) } : {}),
		},
		// The provider's kind beside the model: the first part to go on a narrow terminal.
		{ text: state.kind ? theme.fg("muted", state.kind) : "", priority: 5 },
		// Session names come from anywhere (RPC, other features); Octocode strips only newlines.
		{ text: state.sessionName ? theme.fg("muted", plainRow(state.sessionName)) : "", priority: 50 },
		{
			// Shown once there is one: zero compactions is the normal state, not news.
			text: state.compactions
				? theme.fg("muted", `${state.compactions} compaction${state.compactions === 1 ? "" : "s"}`)
				: "",
			priority: 75,
		},
	];
	const others = [...statuses]
		.filter(([key]) => !(Object.values(OWN) as string[]).includes(key))
		.sort(([a], [b]) => a.localeCompare(b));
	const details: FooterPart[] = [
		{ text: status(OWN.steps), priority: 76, keep: true, details: true },
		{ text: status(OWN.backlog), priority: 20, keep: true, short: theme.fg("dim", "/web") },
		// Glyph and word, never colour alone: NO_COLOR still reads.
		state.githubToken === undefined
			? { text: "", priority: 0 }
			: state.githubToken
				? { text: theme.fg("success", "✓ GitHub"), priority: 30 }
				: { text: theme.fg("error", "✗ GitHub token"), priority: 60, short: theme.fg("error", "✗ GitHub") },
		// The speed of the last run: hidden while the next one works.
		{ text: text(OWN.speed) && !state.running ? theme.fg("dim", text(OWN.speed)) : "", priority: 10 },
		// What judging timer conditions spent.
		{ text: status(OWN.timers), priority: 35, details: true },
		...others.map(([key, entry]) => ({
			text: status(key),
			priority: entry.tone === "error" ? 110 : entry.tone === "warning" ? 105 : 20,
			keep: isAlert(entry),
			// An alert that does not fit whole gets the alert rows below instead of cutting the model.
			spills: isAlert(entry),
			details: true,
		})),
		// The first part to give way: it only helps while the line has room.
		{ text: theme.fg("dim", HINTS), priority: HINTS_PRIORITY },
	];
	// A detail line 1 dropped whole moves to line 2 into room only the hints held; only what neither line shows needs
	// /status.
	const moved = top.dropped.map((part): FooterPart => ({
		...part,
		priority: MOVED,
		later: MOVED,
		floor: undefined,
		keep: false,
		spills: false,
	}));
	let bottom = fitFooterLine(identity, [...moved, ...details], theme, width);
	const detailsHidden = top.partlyHidden || bottom.detailsHidden;
	const detailsRoute = width < 9 ? "/status" : "… /status";
	if (detailsHidden) {
		bottom = fitFooterLine(
			identity,
			[...moved, ...details, { text: theme.fg("dim", detailsRoute), priority: 101, keep: true }],
			theme,
			width,
		);
	}
	const lines = [top.line, bottom.line];
	// Overflow alerts get two text rows and one explicit details route. A long feature status must not fill the screen.
	if (width > 1) {
		const alerts = [...statuses]
			.filter(([key, entry]) => key !== PERMISSION_ID && key !== OWN.plan && isAlert(entry))
			.sort(([, a], [, b]) => Number(b.tone === "error") - Number(a.tone === "error"))
			.filter(([key]) => {
				const shown = status(key);
				return shown && !lines.some((line) => line.includes(shown));
			});
		let remainingRows = 2;
		let omitted = 0;
		for (const [key, entry] of alerts) {
			if (remainingRows === 0) {
				omitted++;
				continue;
			}
			const alert = paintStatus({ text: `${entry.tone}: ${text(key)}`, tone: entry.tone }, theme);
			const clipped = truncateToWidth(alert, width * remainingRows, "…");
			const wrapped = wrapTextWithAnsi(clipped, width);
			const rows = wrapped.slice(0, remainingRows);
			lines.push(...rows);
			remainingRows -= rows.length;
			if (clipped !== alert || wrapped.length > rows.length) omitted++;
		}
		const needsRoute = width >= 7 && detailsHidden && !lines.some((line) => line.includes("/status"));
		if (omitted > 0 || needsRoute) {
			const route = omitted > 0 ? `+${omitted} alerts · /status` : detailsRoute;
			lines.push(truncateToWidth(theme.fg(omitted > 0 ? "warning" : "dim", route), width, "…"));
		}
	}
	return lines;
}
