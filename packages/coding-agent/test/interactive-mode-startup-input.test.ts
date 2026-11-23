import { describe, expect, it, vi } from "vitest";
import {
	handleStartupSubmit,
	setupEditorSubmitHandler,
} from "../src/modes/interactive/interactive-mode/command-dispatch.ts";
import { getUserInput } from "../src/modes/interactive/interactive-mode/input-handlers.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { selectSubmittedInputs } from "../src/modes/interactive/state/input-slice.ts";
import { createUiStore, type UiStore } from "../src/modes/interactive/state/store.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	showWorkingStatusIndicator: () => void;
	uiStore: UiStore;
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		showWorkingStatusIndicator: vi.fn(),
		uiStore: createUiStore(),
	};
}

describe("InteractiveMode startup input", () => {
	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		};

		handleStartupSubmit(createFakeHost(context), "early prompt");

		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("Sends when startup finishes"));
		expect(context.showStatus).not.toHaveBeenCalledWith(expect.stringMatching(/escape/));
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		setupEditorSubmitHandler(createFakeHost(context));

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(selectSubmittedInputs(context.uiStore.getState())).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
		expect(context.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
	});

	it("returns queued startup input before waiting for the next submit", async () => {
		const uiStore = createUiStore({ input: { submitted: ["queued prompt"] } });
		const listeners = vi.spyOn(uiStore, "subscribe");

		await expect(getUserInput(createFakeHost({ uiStore }))).resolves.toBe("queued prompt");
		expect(listeners).not.toHaveBeenCalled();
		expect(selectSubmittedInputs(uiStore.getState())).toEqual([]);
	});

	it("waits for the next submit when nothing is queued, and takes only that one", async () => {
		const uiStore = createUiStore();
		const next = getUserInput(createFakeHost({ uiStore }));

		uiStore.getState().submitInput("first");
		uiStore.getState().submitInput("second");

		await expect(next).resolves.toBe("first");
		expect(selectSubmittedInputs(uiStore.getState())).toEqual(["second"]);
	});
});
