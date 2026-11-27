import type { CommandContext, FeatureSetup } from "../../core/features/index.ts";
import { builtinDescription } from "../../core/slash-commands.ts";
import { type MonitorLedger, monitorLedgerOf } from "../monitor/ledger.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { type PageRow, showCommandPage } from "../shared/page.ts";
import { type RoomRow, roomDetail, roomRows, roomText } from "./rows.ts";

export interface MonitorRoomOptions {
	/** The ledger to read; the session's own by default. */
	ledger?: Pick<MonitorLedger, "rules">;
	now?: () => number;
}

const pageRow = (row: RoomRow): PageRow => ({
	id: row.rule,
	name: row.rule,
	detail: roomDetail(row),
	badge: row.state,
	tone: row.state === "tripped" ? "warning" : "muted",
});

/** One rule's page: its figures as facts; resolves when the user goes back. */
async function rulePage(ctx: CommandContext, row: RoomRow): Promise<void> {
	await showCommandPage(ctx.ui, {
		title: `Monitor \u00b7 ${row.rule}`,
		facts: [
			{ label: "State", value: row.state },
			{ label: "Reading", value: row.reading },
			{ label: "Trips", value: String(row.trips) },
			{ label: "Alerts", value: String(row.alerts) },
			{ label: "Last alert", value: row.lastAlert },
			{ label: "Subject", value: row.subject },
		],
		notes: ["Alerts count only what reached this session; a trip can also be recorded when it did not."],
		sections: [],
		nested: true,
	});
}

/**
 * `/monitor`: every monitor rule with its state, last reading against its threshold, trips, alerts, last alert and subject,
 * read from the session's ledger. A screen gets a page that opens a rule's figures; a session without one gets the table as
 * text, and `text` asks for the table anywhere.
 */
export function registerMonitorRoom(commands: Subcommands, api: FeatureSetup, options: MonitorRoomOptions = {}): void {
	const now = options.now ?? Date.now;
	const rows = () => roomRows((options.ledger ?? monitorLedgerOf(api)).rules(), now());
	commands.add("monitor", {
		description: builtinDescription("monitor"),
		argumentHint: "[text]",
		argumentWords: ["text"],
		complete: (prefix) => wordCompletions(["text"], prefix),
		handler: async (args, ctx) => {
			if (args !== "" && args !== "text") return say(ctx, "Usage: /monitor [text]", "warning");
			if (args === "text" || !ctx.hasUI) return say(ctx, roomText(rows()));
			let current: string | undefined;
			for (;;) {
				const list = rows();
				const tripped = list.filter((row) => row.state === "tripped").length;
				const choice = await showCommandPage(ctx.ui, {
					title: "Monitor",
					facts: [
						{ label: "Rules", value: String(list.length) },
						{ label: "Tripped", value: String(tripped) },
					],
					sections: [{ heading: "Rules", rows: list.map(pageRow) }],
					...(current ? { initialId: current } : {}),
					enter: "inspect",
				});
				if (!choice) return;
				current = choice.id;
				const row = list.find((entry) => entry.rule === choice.id);
				if (row) await rulePage(ctx, row);
			}
		},
	});
}
