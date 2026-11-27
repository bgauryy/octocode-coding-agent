// Scripted stand-in for `octocode --mode rpc` whose failures quote a credential, for subagent-secret-redaction.test.ts.
// The scenario is the task text: `split stderr`, `startup key` or `failed turn`. KEY comes from OCTOCODE_TEST_KEY.
const KEY = process.env.OCTOCODE_TEST_KEY;
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (text, extra = {}) => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }], usage, stopReason: "stop", ...extra },
});
const notify = (id, notifyType, message) =>
	emit({ type: "extension_ui_request", id, method: "notify", message, notifyType });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let task;
let buffered = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => {
	buffered += chunk;
	const at = buffered.indexOf("\n");
	if (task !== undefined || at < 0) return;
	const command = JSON.parse(buffered.slice(0, at));
	if (command.type !== "prompt") return;
	task = command.message;
	void run();
});
process.stdin.on("end", () => process.exit(0));

async function run() {
	if (task.startsWith("startup key")) {
		process.stderr.write(`Error: No API key. The provider rejected ${KEY}\n`);
		process.exit(2);
	}
	emit({ type: "response", command: "prompt", success: true, data: { disposition: "started" } });
	emit({ type: "agent_start" });
	emit({ type: "message_end", message: { role: "user", content: task } });
	if (task.startsWith("split stderr")) {
		emit(assistant("Reading the logs", { stopReason: "toolUse" }));
		process.stderr.write(`Error: 401 first echo ${KEY}\n`);
		for (let n = 1; n <= 300; n++) process.stderr.write(`diagnostic line ${n} of the noisy child\n`);
		process.stderr.write(`Error: 401 second echo ${KEY.slice(0, 14)}`);
		await sleep(50);
		process.stderr.write(`${KEY.slice(14)} end\n`);
		await sleep(50);
		process.exit(3);
	}
	notify("e", "error", `provider said: Incorrect API key provided: ${KEY}`);
	for (let n = 1; n <= 6; n++) notify(`w${n}`, "warning", `warning ${n} quoting ${KEY}`);
	emit(assistant("", { stopReason: "error", errorMessage: `401 rejected ${KEY}` }));
	emit({ type: "agent_settled" });
}
