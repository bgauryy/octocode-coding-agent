import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getModel } from "@octocodeai/octocode-ai/compat";
import { expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

it.each(["new", "empty-persisted", "restored", "explicit-fork"] as const)(
	"reports %s SDK startup from loaded session state",
	async (kind) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-start-reason-"));
		let manager = SessionManager.create(root, root);
		const seen: string[] = [];
		if (kind !== "new") {
			const file = manager.getSessionFile()!;
			fs.writeFileSync(file, JSON.stringify(manager.getHeader()) + "\n");
			manager = SessionManager.open(file);
			if (kind === "restored")
				manager.appendMessage({
					role: "user",
					content: "previous",
					timestamp: Date.now(),
				});
		}
		const settingsManager = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			nativeFeatures: false,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (event) => {
						seen.push(event.reason);
					});
				},
			],
		});
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			await loader.reload();
			({ session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				model: getModel("anthropic", "claude-sonnet-4-5"),
				sessionManager: manager,
				resourceLoader: loader,
				settingsManager,
				noTools: "all",
				...(kind === "explicit-fork"
					? {
							sessionStartEvent: {
								type: "session_start" as const,
								reason: "fork" as const,
							},
						}
					: {}),
			}));
			await session.bindExtensions({});
			expect(seen).toEqual([kind === "new" ? "startup" : kind === "explicit-fork" ? "fork" : "resume"]);
		} finally {
			session?.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);
