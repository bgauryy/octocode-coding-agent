/**
 * Preloaded into every test file's process (`--import`, see the package's `test` script): the terminal identity and
 * locale tests run under, so a developer's own terminal, multiplexer or locale cannot change what they assert. A test
 * about one terminal sets its variables itself.
 */
const TERMINAL_IDENTITY = [
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMUX",
	"TMUX_PANE",
	"STY",
	"ZELLIJ",
	"KITTY_WINDOW_ID",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"LC_ALL",
	"LC_CTYPE",
];

for (const name of TERMINAL_IDENTITY) delete process.env[name];
process.env.TERM = "xterm-256color";
process.env.LANG = "en_US.UTF-8";
