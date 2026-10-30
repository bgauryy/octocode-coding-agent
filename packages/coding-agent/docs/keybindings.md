# Keybindings Reference

Octocode exposes named actions, such as `app.session.new`, that can be assigned keybindings. You can change default assignments or bind unassigned actions in Octocode's user configuration.

Run `/keys` to see the active shortcuts for the main editor and application.

## Assign keybindings

Create `<agent-dir>/keybindings.json`. The agent directory defaults to `~/.octocode/octocodecode/`; see [configuration locations](../../../CONFIGURATIONS.md).

Map each action identifier to one key or a list of keys:

```json
{
	"app.session.new": "ctrl+shift+n",
	"app.session.tree": ["ctrl+shift+y", "alt+shift+y"]
}
```

A configured value replaces the default for that action. Use an empty list to disable an action's keybindings:

```json
{
	"tui.altScreen.pageUp": []
}
```

After editing the file, run `/reload` to apply the changes to the active session.

## Key syntax

Write a key as `modifier+key`. Modifiers are `ctrl`, `shift`, `alt`, and `super`. You can combine modifiers. Valid keys are:

- **Letters:** `a-z`
- **Digits:** `0-9`
- **Special:** `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`
- **Function:** `f1`-`f12`
- **Symbols:** `` ` ``, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `_`, `+`, `|`, `~`, `{`, `}`, `:`, `<`, `>`, `?`

Examples: `ctrl+shift+x`, `alt+ctrl+x`, `ctrl+shift+alt+x`, `super+k`, `ctrl+super+k`, and `ctrl+1`.

`super` bindings require a terminal that reports the modifier separately, typically through the Kitty keyboard protocol. They may not work in terminals without that support.

`shift+ctrl+<letter>` bindings such as `shift+ctrl+t` need a terminal that reports Shift together with Ctrl, typically through the Kitty keyboard protocol; other terminals send them as `ctrl+<letter>`. `alt` bindings such as Windows' `alt+t` need the terminal to send Alt as Meta.

## Actions

### Terminal UI

#### Cursor movement

| Keybinding id                | Default                            | Description                                            |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `tui.editor.cursorUp`        | `up`                               | Move cursor up, browsing older history at the top      |
| `tui.editor.cursorDown`      | `down`                             | Move cursor down, browsing newer history at the bottom |
| `tui.editor.historyPrevious` | None                               | Select the previous prompt history entry               |
| `tui.editor.historyNext`     | None                               | Select the next prompt history entry                   |
| `tui.editor.cursorLeft`      | `left`, `ctrl+b`                   | Move cursor left                                       |
| `tui.editor.cursorRight`     | `right`, `ctrl+f`                  | Move cursor right                                      |
| `tui.editor.cursorWordLeft`  | `alt+left`, `ctrl+left`, `alt+b`   | Move cursor word left                                  |
| `tui.editor.cursorWordRight` | `alt+right`, `ctrl+right`, `alt+f` | Move cursor word right                                 |
| `tui.editor.cursorLineStart` | `home`, `ctrl+a`                   | Move to line start                                     |
| `tui.editor.cursorLineEnd`   | `end`, `ctrl+e`                    | Move to line end                                       |
| `tui.editor.jumpForward`     | `ctrl+]`                           | Jump forward to character                              |
| `tui.editor.jumpBackward`    | `ctrl+alt+]`                       | Jump backward to character                             |
| `tui.editor.pageUp`          | `pageUp`, `ctrl+pageUp`            | Scroll up by page                                      |
| `tui.editor.pageDown`        | `pageDown`, `ctrl+pageDown`        | Scroll down by page                                    |

The dedicated history actions browse prompt history regardless of cursor position and take precedence over application actions using the same key.

#### Text editing

| Keybinding id                   | Default                                        | Description                           |
| ------------------------------- | ---------------------------------------------- | ------------------------------------- |
| `tui.editor.deleteCharBackward` | `backspace`                                    | Delete character backward             |
| `tui.editor.deleteCharForward`  | `delete`, `ctrl+d`                             | Delete character forward              |
| `tui.editor.deleteWordBackward` | `ctrl+w`, `alt+backspace`                      | Delete word backward                  |
| `tui.editor.deleteWordForward`  | `alt+d`, `alt+delete`                          | Delete word forward                   |
| `tui.editor.deleteToLineStart`  | `ctrl+u`                                       | Delete to line start                  |
| `tui.editor.deleteToLineEnd`    | `ctrl+k`                                       | Delete to line end                    |
| `tui.editor.yank`               | `ctrl+y`                                       | Paste most recently deleted text      |
| `tui.editor.yankPop`            | `alt+y`                                        | Cycle through deleted text after yank |
| `tui.editor.undo`               | `ctrl+-` (`ctrl+z` on Windows; `alt+z` on WSL) | Undo last edit                        |

#### Input and selection

| Keybinding id         | Default                 | Description         |
| --------------------- | ----------------------- | ------------------- |
| `tui.input.newLine`   | `shift+enter`, `ctrl+j` | Insert new line     |
| `tui.input.submit`    | `enter`                 | Submit input        |
| `tui.input.tab`       | `tab`                   | Tab or autocomplete |
| `tui.input.copy`      | `ctrl+c`                | Copy selection      |
| `tui.select.up`       | `up`                    | Move selection up   |
| `tui.select.down`     | `down`                  | Move selection down |
| `tui.select.pageUp`   | `pageUp`                | Page up in list     |
| `tui.select.pageDown` | `pageDown`              | Page down in list   |
| `tui.select.confirm`  | `enter`                 | Confirm selection   |
| `tui.select.cancel`   | `escape`, `ctrl+c`      | Cancel selection    |

#### Fullscreen

In fullscreen mode, these actions control the transcript and take precedence over editor actions using the same key.

| Keybinding id                  | Default                                                              | Description                                        |
| ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------- |
| `tui.altScreen.pageUp`         | `pageUp`                                                             | Scroll the transcript up by one page               |
| `tui.altScreen.pageDown`       | `pageDown`                                                           | Scroll the transcript down by one page             |
| `tui.altScreen.halfPageUp`     | None                                                                 | Scroll the transcript up by half a page            |
| `tui.altScreen.halfPageDown`   | None                                                                 | Scroll the transcript down by half a page          |
| `tui.altScreen.lineUp`         | None                                                                 | Scroll the transcript up by one line               |
| `tui.altScreen.lineDown`       | None                                                                 | Scroll the transcript down by one line             |
| `tui.altScreen.previousPrompt` | `ctrl+shift+up`, `ctrl+up` (`ctrl+up` only on Windows and WSL)       | Jump to the previous marked message                |
| `tui.altScreen.nextPrompt`     | `ctrl+shift+down`, `ctrl+down` (`ctrl+down` only on Windows and WSL) | Jump to the next marked message                    |
| `tui.altScreen.search`         | `ctrl+shift+f` (`ctrl+f` on Windows and WSL)                         | Search the rendered transcript                     |
| `tui.altScreen.searchNext`     | `enter`, `ctrl+g`                                                    | Select the next search match while searching       |
| `tui.altScreen.searchPrevious` | `shift+enter`, `ctrl+shift+g`                                        | Select the previous search match while searching   |
| `tui.altScreen.searchClose`    | `escape`                                                             | Close transcript search                            |
| `tui.altScreen.top`            | `ctrl+home`                                                          | Scroll to the beginning of the transcript          |
| `tui.altScreen.bottom`         | `ctrl+end`                                                           | Scroll to the transcript end and follow new output |

### Application

| Keybinding id              | Default                               | Description                                                                                                   |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `app.interrupt`            | `escape`                              | Cancel / abort                                                                                                |
| `app.clear`                | `ctrl+c`                              | Clear editor (first) / exit (second)                                                                          |
| `app.exit`                 | `ctrl+d`                              | Exit (when editor empty)                                                                                      |
| `app.suspend`              | `ctrl+z` (None on Windows)            | Suspend to background                                                                                         |
| `app.permission.cycle`     | `shift+tab`                           | Cycle the permission mode (full → workspace → manual) in native sessions; handled before other editor actions |
| `app.editor.external`      | `ctrl+g`                              | Open in external editor (`externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere)     |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v` on Windows and WSL) | Paste files on macOS, images, or text from clipboard                                                          |

On native Windows, `app.suspend` has no default because Windows terminals do not support Unix job control. If you assign it manually, Octocode shows a status message instead of suspending. WSL uses the normal `ctrl+z` and `fg` behavior.

### Sessions

| Keybinding id                   | Default          | Description                            |
| ------------------------------- | ---------------- | -------------------------------------- |
| `app.session.new`               | None             | Start a new session (`/new`)           |
| `app.session.tree`              | None             | Open session tree navigator (`/tree`)  |
| `app.session.fork`              | None             | Fork current session (`/fork`)         |
| `app.session.resume`            | None             | Open session resume picker (`/resume`) |
| `app.session.togglePath`        | `ctrl+p`         | Toggle path display                    |
| `app.session.toggleSort`        | `ctrl+s`         | Toggle sort mode                       |
| `app.session.toggleNamedFilter` | `ctrl+n`         | Toggle named-only filter               |
| `app.session.rename`            | `ctrl+r`         | Rename session                         |
| `app.session.delete`            | `ctrl+d`         | Delete session                         |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | Delete session when query is empty     |

### Models and Thinking

| Keybinding id             | Default                                     | Description                                                               |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `app.model.select`        | `ctrl+l`                                    | Open model selector                                                       |
| `app.model.cycleForward`  | `ctrl+p`                                    | Cycle to next model                                                       |
| `app.model.cycleBackward` | `shift+ctrl+p` (`alt+p` on Windows and WSL) | Cycle to previous model                                                   |
| `app.models.save`         | `ctrl+s`                                    | Save the selected default model or scoped model configuration to settings |
| `app.thinking.cycle`      | `shift+ctrl+t` (`alt+t` on Windows and WSL) | Cycle thinking level (`shift+tab` cycles the permission mode instead)     |
| `app.thinking.save`       | `ctrl+s`                                    | Save current thinking level to settings                                   |
| `app.thinking.toggle`     | `ctrl+t`                                    | Collapse or expand thinking blocks                                        |

### Display and Message Queue

| Keybinding id          | Default                                   | Description                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.tools.expand`     | `ctrl+o`                                  | Collapse or expand tool output                                                                                                                                                                                          |
| `app.message.copy`     | `ctrl+x`                                  | Copy the selected message in `/tree`; in fullscreen mode, copy the active selection when `fullscreenCopyOnSelect` is `false`; otherwise copy the last assistant message. On OAuth sign-in screens, copy the sign-in URL |
| `app.message.followUp` | `alt+enter` (`ctrl+q` on Windows and WSL) | Queue a message for after the current run finishes                                                                                                                                                                      |
| `app.message.dequeue`  | `alt+up` (`alt+q` on Windows and WSL)     | Take the last queued message out of the queue and put it in the editor ahead of your draft; other queued messages stay queued                                                                                           |

