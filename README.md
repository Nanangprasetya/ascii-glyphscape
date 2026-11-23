# ASCII Glyphscape for Orca

Turns any picture or video into an ASCII-art wallpaper theme for Orca, with matching dark and light
UI colours. The renderer is a port of the "ADE - ASCII Hover Dashboard" page: the same styles,
character sets and colour maths, checked against that page's own output by a golden test.

- **Four styles**: Real (original colour), Blue (halftone), Dark (dot matrix), Mesh (diamond LED).
- **Fifteen character sets**: the page's ASCII, Dots, Binary, Blocks and Code, your own ramp, and
  nine more:
  - **Detailed**: a 70-step ramp.
  - **Letter tiles**: letters cut out of solid tiles.
  - **Sparse**: few marks, much empty space.
  - **Braille** and **Dither**: twice the grid's detail, through a Bayer matrix that stays still
    in videos.
  - **Bricks**: framed tiles in running bond.
  - **Particle**: scattered dots of three sizes.
  - **Film**: capitals with a split-tone grade, red halation, vignette and grain.
  - **Drift**: streaks that smear into trails of dots, in any of four directions.

  Detailed, Letter tiles and Film are sorted by the ink each glyph has in the chosen font. Film,
  Particle and Drift follow **Style: effect strength**.
- **Colour grading**: saturation, contrast, brightness, grain, a subject isolator (flat background),
  an ink tint (duotone), background and accent colours, top and bottom shade.
- **Motion**: the page's hover glow is replayed by a virtual cursor (with its trail, push and
  glitch characters); also ripples, a scanline, glitch blocks and a slow breathe. Each is a seamless
  loop rendered to a video wallpaper.
- **Any source**: pictures (JPG, PNG, WebP, BMP, GIF, TIFF, AVIF) or videos (MP4, MOV, WebM, MKV,
  animated GIF). A video source becomes an ASCII video wallpaper.
- **Both themes at once**: "ASCII Glyphscape Dark" and "ASCII Glyphscape Light", plus terminal themes of the same names.
  They come from a second, content-only plugin, **ASCII Glyphscape Output**, that this plugin writes and
  installs for you (see "How it works").

All configuration lives in **Settings > Plugins > ASCII Glyphscape**. Every change renders the themes
again in the background; the **ASCII** item in the status bar shows the progress. For trying looks
out first, there is the editor.

## Editor

**ASCII Glyphscape: Open editor** opens a page in a tab of Orca's own browser (not a sidebar):

- A **live preview** of the wallpaper, drawn by the same renderer as the real themes, for the dark
  and the light theme. It updates as you move a slider (a few hundred milliseconds).
- **1:1 detail**: a lens that shows the real full-size pixels under the pointer (press L).
- **Motion**: the loop, or the first seconds of a video, as an animated preview.
- **Character sets as a gallery**: every set drawn live on your picture at the real cell size.
  Click the preview to choose which spot the gallery shows.
- **Sources**: the sample and your library, with upload (button or drop a file on the page), the
  desktop's file dialog, and removing old files.
- Changes stay a draft (a dot marks each one) until **Apply** (Ctrl+Enter). Apply writes them to the
  plugin's settings and renders both themes at once. **Revert** drops the draft. When the settings
  change on Orca's Settings page meanwhile, the editor follows them, or asks first if you have
  changes of your own.

Running the command again brings the same tab back. A tab Orca restores after a restart keeps
working.

## Requirements

- Orca 1.4.258 or newer (video wallpapers need 1.4.254).
- Python 3 with Pillow: `sudo pacman -S python-pillow` (Arch), `sudo apt install python3-pil` (Debian, Ubuntu).
- ffmpeg with libx264, for motion and video sources: `sudo pacman -S ffmpeg`. Pictures work without it.
- For the file dialog: `kdialog` (KDE) or `zenity`. Without them, type the path into the Source setting.

## Install

```sh
orca plugin dev load /path/to/orca-themes      # prints a fingerprint
orca plugin dev load /path/to/orca-themes --approve <fingerprint>
```

The plugin runs its own code (the worker and the Python renderer), so Orca asks you to approve it.

## Make the wallpaper visible

Orca only paints a theme's wallpaper when its own settings allow it:

1. **Settings > Appearance > Theme**: choose **ASCII Glyphscape Dark** or **ASCII Glyphscape Light** (listed under ASCII Glyphscape Output), and the terminal theme of the same name. The first render installs ASCII Glyphscape Output; choose the theme after that.
2. **Background Opacity** below 1 (try 0.6) under Settings > Appearance > Interface > Advanced and Terminal > Advanced. At 1 Orca paints no wallpaper at all.
3. **Reduce Visual Effects** off. A video plays while the Orca window has focus; otherwise Orca shows the still picture.

