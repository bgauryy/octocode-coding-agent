import { describe, expect, it, vi } from "vitest";
import type { SessionUI, DialogOptions } from "../src/core/features/types.ts";
import { UIPromptTracker } from "../src/core/features/runner/ui-prompt.ts";

/** A mode whose dialogs resolve when the test says, and close (resolve undefined/false) when their signal aborts. */
function fakeUi() {
	const open: Array<{ kind: string; resolve: (value: unknown) => void; opts?: DialogOptions }> = [];
	const dialog = <T>(kind: string, opts: DialogOptions | undefined, closed: T) =>
		new Promise<T>((resolve) => {
			opts?.signal?.addEventListener("abort", () => resolve(closed), { once: true });
			open.push({ kind, resolve: resolve as (value: unknown) => void, opts });
		});
	const ui = {
		select: (_title: string, _options: string[], opts?: DialogOptions) =>
			dialog<string | undefined>("select", opts, undefined),
		confirm: (_title: string, _message: string, opts?: DialogOptions) => dialog<boolean>("confirm", opts, false),
		input: (_title: string, _placeholder?: string, opts?: DialogOptions) =>
			dialog<string | undefined>("input", opts, undefined),
		editor: () => dialog<string | undefined>("editor", undefined, undefined),
		custom: () => dialog<unknown>("custom", undefined, undefined),
	} as unknown as SessionUI;
	return { ui, open };
}

function tracker() {
	const events: Array<Record<string, unknown>> = [];
	const t = new UIPromptTracker(async (event) => {
		events.push(event as unknown as Record<string, unknown>);
	});
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
	return { t, events, flush };
}

describe("dialog broker", () => {
	it("shows each notice in the mode's UI, then reports it as ui_notice for other clients", async () => {
		const { t, events, flush } = tracker();
		const shown: string[] = [];
		const wrapped = t.wrap({ ...fakeUi().ui, notify: (message: string) => void shown.push(message) });
		wrapped.notify("Memory reflection: workspace MEMORY.md +1 −0 lines.");
		wrapped.notify("Hook configuration diagnostics: bad matcher", "warning");
		expect(shown).toHaveLength(2);
		await flush();
		expect(events).toEqual([
			{ type: "ui_notice", message: "Memory reflection: workspace MEMORY.md +1 −0 lines.", level: "info" },
			{ type: "ui_notice", message: "Hook configuration diagnostics: bad matcher", level: "warning" },
		]);
	});

	it("reports each dialog with an id and its options, and lets a remote answer close the mode's dialog", async () => {
		const { t, events, flush } = tracker();
		const { ui, open } = fakeUi();
		const wrapped = t.wrap(ui);
		const answer = wrapped.select("Run bash?", ["Allow once", "Deny"], {});
		await flush();
		expect(events[0]).toMatchObject({ type: "ui_prompt_start", kind: "select", options: ["Allow once", "Deny"] });
		const id = events[0].id as string;
		expect(id).toBeTruthy();
		expect(t.answer(id, { choice: "Maybe" })).toMatchObject({ ok: false });
		expect(t.answer(id, { choice: "Allow once" })).toEqual({ ok: true });
		expect(await answer).toBe("Allow once");
		expect(open[0].opts?.signal?.aborted).toBe(true);
		await flush();
		expect(events.at(-1)).toMatchObject({ type: "ui_prompt_end", id });
		expect(t.answer(id, { choice: "Deny" })).toMatchObject({ ok: false });
	});

	it("takes the terminal's answer first and refuses a later remote one; confirm and input map their answers", async () => {
		const { t, events, flush } = tracker();
		const { ui, open } = fakeUi();
		const wrapped = t.wrap(ui);
		const confirmed = wrapped.confirm("Delete?", "the build folder", {});
		await flush();
		expect(events[0]).toMatchObject({ kind: "confirm", options: ["Yes", "No"] });
		open[0].resolve(true);
		expect(await confirmed).toBe(true);
		expect(t.answer(events[0].id as string, { choice: "No" })).toMatchObject({ ok: false });

		const typed = wrapped.input("Branch name", "feature/x", {});
		await flush();
		const input = events.find((event) => event.kind === "input")!;
		expect(input).toMatchObject({ allowsText: true });
		expect(t.answer(input.id as string, { choice: "x" })).toMatchObject({ ok: false });
		expect(t.answer(input.id as string, { text: "feature/remote" })).toEqual({ ok: true });
		expect(await typed).toBe("feature/remote");
		const yes = wrapped.confirm("Again?", "", {});
		await flush();
		expect(t.answer(events.at(-1)!.id as string, { choice: "Yes" })).toEqual({ ok: true });
		expect(await yes).toBe(true);
	});

	it("reports a dialog opened over another as nested, and refuses remote answers for editor and custom dialogs", async () => {
		const { t, events, flush } = tracker();
		const { ui, open } = fakeUi();
		const wrapped = t.wrap(ui);
		const outer = wrapped.select("Pick", ["Type my own"], {});
		await flush();
		const inner = wrapped.input("Your answer", undefined, {});
		await flush();
		expect(events[0]).toMatchObject({ type: "ui_prompt_start", kind: "select" });
		expect(events[0].nested).toBeFalsy();
		expect(events[1]).toMatchObject({ type: "ui_prompt_start", kind: "input", nested: true });
		expect(t.answer(events[1].id as string, { text: "done" })).toEqual({ ok: true });
		expect(await inner).toBe("done");
		open[0].resolve("Type my own");
		expect(await outer).toBe("Type my own");
		const edited = wrapped.editor("Edit", "");
		await flush();
		expect(t.answer(events.at(-1)!.id as string, { text: "x" })).toMatchObject({ ok: false });
		open.at(-1)!.resolve("final");
		expect(await edited).toBe("final");
	});

	it("carries the blocking option into the start event; a select, confirm or input never claims to be an approval", async () => {
		const { t, events, flush } = tracker();
		const { ui } = fakeUi();
		const wrapped = t.wrap(ui);
		void wrapped.select("Run?", ["Allow once"], { blocking: true });
		void wrapped.confirm("Sure?", "");
		void wrapped.input("Why not?", undefined);
		void wrapped.select("Plain", ["a"], {});
		await flush();
		expect(events[0]).toMatchObject({ kind: "select", blocking: true });
		expect(events[0].approval).toBeUndefined();
		expect(events[1]).toMatchObject({ kind: "confirm" });
		expect(events[1].approval).toBeUndefined();
		expect(events[1].blocking).toBeUndefined();
		expect(events[2].approval).toBeUndefined();
		expect(events[3].approval).toBeUndefined();
		expect(events[3].blocking).toBeUndefined();
	});

	it("keeps the caller's own abort signal working", async () => {
		const { t, flush } = tracker();
		const { ui } = fakeUi();
		const controller = new AbortController();
		const answer = t.wrap(ui).select("Pick", ["a"], { signal: controller.signal });
		await flush();
		controller.abort();
		expect(await answer).toBeUndefined();
		expect(vi.fn()).toBeDefined();
	});
});
