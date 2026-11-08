#!/usr/bin/env node
import { shellCompletion } from "../shared/shell-completion.ts";
import { completeApi } from "./completion.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { redactData, redactSecrets } from "../../../../common/src/sanitize.ts";
import { API_COMMAND_FLAGS, integerFlag, parseArgs, pickInstance } from "./args.ts";
import { ApiCallError, ApiClient } from "./client.ts";
import { CLIENT_MARGIN_MS, EXTERNAL_CALL_MARGIN_MS, EXTERNAL_PROMPT_DEFAULT_MS, WAIT_MS } from "./protocol.ts";
import { runSucceeded, type RunResult } from "./receipts.ts";
import { EVENTS_LIMIT, eventsReport } from "./cli/events.ts";
import { probeInstances } from "./probe.ts";
import { apiDir, describeInstance, type InstanceRecord, listInstances } from "./registry.ts";

const USAGE = `octocode-api — talk to running Octocode sessions on this machine

  octocode-api completion <bash|zsh|fish>
  octocode-api list
  octocode-api status [--to <id>]
  octocode-api send [--to <id>] [--from <name>] [--wait] [--mode steer|followUp]
    [--key <key>] [--session <sessionId>] [--timeout <ms>] [--require-idle] [--] <text…>
  octocode-api watch [--to <id>] [--types a,b] [--top-level] [--since <sequence>]
  octocode-api events [--since <sequence>] [--limit <n>] [--json]
  octocode-api abort [--to <id>]
  octocode-api external [--to <id>] '<JSON>'

--to takes what list shows: an instance id, a process name, a session id or a pid. Without it: the only running
instance, or the one in the current directory.
A session marks what send delivers as external, naming the caller as a claim; --from adds a name to that claim.
--key deduplicates the same message within the current session; reuse it to retrieve its receipt.
--session refuses delivery after a session switch; --require-idle refuses a busy session.
--timeout sets the server wait in milliseconds (${WAIT_MS.min}-${WAIT_MS.max}; default ${WAIT_MS.default}).
-- ends flag parsing, so message text can begin with --.
events reads this directory's agent lifecycle events (on, state, off with the reason) after the sequence from the
agent database; no session needs to run. It prints the last sequence: pass it as --since to see only what is new.
--top-level drops tool events of calls other tools made (those with parentId).`;

/** The instance this run is talking to, for an error the transport reports without it. */
let target: InstanceRecord | undefined;

/** One line per instance: id, name, pid, state, session, cwd. */
async function listLines(instances: InstanceRecord[]): Promise<string[]> {
	return (await probeInstances(instances)).map(({ instance, state }) =>
		[instance.id, instance.name ?? "-", `pid ${instance.pid}`, state, instance.session ?? "-", instance.cwd].join("\t"),
	);
}

/**
 * Who is calling, as far as this process can tell. A session's shell carries its session id, and its instance record has
 * the rest; any other program is a pid and a folder. The receiver treats all of it as a claim.
 */
function callerOf(instances: readonly InstanceRecord[]): Record<string, unknown> {
	const session = process.env.OCTOCODE_SESSION_ID;
	const own = session ? instances.find((entry) => entry.session === session) : undefined;
	return own
		? { name: own.name, instanceId: own.id, pid: own.pid, cwd: own.cwd }
		: { pid: process.pid, cwd: process.cwd() };
}

async function main(argv: string[]): Promise<void> {
	if (argv[0] === "completion") {
		if (argv[1] === "--values") {
			const ids =
				argv.at(-2) === "--to"
					? listInstances(apiDir(), false).flatMap((instance) => [
							instance.id,
							...(instance.name ? [instance.name] : []),
						])
					: [];
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
	if (command === "events") {
		const { output, notice } = eventsReport({
			since: since ?? 0,
			limit: integerFlag(flags, "limit", EVENTS_LIMIT) ?? EVENTS_LIMIT.default,
			json: flags.get("json") === true,
			cwd: process.cwd(),
		});
		if (notice) console.error(notice);
		console.log(output);
		return;
	}
	const instances = listInstances(apiDir());
	if (command === "list") {
		for (const line of await listLines(instances)) console.log(line);
		return;
	}
	target = pickInstance(instances, flags.get("to") as string | undefined, process.cwd());
	const client = new ApiClient(target);
	// Reads are recorded and an abort is admitted naming the caller: a claim, which the receiver says it could not confirm.
	if (command === "status")
		console.log(JSON.stringify(await client.call("status", { caller: callerOf(instances) }), null, 2));
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
	} else if (command === "abort")
		console.log(JSON.stringify(await client.call("turn.abort", { caller: callerOf(instances) })));
	else if (command === "send") {
		const own = process.env.OCTOCODE_SESSION_ID;
		// A session's own run cannot answer a call its own tool is blocked on.
		if (own && target.session === own)
			throw new Error(`${describeInstance(target)} is this session; name another with --to.`);
		const result = await client.call<Partial<RunResult>>(
			"message.send",
			{
				text: words.join(" "),
				caller: callerOf(instances),
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
		if (!flags.get("wait")) console.log(JSON.stringify(result));
		else if (runSucceeded(result)) console.log(result.text ?? "");
		else {
			console.error(JSON.stringify(redactData(result)));
			process.exitCode = 1;
		}
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
			: redactSecrets(`${target ? `${describeInstance(target)} is not answering: ` : ""}${errorMessage(error)}`),
	);
	process.exitCode = 1;
});
