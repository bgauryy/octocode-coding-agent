/**
 * Fixture for the real-tmux passthrough test. Prints "READY", and on the first key writes the Kitty uploads the test
 * asks for through tmux's DCS passthrough, then prints "DONE". Env: UPLOAD_CHARS (base64 characters of one upload made
 * by the real `encodeKitty`), RAW_ENVELOPE_CHARS (a single hand-made envelope of that many payload characters, as a
 * writer without the size limit would send it).
 */
import { encodeKitty } from "../../src/terminal-image.ts";
import { setCapabilities } from "../../src/terminal-image/capabilities.ts";

setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true, kittyPlaceholders: true });
const upload = Number(process.env.UPLOAD_CHARS ?? 0);
const raw = Number(process.env.RAW_ENVELOPE_CHARS ?? 0);

process.stdin.setRawMode?.(true);
process.stdin.resume();
console.log("READY");
process.stdin.once("data", () => {
	if (upload > 0) process.stdout.write(encodeKitty("A".repeat(upload), { imageId: 1, virtual: true }));
	if (raw > 0) process.stdout.write(`\x1bPtmux;\x1b\x1b_Ga=T,i=2,m=0;${"B".repeat(raw)}\x1b\x1b\\\x1b\\`);
	process.stdout.write("\nDONE\n", () => process.exit(0));
});
