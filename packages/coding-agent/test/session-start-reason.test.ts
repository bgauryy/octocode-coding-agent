import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createTestSession } from "./helpers/session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { testFeatures } from "./helpers/features.ts";

it.each(["new", "empty-persisted", "restored", "explicit-fork"] as const)(
	"reports %s session startup from loaded session state",
	async (kind) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-reason-"));
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
			disabledFeatures: ["mcp"],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			settingsManager,
			features: testFeatures([
				(api) => {
					api.bus.on("session_start", (event) => {
						seen.push(event.reason);
					});
				},
			]),
		});
		let session: Awaited<ReturnType<typeof createTestSession>>["session"] | undefined;
		try {
			await loader.reload();
			({ session } = await createTestSession({
				cwd: root,
				agentDir: root,
				model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
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
			await session.bindFeatures({});
			expect(seen).toEqual([kind === "new" ? "startup" : kind === "explicit-fork" ? "fork" : "resume"]);
		} finally {
			session?.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);
