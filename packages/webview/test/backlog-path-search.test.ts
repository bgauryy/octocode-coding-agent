import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { expect, it } from "vitest";
import { filterBoard, indexBacklog } from "../src/app/model/backlog.ts";
import { snapshotItem } from "./helpers.ts";

it("the board search finds items by a file or folder path, on whole path segments", () => {
	const items = [
		snapshotItem("B1", { paths: ["packages/db/src/queries/a.ts"] }),
		snapshotItem("B2", { paths: ["packages/db/"] }),
		snapshotItem("B3", { paths: ["packages/dbx"] }),
		snapshotItem("B4", { evidence: ["packages/db/src/queries/a.ts:42 — the filter"] }),
	];
	const snapshot: Snapshot = {
		repo: "repo",
		generatedAt: 10,
		states: ["backlog", "todo", "ongoing", "done"],
		idleMs: 1000,
		items,
	};
	const index = indexBacklog(snapshot);
	const refs = (q: string) =>
		filterBoard(index, { q })
			.map((it) => it.ref)
			.sort();
	expect(refs("./packages/db/src/queries/a.ts")).toEqual(["B1", "B2", "B4"]);
	expect(refs("packages\\db\\src\\queries\\")).toEqual(["B1", "B2", "B4"]);
	expect(refs("packages/dbx/")).toEqual(["B3"]);
});
