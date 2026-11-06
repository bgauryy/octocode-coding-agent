import net from "node:net";
import { type ConditionSpec, fields } from "./types.ts";

type Port = { kind: "port"; port: number; host: string };

/** A connect that has not answered by then counts as not listening. */
const CONNECT_TIMEOUT_MS = 1000;
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];

/** `port`: a TCP connect to a loopback port succeeds. Loopback only, so a timer cannot scan other hosts. No event source exists: it polls. */
export const portSpec: ConditionSpec<Port> = {
	kind: "port",
	parse(value) {
		const given = fields(value, "port", ["port", "host"]);
		const { port } = given;
		if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
			throw new Error("until.port.port must be a whole number from 1 to 65535.");
		const host = given.host === undefined ? "127.0.0.1" : given.host;
		if (typeof host !== "string" || !LOOPBACK.includes(host))
			throw new Error(`until.port.host is limited to loopback: ${LOOPBACK.join(", ")}.`);
		return { kind: "port", port, host };
	},
	encode: (condition) => JSON.stringify({ port: condition.port, host: condition.host }),
	decode(stored) {
		const { port, host } = JSON.parse(stored) as { port?: unknown; host?: unknown };
		return typeof port === "number" && typeof host === "string" ? { kind: "port", port, host } : undefined;
	},
	describe: (condition) => `port ${condition.port} is listening`,
	safetyMs: 5000,
	pollMs: 5000,
	check: (condition) =>
		new Promise((resolve) => {
			const socket = net.connect({ port: condition.port, host: condition.host });
			const done = (met: boolean, output: string) => {
				socket.destroy();
				resolve({ met, exit: null, output });
			};
			socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false, `${condition.host}:${condition.port} did not answer.`));
			socket.once("connect", () => done(true, `${condition.host}:${condition.port} accepts connections.`));
			socket.once("error", (error) => done(false, `${condition.host}:${condition.port}: ${error.message}`));
		}),
};