While the agent runs, Enter queues input for the next assistant turn, after the current tool calls finish. The follow-up shortcut waits until the run would otherwise stop. The queue preview labels these as **Next turn** and **After run**, shows up to three messages, and counts the rest. During compaction, messages wait until compaction finishes. A submission rejected before acceptance is restored automatically.

**Managing the queue.** The preview counts and lists queued messages in the order they will be sent: all **Next turn** messages, then all **After run** messages. Up in an empty editor (focused on the last message) or `/queue` (focused on the first) opens the queue list in place of the editor. Each row shows its number, kind, a one-line preview and notes such as attachments or `extension`. The list follows the queue: delivered messages disappear, and the list closes when the queue is empty.

| Key in the queue list             | Action                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `↑` / `↓` (`k` / `j`)             | Select a message                                                                |
| `Shift+↑` / `Shift+↓` (`K` / `J`) | Move it one place among messages of the same kind                               |
| `Enter` or `e`                    | Edit it in place: `Enter` saves, `Shift+Enter` adds a line, `Escape` cancels    |
| `s`                               | Switch between **After run** and **Next turn**; it goes last among its new kind |
| `d` or `Delete`                   | Remove it                                                                       |
| `Escape` or `q`                   | Close the list                                                                  |

While you edit a message it is held out of delivery, so the agent cannot send it mid-edit and it is never sent twice; it keeps its place, kind and attachments. Saving puts the new text back in the same place, an empty or whitespace-only text removes it, and cancelling (or another dialog replacing the list) puts it back unchanged. If the run ended while you edited, there is no queue left to wait in, so saving or cancelling sends the message as it would have been sent. If a message has already begun delivery when you press Edit, nothing happens apart from a short status.

