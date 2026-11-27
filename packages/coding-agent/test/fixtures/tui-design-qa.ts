import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TuiAltScreen, TuiMainScreen, visibleWidth } from "@octocodeai/octocode-tui";
import { buildQaScene, type QaConfig, qaId, QA_MATRIX } from "./tui-design-qa-scene.ts";
import { QaTerminal } from "../../../tui/test/helpers/capture-terminal.ts";

export async function captureQa(config: QaConfig) {
	const terminal = new QaTerminal(config.width);
	const ui = config.mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
	const scene = buildQaScene(config, ui);
	try {
		for (const component of scene.components) ui.addChild(component);
		if (ui instanceof TuiAltScreen) ui.setLayoutRoot(scene.layoutRoot);
		ui.start();
		for (let pass = 0; pass < 3; pass++) {
			await new Promise<void>((done) => setImmediate(done));
			ui.renderNow(true);
			await terminal.flush();
		}
		const snapshot = terminal.capture();
		const componentOverflow = scene.components.flatMap((component, index) => component.render(config.width).flatMap((line) => visibleWidth(line) > config.width ? [{ component: index, columns: visibleWidth(line) }] : []));
		return {
			id: qaId(config), ...config, synthetic: true, renderer: ui.constructor.name, rows: terminal.rows, cols: terminal.columns,
			foreground: config.theme === "light" ? 0 : 0xe5e5e7,
			background: config.theme === "light" ? 0xffffff : 0x101014,
			componentOverflow, ...snapshot,
		};
	} finally {
		scene.dispose();
		ui.stop();
		await terminal.flush();
		terminal.emulator.dispose();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const dirAt = args.indexOf("--capture-dir");
	if (dirAt < 0 || !args[dirAt + 1]) throw new Error("Usage: tui-design-qa.ts --capture-dir <directory>");
	const directory = resolve(args[dirAt + 1]);
	await mkdir(directory, { recursive: true });
	for (const config of QA_MATRIX) {
		const snapshot = await captureQa(config);
		await writeFile(resolve(directory, `${snapshot.id}.json`), JSON.stringify(snapshot));
	}
	await writeFile(resolve(directory, "index.json"), JSON.stringify({ synthetic: true, emulator: "@xterm/headless", configs: QA_MATRIX.map((config) => ({ id: qaId(config), ...config })) }, null, 2));
	process.stdout.write(`Captured ${QA_MATRIX.length} synthetic headless TUI permutations in ${directory}\n`);
}
