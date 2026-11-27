import type { IncomingMessage } from "node:http";
import { readJsonBody } from "../shared/json-body.ts";
import type { Reply } from "./http-util.ts";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
	ProviderTestCommandSchema,
	ProviderTestReportSchema,
	type ProviderTestCommand,
	type ProviderTestReport,
} from "@octocodeai/octocode-contracts/config";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { testAll, testProvider } from "../subagents/provider-test.ts";
import { ConfigWriteError } from "./config-write.ts";

export interface ProviderTestOptions {
	agentDir: string;
	env?: NodeJS.ProcessEnv;
	/** The network boundary a test fakes; default: the global `fetch`. */
	fetch?: typeof fetch;
}

/** One test takes at most this long; a hung host answers as a failure rather than holding the page. */
const TEST_MS = 120_000;

/** The answer is a `ProviderTestReport`: results and redacted error text, never a key. Only a launch link may press it. */
export async function handleProviderTest(
	req: IncomingMessage,
	writable: boolean,
	run: ((command: ProviderTestCommand) => Promise<ProviderTestReport>) | undefined,
	reply: Reply,
): Promise<void> {
	if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
	if (!writable)
		return reply(403, { error: "This link cannot test providers. Use the page opened from the Octocode terminal." });
	if (!run) return reply(501, { error: "This daemon cannot test providers." });
	const body = await readJsonBody(req, reply);
	if (body === undefined) return;
	if (!Value.Check(ProviderTestCommandSchema, body)) return reply(400, { error: "Invalid provider test" });
	try {
		reply(200, await run(body));
	} catch (error) {
		if (error instanceof ConfigWriteError) return reply(error.status, { error: error.message });
		reply(500, { error: "The test could not be run." });
	}
}

/**
 * Tests one connected provider, or every connected provider and external agent when none is named. Runs only when the
 * page presses the button: each provider costs at most one small request. A read-only runtime reads the same
 * credentials the terminal does; nothing is written and no key is returned.
 */
export async function runProviderTest(
	command: ProviderTestCommand,
	options: ProviderTestOptions,
): Promise<ProviderTestReport> {
	const runtime = await ModelRuntime.create({
		authPath: join(options.agentDir, "auth.json"),
		modelsPath: join(options.agentDir, "models.json"),
		allowModelNetwork: false,
		readOnlyCredentials: true,
	});
	try {
		const signal = AbortSignal.timeout(TEST_MS);
		const host = { runtime, fetch: options.fetch };
		let results;
		if (command.provider) {
			const provider = runtime.getProvider(command.provider);
			if (!provider) throw new ConfigWriteError(404, "Unknown provider.", "unknown");
			if (!runtime.hasConfiguredAuth(provider.id))
				throw new ConfigWriteError(409, `${provider.name ?? provider.id} is not connected.`, "not-connected");
			results = [await testProvider(host, provider.id, provider.name ?? provider.id, signal)];
		} else {
			results = await testAll(host, { signal, env: options.env, agentDir: options.agentDir });
		}
		const report = { results };
		if (!Value.Check(ProviderTestReportSchema, report)) throw new Error("The test report is invalid.");
		return report;
	} finally {
		runtime.dispose();
	}
}