**Up arrow and queued messages.**

- Up in an empty editor opens the queue list while anything is queued; with an empty queue it browses prompt history as before. In a draft it moves the cursor or browses history as usual.
- The dequeue key (`app.message.dequeue`) recalls only the last queued message, placing it before your current draft, so repeated presses walk backwards through the queue without duplicating or dropping anything. A message with attachments stays queued, because the editor holds text only; edit or remove it from the queue list.
- `Escape` while the agent works aborts the run and restores every queued message, steering first and then follow-ups, ahead of your draft. Attachments on those messages are not restored.
- Replacing the session (`/new`, `/resume`, fork, clone) restores queued text to the editor before the old session is discarded; fork and clone then replace the editor text with their own.
- Messages queued by extensions appear in the list marked as such and can be edited, removed or moved like any other.
- Messages typed during compaction wait in the same list and are sent when compaction ends; the queue list and the dequeue key manage them too.

### Tree Navigation

| Keybinding id                   | Default                   | Description                                                                    |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `app.tree.foldOrUp`             | `ctrl+left`, `alt+left`   | Fold current branch segment, or jump to the previous segment start             |
| `app.tree.unfoldOrDown`         | `ctrl+right`, `alt+right` | Unfold current branch segment, or jump to the next segment start or branch end |
| `app.tree.editLabel`            | `shift+l`                 | Edit the label on the selected tree node                                       |
| `app.tree.toggleLabelTimestamp` | `shift+t`                 | Toggle label timestamps in the tree                                            |
| `app.tree.filter.default`       | `ctrl+d`                  | Set tree filter to default view                                                |
| `app.tree.filter.noTools`       | `ctrl+t`                  | Toggle tree filter that hides tool results                                     |
| `app.tree.filter.userOnly`      | `ctrl+u`                  | Toggle tree filter that shows only user messages                               |
| `app.tree.filter.labeledOnly`   | `ctrl+l`                  | Toggle tree filter that shows only labeled entries                             |
| `app.tree.filter.all`           | `ctrl+a`                  | Toggle tree filter that shows all entries                                      |
| `app.tree.filter.cycleForward`  | `ctrl+o`                  | Cycle tree filter forward                                                      |
| `app.tree.filter.cycleBackward` | `shift+ctrl+o`            | Cycle tree filter backward                                                     |

### Scoped Models Selector

Used inside the scoped models selector (open `/modelsettings`, then choose **Model shortcuts**).

| Keybinding id               | Default    | Description                                            |
| --------------------------- | ---------- | ------------------------------------------------------ |
| `app.models.enableAll`      | `ctrl+a`   | Enable all models (or all matching the current search) |
| `app.models.clearAll`       | `ctrl+x`   | Clear all models (or all matching the current search)  |
| `app.models.toggleProvider` | `ctrl+p`   | Toggle all models for the current provider             |
| `app.models.reorderUp`      | `alt+up`   | Move the selected model up in the cycle order          |
| `app.models.reorderDown`    | `alt+down` | Move the selected model down in the cycle order        |

For editor validation, point `$schema` at the absolute path of the [packaged keybindings schema](../schemas/keybindings.schema.json) in your installation.
