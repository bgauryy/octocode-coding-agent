import { findErrors, type HistoryErrors } from "../../../history/errors.ts";
import { historyScope } from "../../../history/transcripts.ts";
import { signaturesOf } from "../../../backlog/signature.ts";
import type { Item } from "../../../backlog/item.ts";
import { DAY_MS } from "../../../shared/util.ts";

/** The shortest window a rate is measured over. */
const MIN_WINDOW_DAYS = 7;

const errorsOf = (found: HistoryErrors, signature: string): number =>
	found.groups.filter((group) => group.signature === signature).reduce((sum, group) => sum + group.count, 0);

const rate = (count: number, days: number): string =>
	`${count} in ${days >= 1 ? Math.round(days) : "<1"}d (${(count / Math.max(days, 1)).toFixed(1)}/day)`;

/**
 * The rate of each error signature the item carries (`signature.ts`), over this workspace's sessions: of a done item,
 * before it was done and since, over windows no shorter than a week before; of an open one, the last week. Undefined when
 * the item carries none. Each rate is one scan of the transcripts, so it is read for `get` and `done` only.
 */
export async function signatureRates(
	item: Pick<Item, "evidence" | "state" | "doneAt">,
	cwd: string,
	signal?: AbortSignal,
	now = Date.now(),
): Promise<string | undefined> {
	const signatures = signaturesOf(item);
	if (signatures.length === 0) return undefined;
	const sessions = historyScope(cwd);
	const scan = (from: number) =>
		findErrors(sessions, { since: new Date(from).toISOString(), ...(signal ? { signal } : {}) });
	const doneAt = item.state === "done" ? (item.doneAt ?? now) : undefined;
	if (doneAt === undefined) {
		const week = await scan(now - MIN_WINDOW_DAYS * DAY_MS);
		return signatures
			.map((sig) => `Error "${sig}": ${rate(errorsOf(week, sig), MIN_WINDOW_DAYS)} over the last week.`)
			.join("\n");
	}
	const afterDays = (now - doneAt) / DAY_MS;
	const windowDays = Math.max(afterDays, MIN_WINDOW_DAYS);
	const [wide, after] = await Promise.all([scan(doneAt - windowDays * DAY_MS), scan(doneAt)]);
	return signatures
		.map((sig) => {
			const since = errorsOf(after, sig);
			const before = errorsOf(wide, sig) - since;
			return `Error "${sig}": before done ${rate(before, windowDays)}; since done ${afterDays < 1 / 24 ? "not measured yet" : rate(since, afterDays)}.`;
		})
		.join("\n");
}
