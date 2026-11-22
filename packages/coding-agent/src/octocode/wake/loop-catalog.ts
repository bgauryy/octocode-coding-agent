import type { EventCatalog } from "../events/loop/types.ts";
import { CATALOG, describeEvent } from "./catalog.ts";

/** The wake catalog as the loop reads it: digests and keys from the entries, wakes where an entry always wakes. */
export const wakeCatalog: EventCatalog = {
	describe: describeEvent,
	wakes: (topic) => CATALOG[topic].wakes === "yes",
};
