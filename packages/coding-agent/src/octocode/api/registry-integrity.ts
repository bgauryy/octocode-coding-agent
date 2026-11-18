import { renderPrompt } from "../../core/prompt-template.ts";
import {
	describeInstance,
	type InstanceEntry,
	type InstanceRecord,
	inOwnFile,
	listInstanceEntries,
	readInstance,
} from "./registry.ts";

/**
 * Any process of the user can write a record into the instances folder, so a record's id, name and pid are claims. The
 * one record that is an instance's is the one in its own file (`<id>.json`); a second live record that repeats its id,
 * name or pid means the registry cannot say which process is which, and both sides of a call fail closed on it.
 */

/** Two records that reach the same process the same way. */
export const sameRecord = (a: InstanceRecord, b: InstanceRecord): boolean =>
	a.id === b.id && a.pid === b.pid && a.socket === b.socket && a.http?.url === b.http?.url;

/** The entry in `entries` that is `record` as its own file holds it. */
const ownEntry = (entries: readonly InstanceEntry[], record: InstanceRecord): InstanceEntry | undefined =>
	entries.find((entry) => inOwnFile(entry) && sameRecord(entry.record, record));

/**
 * The record a ticket for a call to `target` may go to: `target` itself, when its own file holds exactly it and no other
 * live record repeats its name, id or pid. Otherwise throws what the sender's agent reads, and no ticket is issued.
 */
export function ticketTarget(dir: string, target: InstanceRecord): InstanceRecord {
	const name = target.name ?? target.id;
	const canonical = readInstance(dir, target.id);
	if (!canonical || !sameRecord(canonical, target))
		throw new Error(
			renderPrompt("notices/mail/peer-ambiguous.md", { moved: true, target: name, id: target.id, records: "" }),
		);
	const entries = listInstanceEntries(dir, false);
	const own = ownEntry(entries, canonical);
	const repeats = entries.filter(
		(entry) =>
			entry !== own &&
			(entry.record.id === canonical.id ||
				entry.record.pid === canonical.pid ||
				(entry.record.name ?? entry.record.id) === name),
	);
	if (!own || repeats.length > 0)
		throw new Error(
			renderPrompt("notices/mail/peer-ambiguous.md", {
				moved: false,
				target: name,
				id: target.id,
				records: [canonical, ...repeats.map((entry) => entry.record)].map(describeInstance).join("; "),
			}),
		);
	return canonical;
}

/**
 * What a receiver (`self`) may call back to confirm a claim: the claimed instance's record from its own file, with the
 * claimed pid, while the registry is consistent. It is not when the receiver's own file no longer holds what it wrote,
 * or when any other live record repeats the receiver's id or pid or the claimed instance's: a sender could have handed
 * such a record a ticket, so nothing it says is checked. `sharedName` says that another live record carries the claimed
 * instance's name, so a label must tell them apart.
 */
export function claimedInstance(
	dir: string,
	claim: { instanceId?: string; pid?: number },
	self: InstanceRecord,
): { record: InstanceRecord; sharedName: boolean } | undefined {
	if (claim.instanceId === undefined || claim.pid === undefined) return undefined;
	const record = readInstance(dir, claim.instanceId);
	if (!record || record.pid !== claim.pid) return undefined;
	const entries = listInstanceEntries(dir, false);
	const mine = ownEntry(entries, self);
	const theirs = ownEntry(entries, record);
	if (!mine || !theirs) return undefined;
	const others = entries.filter((entry) => entry !== mine && entry !== theirs);
	const repeats = (each: InstanceRecord) =>
		each.id === self.id || each.pid === self.pid || each.id === record.id || each.pid === record.pid;
	if (others.some((entry) => repeats(entry.record))) return undefined;
	const name = record.name ?? record.id;
	return { record, sharedName: others.some((entry) => (entry.record.name ?? entry.record.id) === name) };
}
