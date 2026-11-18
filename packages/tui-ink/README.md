# @octocodeai/octocode-tui-ink

An opt-in Ink + React renderer for the Octocode terminal UI. The default renderer is `@octocodeai/octocode-tui`; this package loads only when `OCTOCODE_UI=ink` is set.

```sh
OCTOCODE_UI=ink yarn start                       # fullscreen (the default mode)
OCTOCODE_UI=ink yarn start --tui-mode regular    # inline, on the main screen
OCTOCODE_UI=ink OCTOCODE_UI_INCREMENTAL=1 yarn start   # Ink incremental rendering
```

## What it holds

| Export                           | Does                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `InkTui`                         | A `TuiMainScreen` whose frames paint through Ink instead of the differential renderer                                |
| `InlineFrame`, `FullscreenFrame` | Inline: rows that scroll past the live area move to `<Static>`; fullscreen: the alternate screen with a wheel offset |
| `mountInk`                       | Mounts a React tree on an Octocode `Terminal` (the only stdout writer)                                               |
| `<Legacy>`                       | Renders an existing `tui` component inside Ink                                                                       |
| Input, clock and theme contexts  | Keys, paste and wheel from the `tui` input layer; one shared animation clock; theme tokens                           |

## Known limits

Measured against the default renderer on the same fixture: about 8 to 10 times the frame time (p50 3.8 ms vs 0.4 ms at 120×40). Not yet carried over: the IME hardware-cursor position, kitty inline images, and frame dropping under back-pressure. `tui` never imports this package.
