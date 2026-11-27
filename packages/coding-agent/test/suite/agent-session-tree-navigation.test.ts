/**
 * AgentSession tree navigation with branch summarization, on the faux provider.
 *
 * Covers navigation to user messages (root and nested) and to non-user messages,
 * branch summaries and where they attach, abort during summarization, a no-op
 * navigation, custom summarization instructions, and leaving a side branch.
 */

import { fauxAssistantMessage, type FauxResponseFactory } from "@octocodeai/octocode-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const SUMMARY = "Summary of the abandoned branch.";

describe("AgentSession tree navigation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function setup(): Promise<Harness> {
		const harness = await createHarness({ compactionPolicy: { keepRecentTokens: 1 } });
		harnesses.push(harness);
		return harness;
	}

	/** Runs one prompt per text; the faux model answers each with a short reply. */
	async function converse(harness: Harness, ...prompts: string[]): Promise<void> {
		for (const [index, prompt] of prompts.entries()) {
			harness.appendResponses([fauxAssistantMessage(`reply ${index + 1}`)]);
			await harness.session.prompt(prompt);
			await harness.session.agent.waitForIdle();
		}
	}

	function userEntries(harness: Harness) {
		return harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
	}

	function assistantEntries(harness: Harness) {
		return harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
	}

	it("navigates to the first user message and puts its text in the editor", async () => {
		const harness = await setup();
		await converse(harness, "First message", "Second message");

		expect(harness.sessionManager.getTree().length).toBe(1);
		const firstUser = userEntries(harness)[0];

		const result = await harness.session.navigateTree(firstUser.id, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("First message");
		// Navigating to the first user message leaves a conversation with no turns.
		expect(harness.sessionManager.getLeafId()).toBe(firstUser.parentId);
		expect(harness.session.messages.filter((message) => message.role !== "system")).toEqual([]);
	});

	it("navigates to a non-user message without editor text", async () => {
		const harness = await setup();
		await converse(harness, "Hello");

		const assistantEntry = assistantEntries(harness)[0];
		expect(assistantEntry).toBeDefined();

		const result = await harness.session.navigateTree(assistantEntry.id, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBeUndefined();
		expect(harness.sessionManager.getLeafId()).toBe(assistantEntry.id);
	});

	it("creates a branch summary when navigating to the first user message with summarize", async () => {
		const harness = await setup();
		await converse(harness, "What is 2+2?", "What is 3+3?");
		harness.appendResponses([fauxAssistantMessage(SUMMARY)]);

		const firstUser = userEntries(harness)[0];
		const result = await harness.session.navigateTree(firstUser.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("What is 2+2?");
		expect(result.summaryEntry?.type).toBe("branch_summary");
		expect(result.summaryEntry?.summary).toContain(SUMMARY);
		// The summary takes the place of the first user entry, under that entry's parent.
		expect(result.summaryEntry?.parentId).toBe(firstUser.parentId);
		expect(harness.sessionManager.getLeafId()).toBe(result.summaryEntry?.id);
	});

	it("attaches the summary to the parent of a nested user message", async () => {
		const harness = await setup();
		await converse(harness, "Message one", "Message two", "Message three");
		harness.appendResponses([fauxAssistantMessage(SUMMARY)]);

		const users = userEntries(harness);
		expect(users.length).toBe(3);
		const u2 = users[1];
		const a1 = harness.sessionManager.getEntries().find((entry) => entry.id === u2.parentId);
		expect(a1).toBeDefined();

		const result = await harness.session.navigateTree(u2.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("Message two");
		expect(result.summaryEntry).toBeDefined();
		// a1 now has two children: u2 and the summary.
		expect(result.summaryEntry?.parentId).toBe(a1?.id);
		const childTypes = harness.sessionManager
			.getChildren(a1!.id)
			.map((child) => child.type)
			.sort();
		expect(childTypes).toEqual(["branch_summary", "message"]);
	});

	it("attaches the summary to the selected assistant message", async () => {
		const harness = await setup();
		await converse(harness, "Hello", "Goodbye");
		harness.appendResponses([fauxAssistantMessage(SUMMARY)]);

		const a1 = assistantEntries(harness)[0];
		const result = await harness.session.navigateTree(a1.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBeUndefined();
		expect(result.summaryEntry?.parentId).toBe(a1.id);
		expect(harness.sessionManager.getLeafId()).toBe(result.summaryEntry?.id);
	});

	it("leaves the session unchanged when summarization is aborted", async () => {
		const harness = await setup();
		await converse(harness, "Tell me about something", "Continue");

		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blockedSummary: FauxResponseFactory = async () => {
			markStarted();
			await released;
			return fauxAssistantMessage(SUMMARY);
		};
		harness.appendResponses([blockedSummary]);

		const entriesBefore = harness.sessionManager.getEntries().length;
		const leafBefore = harness.sessionManager.getLeafId();
		const navigation = harness.session.navigateTree(userEntries(harness)[0].id, { summarize: true });
		await started;
		// Branch summarization counts as compacting while it runs.
		expect(harness.session.isCompacting).toBe(true);

		harness.session.abortBranchSummary();
		release();
		const result = await navigation;

		expect(result.cancelled).toBe(true);
		expect(result.aborted).toBe(true);
		expect(result.summaryEntry).toBeUndefined();
		expect(harness.sessionManager.getEntries().length).toBe(entriesBefore);
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
	});

	it("creates no summary when navigating without summarize", async () => {
		const harness = await setup();
		await converse(harness, "First", "Second");
		const entriesBefore = harness.sessionManager.getEntries().length;

		await harness.session.navigateTree(userEntries(harness)[0].id, { summarize: false });

		expect(harness.sessionManager.getEntries().length).toBe(entriesBefore);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "branch_summary")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("treats navigation to the current leaf as a no-op", async () => {
		const harness = await setup();
		await converse(harness, "Hello");

		const leafBefore = harness.sessionManager.getLeafId();
		expect(leafBefore).toBeTruthy();
		const entriesBefore = harness.sessionManager.getEntries().length;

		const result = await harness.session.navigateTree(leafBefore!, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries().length).toBe(entriesBefore);
	});

	it("passes custom summarization instructions to the model", async () => {
		const harness = await setup();
		await converse(harness, "What is TypeScript?");

		const instructions = "After the summary, end with exactly: MONKEY MONKEY MONKEY.";
		let request = "";
		harness.appendResponses([
			(context) => {
				request = JSON.stringify(context.messages);
				return fauxAssistantMessage(`${SUMMARY} MONKEY MONKEY MONKEY`);
			},
		]);

		const result = await harness.session.navigateTree(userEntries(harness)[0].id, {
			summarize: true,
			customInstructions: instructions,
		});

		expect(request).toContain(instructions);
		expect(result.summaryEntry?.summary).toContain("MONKEY MONKEY MONKEY");
	});

	it("summarizes the side branch it leaves when navigating back to the main branch", async () => {
		const harness = await setup();
		await converse(harness, "Main branch start", "Main branch continue");

		const mainEntries = harness.sessionManager.getEntries();
		const a1 = mainEntries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		const u2 = mainEntries.filter((entry) => entry.type === "message" && entry.message.role === "user")[1];

		// Branch from a1: a1 -> u3 -> a3.
		harness.sessionManager.branch(a1!.id);
		await converse(harness, "Branch path");

		let request = "";
		harness.appendResponses([
			(context) => {
				request = JSON.stringify(context.messages);
				return fauxAssistantMessage(SUMMARY);
			},
		]);
		const result = await harness.session.navigateTree(u2.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("Main branch continue");
		expect(result.summaryEntry?.summary).toContain(SUMMARY);
		// The summary covers the branch being left.
		expect(request).toContain("Branch path");
	});
});
