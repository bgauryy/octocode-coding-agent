// Preloaded into the agent process (NODE_OPTIONS=--import): once the flag file exists, Date runs one day ahead.
import { existsSync } from "node:fs";

const flag = process.env.TESTKIT_ROLLOVER_FLAG;
const Real = Date;
const offset = () => (flag && existsSync(flag) ? 86_400_000 : 0);
globalThis.Date = class extends Real {
	constructor(...args) {
		if (args.length === 0) super(Real.now() + offset());
		else super(...args);
	}
	static now() {
		return Real.now() + offset();
	}
};
