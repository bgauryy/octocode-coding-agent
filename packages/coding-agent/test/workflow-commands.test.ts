import { stripVTControlCharacters } from "node:util";
import { Container } from "@octocodeai/octocode-tui";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearSideQuestions, sideQuestionsFor } from "../src/core/agent-session/side-questions.ts";
import { handleWorkflowCommand } from "../src/modes/interactive/interactive-mode/workflow-commands.ts";
import { getMarkdownTheme, initTheme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness;
beforeAll(() => initTheme("dark"));
afterEach(() => harness?.cleanup());

async function setup() {
	harness = await createHarness();
	const chatContainer = new Container();
	const showCustomDialog = vi.fn();
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const host = createFakeHost({
		session: harness.session,
		chatContainer,
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		showCustomDialog,
		showSelectorDialog: vi.fn(),
		showStatus,
		showWarning,
		ui: { requestRender: vi.fn() },
	});
	const text = () => stripVTControlCharacters(chatContainer.render(100).join("\n"));
	return { host, chatContainer, showCustomDialog, showStatus, showWarning, text };
}

function streamAnswers(answer: string) {
	const release: Array<() => void> = [];
	harness.session.agent.streamFunction = (model) => {
		const stream = createAssistantMessageEventStream();
		release.push(() =>
			stream.push({
				type: "done",
				reason: "stop",
				message: { ...fauxAssistantMessage(answer), api: model.api, provider: model.provider, model: model.id },
			}),
		);
		return stream;
	};
	return release;
}

describe("workflow commands render in the message list", () => {
	it("adds /context and /context all to the chat without opening an overlay", async () => {
		const { host, chatContainer, showCustomDialog, text } = await setup();
		await handleWorkflowCommand(host, "context", "");
		expect(chatContainer.children.length).toBeGreaterThan(0);
		expect(text()).toContain("Context");
		const before = chatContainer.children.length;
		await handleWorkflowCommand(host, "context", "all");
		expect(chatContainer.children.length).toBeGreaterThan(before);
		expect(showCustomDialog).not.toHaveBeenCalled();
	});

	it("shows usage for a bare /btw with no side thread", async () => {
		const { host, showCustomDialog, showWarning, text } = await setup();
		await handleWorkflowCommand(host, "btw", "");
		expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("/btw --cancel"));
		expect(text()).not.toContain("Side thread");
		expect(showCustomDialog).not.toHaveBeenCalled();
	});

	it("updates a /btw question in place and later shows the whole thread for bare /btw", async () => {
		const { host, text, showCustomDialog } = await setup();
		const release = streamAnswers("private answer");
		await handleWorkflowCommand(host, "btw", "first question");
		expect(text()).toContain("first question");
		expect(text()).toContain("Answering…");
		await vi.waitFor(() => expect(release).toHaveLength(1));
		release[0]();
		await vi.waitFor(() => expect(text()).toContain("private answer"));
		expect(text()).not.toContain("Answering…");
		await handleWorkflowCommand(host, "btw", "");
		expect(text().match(/first question/g)).toHaveLength(2);
		expect(showCustomDialog).not.toHaveBeenCalled();
	});

	it("cancels a running /btw question with --cancel and reports it in that question's block", async () => {
		const { host, showStatus, text } = await setup();
		streamAnswers("never delivered");
		await handleWorkflowCommand(host, "btw", "slow question");
		await handleWorkflowCommand(host, "btw", "--cancel");
		await vi.waitFor(() => expect(text()).toContain("Side question cancelled."));
		expect(text()).not.toContain("Answering…");
		await handleWorkflowCommand(host, "btw", "--cancel");
		expect(showStatus).toHaveBeenLastCalledWith("No side question is running.");
	});

	it("leaves a cleared chat empty when a /btw answer or cancellation arrives after /new, without an unhandled rejection", async () => {
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			const { host, chatContainer, text } = await setup();
			const release = streamAnswers("late answer");
			await handleWorkflowCommand(host, "btw", "first");
			await vi.waitFor(() => expect(release).toHaveLength(1));
			chatContainer.clear();
			release[0]();
			await vi.waitFor(() => expect(sideQuestionsFor(harness.session).snapshot().running).toBe(false));
			expect(chatContainer.children).toHaveLength(0);
			expect(text()).toBe("");

			await handleWorkflowCommand(host, "btw", "second");
			chatContainer.clear();
			clearSideQuestions(harness.session);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(chatContainer.children).toHaveLength(0);
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});

	it("clears the side thread with --clear", async () => {
		const { host, showStatus, text } = await setup();
		const release = streamAnswers("kept for now");
		await handleWorkflowCommand(host, "btw", "remember this");
		await vi.waitFor(() => expect(release).toHaveLength(1));
		release[0]();
		await vi.waitFor(() => expect(text()).toContain("kept for now"));
		await handleWorkflowCommand(host, "btw", "--clear");
		expect(showStatus).toHaveBeenCalledWith("Side thread cleared.");
		await handleWorkflowCommand(host, "btw", "");
		expect(text().match(/kept for now/g)).toHaveLength(1);
	});

	it("shows /diff progress, then replaces it with the changes", async () => {
		const { host, text, showCustomDialog } = await setup();
		let finish!: (value: Awaited<ReturnType<Harness["session"]["getRepositoryDiff"]>>) => void;
		vi.spyOn(harness.session, "getRepositoryDiff").mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const running = handleWorkflowCommand(host, "diff", "");
		expect(text()).toContain("Reading repository changes…");
		finish({ root: "/repo", staged: "", unstaged: "+changed line", untracked: [], truncated: false });
		await running;
		expect(text()).toContain("+changed line");
		expect(text()).not.toContain("Reading repository changes…");
		expect(showCustomDialog).not.toHaveBeenCalled();
	});

	it("reports a failed /diff in the chat", async () => {
		const { host, text } = await setup();
		vi.spyOn(harness.session, "getRepositoryDiff").mockRejectedValue(new Error("not a git repository"));
		await handleWorkflowCommand(host, "diff", "");
		expect(text()).toContain("not a git repository");
	});
});
