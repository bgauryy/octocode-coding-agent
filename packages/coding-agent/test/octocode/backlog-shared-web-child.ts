import { createServer } from "node:http";
import fs from "node:fs";

const outputFile = process.env.SHARED_WEB_OUTPUT;
if (!outputFile) {
	process.stderr.write("SHARED_WEB_OUTPUT is required\n");
	process.exit(1);
}

const token = "cross-process";
const server = createServer((req, res) => {
	const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
	if (req.url === "/api/backlogs" && req.method === "GET" && auth === token) {
		res.writeHead(200, { "content-type": "application/json" }).end("{}");
	} else {
		res.writeHead(401).end();
	}
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address() as { port: number };
	const url = `http://127.0.0.1:${address.port}/#access=${token}`;
	fs.writeFileSync(outputFile, JSON.stringify({ url, pid: process.pid }));
	if (process.send) process.send("ready");
});

process.on("message", (message: unknown) => {
	if (message === "close") {
		server.closeAllConnections();
		server.close(() => process.exit(0));
	}
});
