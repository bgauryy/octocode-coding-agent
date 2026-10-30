# Running Octocode inside tmux

Octocode detects tmux from the `TMUX` variable and adapts keyboard, mouse, links, notifications, images and redraws. Most of
it works with tmux defaults; a few tmux options unlock the rest. Octocode only reads your tmux options (it asks tmux for
`extended-keys`, `allow-passthrough`, client terminal name and features, and attached clients) and never changes them.

## Recommended tmux settings

Add these to `~/.tmux.conf`, then run `tmux source-file ~/.tmux.conf` (or restart tmux):

```tmux
set -g extended-keys on          # modified keys such as Shift+Enter reach Octocode
set -g allow-passthrough on      # notifications and Kitty images reach the outer terminal (`all`: also from hidden windows)
set -g focus-events on           # "answer ready" notifications know when you are away; images return after attach
set -as terminal-features ',*:hyperlinks'  # clickable links (tmux 3.4+)
set -as terminal-features ',*:RGB'         # 24-bit colour, needed for images
```

Octocode warns at startup when `extended-keys` is off. tmux 3.3 and later default `allow-passthrough` to `off`.

## What you get

| Feature                    | What you get inside tmux                                                                                                                                                              | What to set                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Detection                  | Octocode switches on the tmux behaviour below when `TMUX` is set. Checks that ask tmux about the client (links, images, notifications) also need the `tmux` command on `PATH`.        | nothing                                          |
| Shift+Enter, modified keys | Shift+Enter and other modified keys reach Octocode. At startup Octocode warns when `tmux show -gv extended-keys` is neither `on` nor `always`.                                        | `extended-keys on`                               |
| Multi-line paste           | Pasted text keeps its lines. Control keys that tmux re-encodes inside a paste (`ESC[27;5;106~` or `ESC[106;5u`) become the control byte again, in both `extended-keys-format` styles. | nothing                                          |
| Mouse                      | In fullscreen mode (the default) tracking covers clicks, wheel, selection and drags, but not bare pointer movement, so tmux is not flooded with events.                               | nothing                                          |
| Clickable links            | Links are clickable when tmux reports `hyperlinks` in `#{client_termfeatures}`; otherwise they print as `text (url)`. `OCTOCODE_HYPERLINKS=1` or `0` overrides the check.             | `terminal-features` hyperlinks                   |
| "Answer ready" notices     | A desktop notification when a run finishes or the agent asks you something while you are away; see [Notifications](#notifications).                                                   | `allow-passthrough on`, `focus-events on`        |
| Images                     | Kitty images in Kitty and Ghostty; see [Images](#images).                                                                                                                             | `allow-passthrough on`, `RGB`, `focus-events on` |
| Long redraws               | A resize or redraw of a long history renews synchronized output, so tmux does not show a half-drawn screen after its one-second limit.                                                | nothing                                          |
| Fork into a pane           | `/fork pane`, `/fork pane down` and `/fork window`; see [Open a fork](#open-a-fork-in-a-pane-or-window).                                                                              | a tmux session                                   |

## Notifications

Octocode sends a notification when an answer is ready, a run fails, or the agent opens a question or permission dialog.

- **When:** by default only while you are away. With `focus-events on` tmux reports when the pane loses focus; without focus
  reports Octocode treats a run of 30 seconds or more with no keypress as away. `OCTOCODE_NOTIFY=always` notifies every time
  and `OCTOCODE_NOTIFY=off` turns notifications off.
- **Method:** chosen from the terminal attached to tmux, not from the pane's own variables: Kitty uses OSC 99, iTerm2 OSC 9, and
  Ghostty and WezTerm OSC 777. Any other terminal gets a bell. `OCTOCODE_NOTIFY_METHOD` (`osc9`, `osc777`, `osc99` or `bel`)
  overrides the choice.
- **Passthrough:** the notification travels in tmux passthrough, and only when the pane allows it (`on` or `all`; Octocode checks
  with `tmux show-options`). With passthrough off, only the bell is sent, because tmux drops a bare notification sequence. A bell
  also follows every notification in the same write, so a dropped one still flags the pane.
- **Late attach:** a session started detached has no terminal to ask yet; Octocode looks the terminal up when a notification is
  due, so it finds the client that attaches later. It remembers the first answer, so set `OCTOCODE_NOTIFY_METHOD` if you
  attach from a different terminal afterwards.

Variables are listed in [environment variables](environment-variables.md).

## Open a fork in a pane or window

After the conversation has at least one message:

- `/fork pane` splits the current pane to the right and runs a fork of this session there.
- `/fork pane down` splits downward; `/fork window` opens a new tmux window.
- The current session keeps running. Outside tmux the command reports an error and starts nothing.
- The [native feature guide](native-features.md#opening-a-fork-in-a-tmux-pane-or-window) owns the launch details.

When you type the command, the first Enter may only accept the autocomplete suggestion; press Enter again to run it.

## Images

Octocode draws Kitty images inside tmux as Unicode placeholder cells, which tmux stores and redraws like text. The image data
goes to your terminal through tmux passthrough. Automatic detection turns this on only when all of these hold:

1. the attached terminal is Kitty or Ghostty (the terminals here that draw Kitty Unicode placeholders);
2. the pane allows passthrough (`allow-passthrough on` or `all`, or tmux older than 3.3);
3. 24-bit colour reaches the terminal (`RGB` in `#{client_termfeatures}`, or `COLORTERM=truecolor`).

Otherwise images show their text fallback. Set `OCTOCODE_IMAGE_PROTOCOL=kitty` (or `"terminal.images": "kitty"`) to force Kitty images, or `OCTOCODE_IMAGE_PROTOCOL=none`
(or `"terminal.images": false`) to turn them off; see [configuration](configuration.md#terminal-images).

Known limits:

- A terminal that attaches later (for example a new window after `tmux detach`) has not received the earlier images. With
  `focus-events on`, tmux tells Octocode about the attach and Octocode sends the images again; attaching at a different size
  redraws them as well. Without `focus-events` (or with `OCTOCODE_NOTIFY=off` in the regular TUI, which then leaves focus
  reports off), a same-size attach shows blank cells until you resize the pane or window.
- Each image upload is sent as one passthrough envelope, so uploads from several panes redrawing at once (a split or resize) do not mix. An image
  whose encoded data exceeds about 1 MB needs several envelopes and can still go blank when another pane uploads at the same
  moment; it reappears on the next redraw.

## Not supported inside tmux

- iTerm2 inline images and SIXEL graphics. Octocode has no SIXEL output; with iTerm2 attached, images show their text fallback.
- Images in WezTerm and Warp, which do not draw Kitty Unicode placeholders.
- Bracketed paste is enabled once at startup and is not re-enabled if tmux clears it later (a known gap, tracked).

## Troubleshooting

| Symptom                             | Check                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Startup warns about `extended-keys` | `tmux show -gv extended-keys` should print `on` or `always`.                                                                                                                                                                                                                                                       |
| No notification, only a bell        | `tmux show -Apv allow-passthrough` in the pane should print `on` or `all` (`-A` includes the inherited global value; without it a globally set option prints nothing). With `on`, tmux forwards the notification only while the pane's window is the one shown; set `all` to be notified from another tmux window. |
| Links print as `text (url)`         | `tmux display -p '#{client_termfeatures}'` should list `hyperlinks`.                                                                                                                                                                                                                                               |
| Images show as text                 | `tmux display -p '#{client_termtype}'` should name Kitty or Ghostty, and the features above should list `RGB`.                                                                                                                                                                                                     |
| `/fork pane` says it needs tmux     | Octocode was not started inside tmux, or `TMUX` was removed from its environment.                                                                                                                                                                                                                                  |

## Interactive programs and the agent

The agent's `bash` tool runs commands without a terminal: stdin is closed, the process is detached from the controlling
terminal, and the environment asks tools to stay non-interactive. Commands that wait for input (password prompts from
`sudo` or `ssh`, `git rebase -i`, REPLs, installers that ask questions) get end-of-file or hang until their timeout.
The agent therefore uses non-interactive forms (`--yes`, `-y`, `GIT_EDITOR=true`, key-based `ssh`) or asks you to run
the step. `/fork pane` starts a new Octocode session in tmux; it does not send keys to other programs.

Agents can still drive a program inside a private tmux server through `bash` (`tmux -L <name> send-keys` and
`capture-pane`), which is how the [interactive testing skill](../../../.octocode/skills/interactive-testing.md) checks the
TUI. Prefer waiting for expected text over fixed sleeps, use a private server, and kill it afterwards.

## Checking tmux support

For contributors changing this behaviour:

- All tmux tests, one command from the repository root: `yarn run test:tmux`. It runs `test:tmux` in `packages/tui`
  (`node --test`: detection, paste decoding, Kitty envelopes and placeholders, re-upload, synchronized-output renewal, the
  fake-tmux helper, and real-tmux tests that attach a pty client) and in `packages/coding-agent` (`vitest`: notifications,
  `/fork` launch, the `extended-keys` warning). Real-tmux tests use a private server (`tmux -L <name>`), remove its socket
  and skip when `tmux`, `python3` or tmux 3.3 (for `allow-passthrough`) is missing. A new tmux test file in `packages/tui`
  whose name contains `tmux` is picked up by its glob; add one in `packages/coding-agent` to that `test:tmux` script.
- Test-first loop: write a failing test at the lowest level that can see the behaviour (a unit test with
  `installFakeTmux` from `packages/tui/test/helpers/fake-tmux.ts` for what Octocode asks tmux and writes; a real-tmux test
  with `killPrivateTmuxServer` from `helpers/real-tmux.ts` for what tmux does with it), run `yarn run test:tmux` and see it
  fail for the right reason, make the change, and run it again. To prove a test guards a fix, undo the fix in the working
  tree, check that the test fails, and restore the file. Then run `packages/coding-agent/scripts/tmux-cli-check.sh`.
- Real CLI: `packages/coding-agent/scripts/tmux-cli-check.sh` starts the source CLI in a private tmux server and checks
  startup and multi-line paste. With `--model` it also sends one prompt to the configured model, then checks `/fork pane`,
  `/fork pane down`, `/fork window` and the image placeholder rows. `--cli=<command>` checks another launcher, such as a
  compiled Bun binary, instead of the source CLI.
- Visual image rendering needs a real Kitty or Ghostty window. Before an unattended screenshot, re-list window ids after the
  window has settled (the first id after launch can be a transient window that captures blank) and check
  `tmux list-clients`; when in doubt, look at the window directly.
