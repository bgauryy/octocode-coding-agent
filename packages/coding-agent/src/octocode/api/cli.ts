#!/usr/bin/env node
import { shellCompletion } from "../shared/shell-completion.ts";
import { completeApi } from "./completion.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { redactData, redactSecrets } from "../shared/sanitize.ts";
import { API_COMMAND_FLAGS, integerFlag, parseArgs, pickInstance } from "./args.ts";
import { ApiCallError, ApiClient } from "./client.ts";
import { CLIENT_MARGIN_MS, EXTERNAL_CALL_MARGIN_MS, EXTERNAL_PROMPT_DEFAULT_MS, WAIT_MS } from "./protocol.ts";
import { apiDir, listInstances } from "./registry.ts";

const USAGE = `octocode-api — talk to running Octocode sessions (start them with OCTOCODE_API=1)

  octocode-api completion <bash|zsh|fish>
  octocode-api list
  octocode-api status [--to <id>]
  octocode-api send [--to <id>] [--from <name>] [--wait] [--mode steer|followUp]
    [--key <key>] [--session <sessionId>] [--timeout <ms>] [--require-idle] [--] <text…>
  octocode-api watch [--to <id>] [--types a,b] [--top-level] [--since <sequence>]
  octocode-api abort [--to <id>]
  octocode-api external [--to <id>] '<JSON>'

--to defaults to the only running instance (or the one in the current directory).
--key deduplicates the same message within the current session; reuse it to retrieve its receipt.
--session refuses delivery after a session switch; --require-idle refuses a busy session.
--timeout sets the server wait in milliseconds (${WAIT_MS.min}-${WAIT_MS.max}; default ${WAIT_MS.default}).
-- ends flag parsing, so message text can begin with --.
--top-level drops tool events of calls other tools made (those with parentId).`;

async function main(argv: string[]): Promise<void> {
	if (argv[0] === "completion") {
		if (argv[1] === "--values") {
			const ids = argv.at(-2) === "--to" ? listInstances(apiDir(), false).map((instance) => instance.id) : [];
			const values = completeApi(argv.slice(2), ids);
			if (values.length) process.stdout.write(values.join("\n") + "\n");
		} else if (argv.length === 2 && ["bash", "zsh", "fish"].includes(argv[1])) {
			process.stdout.write(shellCompletion(argv[1] as "bash" | "zsh" | "fish", "octocode-api"));
		} else {
			console.log("Usage: octocode-api completion <bash|zsh|fish>");
			if (argv.length > 1 && !["--help", "-h"].includes(argv[1])) process.exitCode = 1;
		}
		return;
	}
	const [command, ...rest] = argv;
	if (!command || ["--help", "-h"].includes(command) || (rest.length === 1 && rest[0] === "--help")) {
		console.log(USAGE);
		return;
	}
	if (!Object.hasOwn(API_COMMAND_FLAGS, command)) {
		console.log(USAGE);
		process.exitCode = 1;
		return;
	}
	const { flags, words } = parseArgs(rest, command);
	if (!["send", "external"].includes(command) && words.length)
		throw new Error(`${command} does not accept message text.`);
	const timeout = integerFlag(flags, "timeout", WAIT_MS);
	const since = integerFlag(flags, "since", { min: 0, max: Number.MAX_SAFE_INTEGER });
	const instances = listInstances(apiDir());
	if (command === "list") {
		for (const entry of instances) console.log(`${entry.id}\tpid ${entry.pid}\t${entry.cwd}`);
		return;
	}
	const client = new ApiClient(pickInstance(instances, flags.get("to") as string | undefined, process.cwd()));
	if (command === "status") console.log(JSON.stringify(await client.call("status"), null, 2));
	else if (command === "external") {
		const input: unknown = JSON.parse(words.join(" "));
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error("external requires one JSON object");
		const timeout = (input as Record<string, unknown>).timeoutMs;
		const timeoutMs =
			typeof timeout === "number"
				? timeout + EXTERNAL_CALL_MARGIN_MS
				: EXTERNAL_PROMPT_DEFAULT_MS + EXTERNAL_CALL_MARGIN_MS;
		console.log(
			JSON.stringify(await client.call("external.call", input as Record<string, unknown>, { timeoutMs }), null, 2),
		);
	} else if (command === "abort") console.log(JSON.stringify(await client.call("turn.abort")));
	else if (command === "send") {
		const result = await client.call<{ text?: string }>(
			"message.send",
			{
				text: words.join(" "),
				...(flags.has("from") ? { from: flags.get("from") } : {}),
				...(flags.has("mode") ? { mode: flags.get("mode") } : {}),
				...(flags.has("key") ? { key: flags.get("key") } : {}),
				...(flags.has("session") ? { expectedSessionId: flags.get("session") } : {}),
				...(timeout !== undefined ? { timeoutMs: timeout } : {}),
				...(flags.get("require-idle") ? { requireIdle: true } : {}),
				...(flags.get("wait") ? { wait: true } : {}),
			},
			{ timeoutMs: (timeout ?? WAIT_MS.default) + CLIENT_MARGIN_MS.default },
		);
		console.log(flags.get("wait") ? (result.text ?? "") : JSON.stringify(result));
	} else {
		const types = typeof flags.get("types") === "string" ? (flags.get("types") as string).split(",") : undefined;
		await client.watch((event) => console.log(JSON.stringify(event)), {
			...(since !== undefined ? { since } : {}),
			...(types ? { types } : {}),
			...(flags.get("top-level") ? { topLevel: true } : {}),
			onSubscribed: ({ seq, gap }) => {
				if (gap)
					console.error(
						JSON.stringify({ warning: "Event replay has a gap; older events are no longer retained.", since, seq }),
					);
			},
		});
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	const execution = isRecord(error) && typeof error.execution === "string" ? error.execution : undefined;
	console.error(
		error instanceof ApiCallError || execution
			? JSON.stringify(
					redactData({
						error: errorMessage(error),
						...(error instanceof ApiCallError ? { code: error.code, data: error.data } : {}),
						...(execution ? { execution } : {}),
					}),
				)
			: redactSecrets(errorMessage(error)),
	);
	process.exitCode = 1;
});
