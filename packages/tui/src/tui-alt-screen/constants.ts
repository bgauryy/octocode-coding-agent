export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const EXIT_ALT_SCREEN = "\x1b[?1049l";
export const DISABLE_AUTOWRAP = "\x1b[?7l";
export const ENABLE_AUTOWRAP = "\x1b[?7h";
export const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1002h";
/** Clicks, the wheel and drags (button-motion tracking), focus reports and SGR coordinates. */
export const ENABLE_MOUSE = `\x1b[?1000h${ENABLE_BUTTON_MOTION_MOUSE}\x1b[?1004h\x1b[?1006h`;
/** Bare pointer movement, on top of `ENABLE_MOUSE`: only while something reacts to hover. */
export const ENABLE_ANY_MOTION_MOUSE = "\x1b[?1003h";
export const DISABLE_ANY_MOTION_MOUSE = "\x1b[?1003l";
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
export const PAGE_SCROLL_OVERLAP = 4;
export const ALT_WHEEL_SCROLL_MULTIPLIER = 5;
export const MAX_CACHED_OFFSCREEN_KITTY_IMAGES = 16;
export const MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES = 32 * 1024 * 1024;
export const MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES = 64 * 1024 * 1024;
export const DOUBLE_CLICK_INTERVAL_MS = 500;
export const COPY_ERROR_FLASH_DURATION_MS = 5000;
