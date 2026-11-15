import type { ExtensionCommandContext } from "../../core/features/index.ts";
import { keyText } from "../../theme/theme-tui-helpers.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { confirmAction, type PageRow, type PageSection, showCommandPage } from "../shared/page.ts";
import {
	approveAll,
	checkTable,
	decideOne,
	findReview,
	listText,
	parseKinds,
	refreshed,
	SECURITY_VERBS,
	SecurityCommandError,
} from "./actions.ts";
import { isWithheld, knownReviews } from "./registry.ts";
import { renderReport, sortReviews, visible } from "./report.ts";
import { badge, type Review } from "./types.ts";

/**
 * `/security`: what the extension guard found this session, each item's report, and the user's decisions. Decisions
 * made in one visit share one reload when the page closes, so the tool list and the prompt cache change once.
 */

const USAGE =
	"Usage: /security [list [text]|show <id>|check|approve <id>|approve --all [--kind hooks,mcp,skills]|deny <id>|forget <id>]";

const enforced = (review: Review) => isWithheld(review) || review.word === "approved";

const rowOf = (review: Review): PageRow => ({
	id: review.item.id,
	name: visible(review.item.label),
	detail: `${review.item.kind === "mcp" ? "MCP server" : review.item.kind} · ${visible(review.item.path)}`,
	badge: badge(review),
	tone: review.word === "approved" ? "success" : review.word === "denied" ? "muted" : "warning",
});

function sections(reviews: readonly Review[]): PageSection[] {
	const sorted = sortReviews(reviews);
	return (["not checked", "approved", "denied"] as const).flatMap((word) => {
		const rows = sorted.filter((review) => review.word === word).map(rowOf);
		return rows.length ? [{ heading: `${word[0]?.toUpperCase()}${word.slice(1)}`, rows }] : [];
	});
}

/** One report page; resolves with the decision taken, or undefined for back. */
async function reviewPage(ctx: ExtensionCommandContext, review: Review): Promise<"approve" | "deny" | undefined> {
	const choice = await showCommandPage(ctx.ui, {
		title: `Security · ${visible(review.item.label)}`,
		responsive: true,
		notes: renderReport(review).split("\n"),
		sections: [
			{
				heading: "Decide",
				rows: [
					...(review.item.unreadable ? [] : [{ id: "approve", name: "Approve this exact content" }]),
					{ id: "deny", name: "Deny" },
				],
			},
		],
		keys: ["a", "d"],
		hints: [
			["a", "approve", 1],
			["d", "deny", 2],
			[keyText("tui.select.cancel"), "back", 0],
		],
	});
	if (!choice) return undefined;
	const verb = choice.key === "a" ? "approve" : choice.key === "d" ? "deny" : choice.id;
	if (verb !== "approve" && verb !== "deny") return undefined;
	if (verb === "approve" && (review.rating === "HIGH" || review.rating === "CRITICAL")) {
		const select = (title: string, options: string[]) => ctx.ui.select(title, options);
		const grants = review.item.grants.join("; ");
		if (!(await confirmAction(select, `Approve ${review.item.id} (${review.rating})? It gets: ${grants}`, ["Approve"])))
			return undefined;
	}
	return verb;
}

/** The terminal page: the list, then a report per row; returns whether a decision changed what loads. */
async function page(ctx: ExtensionCommandContext): Promise<boolean> {
	let changed = false;
	let current: string | undefined;
	for (;;) {
		const reviews = refreshed(knownReviews());
		const waiting = reviews.filter((review) => review.word !== "approved").length;
		const choice = await showCommandPage(ctx.ui, {
			title: "Security",
			facts: [
				{ label: "Not checked", value: String(reviews.filter((review) => review.word === "not checked").length) },
				{ label: "Approved", value: String(reviews.filter((review) => review.word === "approved").length) },
				{ label: "Denied", value: String(reviews.filter((review) => review.word === "denied").length) },
			],
			notes: [waiting ? "Items that are not approved stay off." : "Nothing is waiting."],
			sections: sections(reviews),
			...(current ? { initialId: current } : {}),
			hints: [
				["↑↓", "move", 1],
				[keyText("tui.select.confirm"), "review", 2],
				[keyText("tui.select.cancel"), "close", 0],
			],
		});
		if (!choice) return changed;
		current = choice.id;
		const review = reviews.find((entry) => entry.item.id === choice.id);
		if (!review) continue;
		const verb = await reviewPage(ctx, review);
		if (!verb) continue;
		say(ctx, decideOne(review, verb, "page"));
		changed ||= (verb === "approve") !== (review.word === "approved");
	}
}

/** Runs one text verb; returns whether a decision changed what loads. */
function runVerb(ctx: ExtensionCommandContext, sub: string, words: string[]): boolean {
	const reviews = refreshed(knownReviews());
	if (sub === "list" || sub === "check") {
		say(ctx, sub === "list" ? listText(reviews, enforced, words.join(" ") || undefined) : checkTable(reviews));
		return false;
	}
	if (sub === "approve" && words[0] === "--all") {
		const kindAt = words.indexOf("--kind");
		const { lines, approved } = approveAll(reviews, parseKinds(kindAt >= 0 ? words[kindAt + 1] : undefined), "command");
		say(ctx, lines.join("\n"));
		return approved > 0;
	}
	const [id] = words;
	if (!id || !["show", "approve", "deny", "forget"].includes(sub)) throw new SecurityCommandError(USAGE);
	const review = findReview(reviews, id);
	if (sub === "show") {
		say(ctx, renderReport(review));
		return false;
	}
	say(ctx, decideOne(review, sub as "approve" | "deny" | "forget", "command"));
	return true;
}

export function registerSecurityCommand(commands: Subcommands): void {
	commands.add("security", {
		description: "Review hooks, MCP servers and skills",
		argumentHint: "[list|show|check|approve|deny|forget]",
		complete: (prefix) => wordCompletions([...SECURITY_VERBS], prefix),
		handler: async (args, ctx) => {
			const [sub = "", ...words] = args.split(/\s+/).filter(Boolean);
			let changed: boolean;
			try {
				if (sub === "" && ctx.hasUI && ctx.mode === "tui") changed = await page(ctx);
				else changed = runVerb(ctx, sub || "list", words);
			} catch (error) {
				if (!(error instanceof SecurityCommandError)) throw error;
				return say(ctx, error.message, "warning");
			}
			// One reload applies every decision of this visit: approved items load, denied ones go off.
			if (changed) await ctx.reload();
		},
	});
}
