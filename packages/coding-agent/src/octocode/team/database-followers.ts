import { dbStamp, isBusy } from "../../../../db/src/api.ts";
import { DatabaseFollower } from "../shared/database-follower.ts";

/** A listener's own signal that the database was locked when it looked: the follower asks it again at the next tick. */
export class DatabaseBusy extends Error {
	constructor() {
		super("The team database is busy.");
		this.name = "DatabaseBusy";
	}
}

const followers = new Map<string, DatabaseFollower>();

/**
 * The one follower of the database file `file` in this process: every reader of the team database that wants to hear of
 * other processes' writes subscribes to it, so the file's stamp is read once a second however many listen, and not at
 * all while none does.
 */
export function followerFor(file: string): DatabaseFollower {
	let follower = followers.get(file);
	if (!follower) {
		follower = new DatabaseFollower(
			() => dbStamp(file),
			(error) => isBusy(error) || error instanceof DatabaseBusy,
		);
		followers.set(file, follower);
	}
	return follower;
}
