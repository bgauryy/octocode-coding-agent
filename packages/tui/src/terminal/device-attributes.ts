/** Primary device attributes (DA1) request; every terminal answers it, in order with earlier queries. */
export const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";
/** Matches a DA1 reply such as `ESC [ ? 62 ; 22 c`. */
export const DEVICE_ATTRIBUTES_RESPONSE_PATTERN = /^\x1b\[\?[\d;]*c$/;
