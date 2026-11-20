import { createEventBus } from "@octocodeai/octocode-agent-core";
import { APPLICATION_NOTICE_REPEAT_MS, type ApplicationFrame } from "@octocodeai/octocode-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { USER_NOTICE_CHANNEL } from "../../src/octocode/shared/user-notice.ts";
import { registerWebNotices } from "../../src/octocode/ui/web-notices.ts";
import { AttachClient } from "../../src/octocode/web-daemon/attach-client.ts";
import { startAttachServer } from "../../src/octocode/web-daemon/attach-server.ts";
import { attachRecordPath } from "../../src/octocode/web-daemon/paths.ts";
import { readAttachRecord } from "../../src/octocode/web-daemon/records.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { fakeSession, isolatedEnv } from "./web-daemon-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
	vi.useRealTimers();
});

/** A port over a session with no transcript; `fakeCtx` answers every session lookup with the id "session-test". */
function setup() {
	const session = {
		sessionId: "session-test",
		messages: [],
		isStreaming: false,
		subscribe: () => () => undefined,
	} as unknown as AgentSession;
	const service = getApplicationPort(session);
	cleanup.push(() => service.dispose());
	const fake = fakeHost();
	const channels = createEventBus();
	Object.assign(fake.api, { channels });
	const notices: unknown[] = [];
	channels.on(USER_NOTICE_CHANNEL, (notice) => notices.push(notice));
	registerWebNotices(fake.api);
	const notes = () => (service.getSnapshot().activities ?? []).filter((activity) => activity.kind === "notice");
	return { service, fake, notices, notes, ctx: fakeCtx({ cwd: "/x" }) };
}

describe("web notices", () => {
	it("repeats each UI notice as a live activity, once within the repeat window", async () => {
		vi.useFakeTimers();
		const { fake, notes, ctx } = setup();
		await fake.emit(
			"ui_notice",
			{ message: "Memory reflection: workspace MEMORY.md +1 −0 lines.", level: "info" },
			ctx,
		);
		await fake.emit(
			"ui_notice",
			{ message: "Memory reflection: workspace MEMORY.md +1 −0 lines.", level: "info" },
			ctx,
		);
		await fake.emit("ui_notice", { message: "Hook configuration diagnostics: bad matcher", level: "error" }, ctx);
		expect(notes()).toEqual([
			expect.objectContaining({
				kind: "notice",
				source: "live",
				text: "Memory reflection: workspace MEMORY.md +1 −0 lines.",
				data: { level: "info" },
			}),
			expect.objectContaining({ text: "Hook configuration diagnostics: bad matcher", outcome: "failed" }),
		]);
		expect(notes()[0]).not.toHaveProperty("entryId");
		vi.advanceTimersByTime(APPLICATION_NOTICE_REPEAT_MS);
		await fake.emit(
			"ui_notice",
			{ message: "Memory reflection: workspace MEMORY.md +1 −0 lines.", level: "info" },
			ctx,
		);
		expect(notes()).toHaveLength(3);
	});

	it("announces a quiet model request as model_stalled and lists it in the web view", async () => {
		const { fake, notes, notices } = setup();
		const ctx = { ...fakeCtx({ cwd: "/x" }), model: { provider: "faux", id: "model" } };
		await fake.emit("model_stall", { idleMs: 21_000 }, ctx);
		const message = "Model not answering for 21s (faux/model)";
		expect(notices).toEqual([{ type: "model_stalled", title: "Octocode: model not answering", message }]);
		expect(notes()).toEqual([expect.objectContaining({ text: message, data: { level: "warning" } })]);
	});

	it("streams a notice to an attached daemon as a session.activity event", async () => {
		const { service, fake, ctx } = setup();
		const { env } = isolatedEnv();
		const workspace = { ...fakeSession("session-test").workspace, application: service };
		const server = await startAttachServer(
			{ sessionId: "session-test", cwd: "/x", repo: { key: "/x/.git", name: "x", root: "/x" }, workspace },
			env,
		);
		cleanup.push(() => server.close());
		const client = await AttachClient.connect(readAttachRecord(attachRecordPath(env, "session-test"))!);
		cleanup.push(() => client.close());
		const reader = client.application.connect({ sessionId: "session-test" })[Symbol.asyncIterator]();
		expect((await reader.next()).value).toMatchObject({ type: "snapshot" });
		await fake.emit("ui_notice", { message: "Cache warmed: $0.02", level: "info" }, ctx);
		const next = (await reader.next()).value as ApplicationFrame;
		expect(next).toMatchObject({
			type: "event",
			event: {
				type: "session.activity",
				activity: { kind: "notice", source: "live", text: "Cache warmed: $0.02", data: { level: "info" } },
			},
		});
	});
});