Run **ASCII Glyphscape: Show setup checklist** from the command palette to see this list together with
what was found on your machine.

## About blurring the sidebar

Orca does not let a theme blur its sidebars or make them see-through. Its theme tokens are a closed
list of solid colours, and Orca drops any surface colour with transparency or with text contrast
below 4.5:1. The wallpaper shows through terminals and chats only. So instead of a blur, the
**Sidebar** settings make the solid sidebars sit well against the wallpaper: match the background,
go deeper or lift it, and mix in the accent colour. Every generated colour is checked against Orca's
own rules before it is written, so none of them is silently dropped.

## Commands

| Command | What it does |
| --- | --- |
| ASCII Glyphscape: Open editor (live preview) | Opens the editor in a tab of Orca's browser, or brings its tab back. |
| ASCII Glyphscape: Choose image or video... | Opens a file dialog; the file is copied into the plugin's library and set as the source. |
| ASCII Glyphscape: Render now | Renders again even when nothing changed. Also a click on the status bar item. |
| ASCII Glyphscape: Cancel render | Stops the running render; the current themes stay as they are. |
| ASCII Glyphscape: Use the sample picture | Goes back to the sample picture after you chose a file. |
| ASCII Glyphscape: Reset settings | Puts every look setting back to its default. |
| ASCII Glyphscape: Show setup checklist | The steps above and what this machine has. |

## Limits (Orca's)

| | Picture | Video |
| --- | --- | --- |
| Format written | WebP | H.264 MP4, no audio |
| Size | at most 2 MB | at most 8 MB, 60 s |
| Pixels | 640x360 to 4096 a side | at most 1920x1200 |

ASCII art is dense, so a 4K picture rarely fits in 2 MB. The renderer then draws it again at the
largest size that fits (the character cells scale with it, so the look stays the same) rather than
shrinking a finished picture, and tells you what it changed.

## How it works

- `main.mjs` and `lib/` are the Orca worker. It reads the settings, and on a change (debounced)
  starts `tools/ascii_cli.py` as a detached process. Orca restarts a development plugin's worker
  whenever a file in its folder changes, and the renderer writes there, so the render outlives the
  worker and reports through a job file in `~/.local/share/orca-ascii-themes/jobs/`. A restarted
  worker picks the job up from there. A render whose settings and source did not change is skipped.
- `tools/` is the renderer (Python, Pillow, no numpy). `ascii_core.py` is the page's maths, held to
  the page's own answers by a golden test. `ascii_glyphs.py` adds the plugin's character sets on
  top of it: cellStyle() still picks per cell, so every style keeps its colours. The pattern sets
  draw their own tiles as private-use characters, so the compositor and the motion effects treat
  them like letters. A frame is composed in layers inside
  Pillow's C code (one layer per glyph), so a full 4K frame takes well under a second; video frames
  are drawn by a pool of worker processes and streamed to ffmpeg.
- The themes are written into a small content-only plugin, the theme pack, in
  `~/.local/share/orca-ascii-themes/theme-pack` (or the folder named in Advanced > theme output
  folder), never into this plugin's folder. After each render the worker installs that folder again
  (`orca plugin update local.ascii-themes-output`). Why: Orca serves a theme's wallpaper at a URL
  made of the plugin's content hash; a development folder has none, so its URL never changes and
  Orca keeps showing the first picture it loaded. An installed plugin gets a new hash, and so a new
  URL, with every render. A content-only plugin installs without approval, and Orca keeps only the
  current copy and the one before it.
- The editor is served by a small HTTP server in the worker (`lib/editor-server.mjs`) and opened
  with Orca's CLI (`orca tab create`). The server listens on 127.0.0.1 only, answers only its own
  Host, needs a random 128-bit token in every path, takes requests only from its own origin with a
  JSON or binary content type, and serves pages under a strict content security policy. Its port
  and token are kept in the data folder (`editor.json`).
- Previews come from `tools/ascii_preview.py`, a Python process that stays up while the editor is
  used (fonts, the source and the last full-size render stay loaded) and stops after ten idle
  minutes. Only the newest request of each kind waits for it, so dragging a slider never queues
  old previews. A test holds the preview to the same pixels as a real render.
- Media files get content-hash names, and the theme JSON is switched to them last, atomically.
  Earlier renders are removed. `assets/pack/` holds the starting themes a new pack is made from.

## Develop

```sh
node --test test/*.test.mjs          # worker tests (includes a real render)
python3 -I -B tools/test_ascii.py    # renderer tests (golden port, compositing, budgets, loops, themes)
node scripts/sync-manifest.mjs       # after changing settings, commands or themes
node tools/golden/make_golden.mjs    # regenerates the page's reference answers
orca plugin validate . && orca plugin check .
orca plugin dev watch .              # loads the folder and streams its logs
```

## License

MIT
