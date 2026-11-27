// Preloaded into a test's CLI process: a connection to a host that is not loopback is logged, then refused.
import fs from "node:fs";
import net from "node:net";

const log = process.env.OCTOCODE_TEST_NET_LOG;
const loopback = (host) =>
	host === undefined ||
	host === "" ||
	host === "localhost" ||
	host === "::1" ||
	host.startsWith("127.") ||
	/^\[?::ffff:127\./.test(host);

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const first = args[0];
	let host;
	if (Array.isArray(first)) host = first[0]?.host;
	else if (first && typeof first === "object") host = first.path ? undefined : (first.host ?? first.hostname);
	else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) host = args[1];
	// A string that is not a port is a unix socket path.
	if (!loopback(typeof host === "string" ? host : undefined)) {
		if (log) fs.appendFileSync(log, `${host}\n`);
		throw new Error(`test network guard: refused connection to ${host}`);
	}
	return original.apply(this, args);
};
