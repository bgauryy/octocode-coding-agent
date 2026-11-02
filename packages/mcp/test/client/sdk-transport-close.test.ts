import { expect, it, vi } from "vitest";
import { SdkTransportAdapter } from "../../src/client/client/sdk-transport.ts";
import { TransportEvents } from "../../src/client/transports/transport.ts";

it("makes every concurrent close wait for transport shutdown and stderr drainage", async () => {
	let drain!: () => void;
	const drained = new Promise<void>((resolve) => {
		drain = resolve;
	});
	class DelayedTransport extends TransportEvents {
		start = async () => {};
		send = async () => {};
		close = vi.fn(() => drained);
	}
	const transport = new DelayedTransport();
	const adapter = new SdkTransportAdapter(transport, () => {});
	const first = adapter.close();
	let settled = false;
	const second = adapter.close().then(() => {
		settled = true;
	});
	try {
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(transport.close).toHaveBeenCalledTimes(1);
	} finally {
		drain();
		await Promise.all([first, second]);
	}
	expect(settled).toBe(true);
});
