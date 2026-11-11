import { appendFileSync } from "node:fs";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

// A scripted peer: argv is a journal path and a JSON object of behaviors.
const [journal, json] = process.argv.slice(2);
const options = JSON.parse(json);
const record = (event, params) => appendFileSync(journal, `${JSON.stringify({ event, params })}\n`);
let authenticated = false;
// Which of the named variables this peer was started with (names only), so a test can see what its host passed.
if (options.recordEnv) record("env", { present: options.recordEnv.filter((name) => name in process.env) });
const needsAuth = () => {
	if (options.authMethods && !authenticated) throw new RequestError(-32000, "Authentication required");
};
const app = agent({ name: "capability-peer" })
	.onRequest(methods.agent.initialize, async () => ({
		protocolVersion: PROTOCOL_VERSION,
		authMethods: options.authMethods ?? [],
		agentCapabilities: { loadSession: true, sessionCapabilities: options.capabilities ?? {} },
	}))
	.onRequest(methods.agent.authenticate, async ({ params }) => {
		record("authenticate", params);
		authenticated = true;
		return {};
	})
	.onRequest(methods.agent.session.new, async ({ params }) => {
		record("new", params);
		needsAuth();
		return { sessionId: "peer-session" };
	})
	.onRequest(methods.agent.session.load, async ({ params }) => {
		record("load", params);
		return {};
	})
	.onRequest(methods.agent.session.resume, async ({ params }) => {
		record("resume", params);
		return {};
	})
	.onRequest(methods.agent.session.close, async ({ params }) => {
		record("close", params);
		return {};
	});
app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
setInterval(() => undefined, 1000);
