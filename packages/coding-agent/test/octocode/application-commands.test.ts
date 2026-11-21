import { registerFixtureWorkspace } from "./backlog-fixture.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApplicationCommand } from "@octocodeai/octocode-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAgentDb } from "../../src/storage/database.ts";
import { type AgentDb } from "../../../db/src/api.ts";
import { WorkspaceCommands } from "../../src/octocode/workspace/commands.ts";
import { ApplicationCommands } from "../../src/octocode/workspace/application-commands.ts";

let dir: string;
let db: AgentDb;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "application-receipts-"));
	db = openAgentDb(path.join(dir, "db"));
	registerFixtureWorkspace(db, "repo");
	registerFixtureWorkspace(db, "other-repo");
});
afterEach(() => {
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});
const command = (sessionId = "session-one", text = "Review the implementation"): ApplicationCommand => ({
	id: "request-one",
	sessionId,
	action: "prompt",
	text,
});

describe("durable application receipts", () => {
	it("retains an uncertain accepted request across database reopen without fresh execution", async () => {
		expect(await new ApplicationCommands(db, "repo").begin(command())).toMatchObject({
			fresh: true,
			receipt: { status: "accepted" },
		});
		db.close();
		db = openAgentDb(path.join(dir, "db"));
		expect(await new ApplicationCommands(db, "repo").begin(command())).toMatchObject({
			fresh: false,
			receipt: { id: "request-one", status: "accepted" },
		});
	});

	it("recognizes the same payload regardless of JSON field order", async () => {
		const receipts = new ApplicationCommands(db, "repo");
		await receipts.begin(command());
		const reordered: ApplicationCommand = {
			text: "Review the implementation",
			action: "prompt",
			sessionId: "session-one",
			id: "request-one",
		};
		expect((await receipts.begin(reordered)).fresh).toBe(false);
	});

	it("refuses altered payloads under the same request identity", async () => {
		const receipts = new ApplicationCommands(db, "repo");
		await receipts.begin(command());
		await expect(receipts.begin(command("session-one", "Different instruction"))).rejects.toThrow(/another command/);
		expect((await receipts.begin(command())).fresh).toBe(false);
	});

	it("isolates identical request IDs by session and repository", async () => {
		const first = new ApplicationCommands(db, "repo");
		const second = new ApplicationCommands(db, "repo");
		const otherRepo = new ApplicationCommands(db, "other-repo");
		await first.begin(command());
		await second.begin(command("session-two"));
		await otherRepo.begin(command());
		await first.finish("request-one", "completed");
		expect((await first.begin(command())).receipt.status).toBe("completed");
		expect((await second.begin(command("session-two"))).receipt.status).toBe("accepted");
		expect((await otherRepo.begin(command())).receipt.status).toBe("accepted");
	});

	it("persists a failed outcome and its explanation", async () => {
		const receipts = new ApplicationCommands(db, "repo");
		await receipts.begin(command());
		await receipts.finish("request-one", "failed", "The agent stopped before processing this request.");
		expect(await new ApplicationCommands(db, "repo").begin(command())).toMatchObject({
			fresh: false,
			receipt: {
				status: "failed",
				message: "The agent stopped before processing this request.",
			},
		});
	});

	it("redacts credential-shaped failure details before persistence and return", async () => {
		const receipts = new ApplicationCommands(db, "repo");
		await receipts.begin(command());
		const secret = "sk-test123456789012345678901234567890";
		const receipt = await receipts.finish("request-one", "failed", `Provider rejected credential ${secret}`);
		expect(receipt.message).toContain("[redacted]");
		expect(receipt.message).not.toContain(secret);
		const row = db.db.prepare("SELECT message FROM workspace_commands WHERE id=?").get("application:request-one") as {
			message: string;
		};
		expect(row.message).toEqual(receipt.message);
		expect((await new ApplicationCommands(db, "repo").begin(command())).receipt.message).toEqual(receipt.message);
	});

	it("rejects credentials before creating a receipt", async () => {
		const receipts = new ApplicationCommands(db, "repo");
		await expect(
			receipts.begin(command("session-one", "api_key=sk-test123456789012345678901234567890")),
		).rejects.toThrow(/credentials/);
		expect((await receipts.begin(command())).fresh).toBe(true);
	});

	it("keeps application receipts out of workspace command snapshots", async () => {
		const receipts = new ApplicationCommands(db, "repo");
		await receipts.begin(command());
		await receipts.finish("request-one", "completed");
		const workspace = new WorkspaceCommands(db, "repo", "session-one");
		await workspace.begin({ id: "application:user-selected-id", action: "message", to: "worker", text: "Review this" });
		expect(workspace.list()).toEqual([
			expect.objectContaining({ id: "application:user-selected-id", action: "message", status: "pending" }),
		]);
	});

	it("does not let a later session redirect the completion of accepted work", async () => {
		const receipts = new ApplicationCommands(db, "repo");
		await receipts.begin(command());
		await expect(receipts.begin(command("session-two"))).rejects.toThrow(/session/i);
		await receipts.finish("request-one", "completed");
		expect((await new ApplicationCommands(db, "repo").begin(command())).receipt.status).toBe("completed");
		expect((await new ApplicationCommands(db, "repo").begin(command("session-two"))).fresh).toBe(true);
	});
});
