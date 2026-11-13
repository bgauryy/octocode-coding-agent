import setup from "./vitest.tmp.global.ts";

/**
 * The isolation every Vitest run gets (`vitest.tmp.global.ts`), for `node --test` runs (`--test-global-setup`): the test
 * processes and every process they start inherit a temporary root and home, and the guard on the real agent database.
 */
let teardown: (() => Promise<void>) | undefined;

export function globalSetup(): void {
	teardown = setup();
}

export async function globalTeardown(): Promise<void> {
	await teardown?.();
}
