/** @vitest-environment jsdom */
import type { ConfigSnapshot } from "@octocodeai/octocode-contracts/config";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonShell } from "../src/app/daemon/DaemonShell.tsx";
import { daemonLive } from "../src/app/daemon/live.ts";
import { live } from "../src/app/live/index.ts";

const sessions = {
	sessions: [
		{
			id: "sess one",
			repoId: "r1",
			repoName: "octo-repo",
			cwd: "/work/octo",
			startedAt: Date.now() - 60_000,
			attached: true,
		},
		{
			id: "blocked",
			repoId: "r1",
			repoName: "octo-repo",
			cwd: "/work/blocked",
			startedAt: Date.now() - 30_000,
			attached: true,
			busy: true,
			needsYou: "Run rm -rf build?",
		},
		{
			id: "working",
			repoId: "r1",
			repoName: "octo-repo",
			cwd: "/work/working",
			startedAt: Date.now() - 10_000,
			attached: true,
			busy: true,
		},
	],
};
const repos = {
	repos: [
		{ id: "r1", name: "octo-repo", sessions: 1, hasReports: true },
		{ id: "r2", name: "idle-repo", sessions: 0, hasReports: false },
	],
};
const config: ConfigSnapshot = {
	protocolVersion: 1,
	generatedAt: Date.now(),
	keychainAvailable: true,
	providers: [{ provider: "openai", name: "OpenAI", configured: true, sources: [{ kind: "keychain" }] }],
	settings: [],
};

let requests: Array<{ url: string; auth: string | undefined }>;
beforeEach(() => {
	requests = [];
	location.hash = "";
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			requests.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
			const body =
				url === "/api/sessions" ? sessions : url === "/api/repos" ? repos : url === "/api/config" ? config : {};
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("DaemonShell", () => {
	it("lists live sessions with a link that opens that session's own live view", async () => {
		render(<DaemonShell access="tok" />);
		const links = await screen.findAllByRole("link", { name: "Open session" });
		expect(links[0]).toHaveAttribute("href", "/?s=sess%20one#activity");
		expect(screen.getAllByText("octo-repo")).toHaveLength(3);
		expect(screen.getByText("/work/octo")).toBeInTheDocument();
		// Each session says what it is doing; a blocked one shows the question it waits on.
		expect(screen.getByText("Live")).toBeInTheDocument();
		expect(screen.getByText("Needs you")).toBeInTheDocument();
		expect(screen.getByText("Run rm -rf build?")).toBeInTheDocument();
		expect(screen.getByText("Working")).toBeInTheDocument();
		expect(requests.every((request) => request.auth === "Bearer tok")).toBe(true);
	});

	it("shows each repository's read-only board and its reports when it has any", async () => {
		location.hash = "#repos";
		render(<DaemonShell access="tok" />);
		const first = (await screen.findByText("octo-repo")).closest("li")!;
		expect(within(first).getByRole("link", { name: "Board" })).toHaveAttribute("href", "/?r=r1#board");
		expect(within(first).getByRole("link", { name: "Reports" })).toHaveAttribute("href", "/?r=r1#rfc");
		const idle = screen.getByText("idle-repo").closest("li")!;
		expect(within(idle).queryByRole("link", { name: "Reports" })).toBeNull();
	});

	it("mounts the read-only Settings view from the daemon's configuration route", async () => {
		location.hash = "#settings";
		render(<DaemonShell access="tok" />);
		expect(await screen.findByText("OpenAI")).toBeInTheDocument();
		await waitFor(() => expect(requests.some((request) => request.url === "/api/config")).toBe(true));
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("shows a session that needs a restart, and says when a list was cut short", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const body =
					url === "/api/sessions"
						? {
								sessions: [],
								unavailable: [
									{
										id: "old",
										repoName: "old-repo",
										cwd: "/work/old",
										message: "This session uses an older Octocode; restart it to connect it to the web workspace.",
									},
								],
							}
						: { repos: [{ id: "r1", name: "octo-repo", sessions: 0, hasReports: false }], truncated: true };
				return new Response(JSON.stringify(body), { status: 200 });
			}),
		);
		render(<DaemonShell access="tok" />);
		expect(await screen.findByText(/restart it to connect/)).toBeInTheDocument();
		expect(screen.getByText("Not connected")).toBeInTheDocument();
		location.hash = "#repos";
		render(<DaemonShell access="tok" />);
		expect(await screen.findByText(/Showing the first 1 repositories/)).toBeInTheDocument();
	});

	it("says what to do when no session is attached, and reports a failed list", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ sessions: [], repos: [] }), { status: 200 })),
		);
		render(<DaemonShell access="tok" />);
		expect(await screen.findByText(/No live sessions/)).toBeInTheDocument();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ error: "Reopen /web" }), { status: 401 })),
		);
		location.hash = "#repos";
		render(<DaemonShell access="bad" />);
		expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
	});
});

describe("daemonLive", () => {
	it("keeps the session's views and, for a repository, only the views that read saved data", () => {
		if (!live) throw new Error("live extension");
		expect(daemonLive(live, { kind: "session", id: "s" }).views).toBe(live.views);
		expect(daemonLive(live, { kind: "repo", id: "r" }).views.map((view) => view.name)).toEqual([
			"rfc",
			"research",
			"audit",
		]);
	});
});
