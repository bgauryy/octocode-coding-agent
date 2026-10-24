// Stands in for `octocode auth <action> --json`: the JSON on stdout, the device prompt on stderr, as the native CLI writes them.
const [, , group, action, flag] = process.argv;
const mode = process.env.FAKE_OCTOCODE_AUTH ?? "ok";
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (group !== "auth" || flag !== "--json") {
	print({ error: `unexpected arguments: ${process.argv.slice(2).join(" ")}`, errorCode: "invalidInput" });
	process.exit(2);
}
if (mode === "error") {
	print({ error: "GitHub rejected the request", errorCode: "authentication" });
	process.exit(4);
}
if (mode === "text") {
	process.stderr.write("native crash\n");
	process.exit(1);
}
if (action === "status") {
	if (mode === "signed-out") {
		print({ authenticated: false, verification: "none", username: null, hostname: "github.com", tokenSource: "none" });
		process.exit(4);
	}
	print({ authenticated: true, verification: "verified", username: "octo", hostname: "github.com", tokenSource: mode === "env" ? "env:GITHUB_TOKEN" : "octocode-storage" });
} else if (action === "logout") {
	print({ loggedOut: true, hostname: "github.com", home: "/home/octo/.octocode" });
} else if (action === "login") {
	if (!process.stdin.isTTY && process.env.FAKE_OCTOCODE_REQUIRE_TTY === "1") {
		print({ error: "login requires an interactive terminal", errorCode: "invalidInput" });
		process.exit(2);
	}
	process.stderr.write("Open https://github.com/login/device and enter code ABCD-1234\n");
	process.on("SIGINT", () => {
		print({ error: "login cancelled", errorCode: "cancelled" });
		process.exit(130);
	});
	setTimeout(() => print({ success: true, action: "login", hostname: "github.com", username: "octo" }), mode === "slow" ? 60_000 : 20);
}
