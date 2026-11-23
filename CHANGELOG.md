# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-24

### Added

- ASCII Glyphscape Dark and ASCII Glyphscape Light themes, with terminal themes of the same names,
  rendered from any picture or video and delivered by the companion ASCII Glyphscape Output plugin,
  which is reinstalled after every render so Orca always shows the newest wallpaper.
- Renderer ported from the "ADE - ASCII Hover Dashboard" page and held to its output by a golden
  test, with four looks (Real, Blue, Dark, Mesh), colour grading (saturation, contrast, brightness,
  grain), a subject isolator, an ink tint, background and accent colours, and top and bottom shade.
- Fifteen character sets: ASCII, Detailed, Blocks, Letter tiles, Sparse, Binary, Braille, Dots,
  Dither, Bricks, Particle, Film, Drift, Code and Custom, with an effect strength and a drift
  direction.
- Looping motion for pictures (hover glow, ripple, scanline, glitch, breathe) and ASCII video
  wallpapers from video sources, kept within Orca's media limits (pictures up to 2 MB, videos up to
  8 MB and 1920 x 1200).
- Live preview editor served on 127.0.0.1 and opened in a tab of Orca's browser, with dark and
  light previews, a 1:1 detail lens, a motion preview, a character set gallery, uploads, drag and
  drop, apply and revert.
- Sidebar tone and tint settings that match Orca's solid sidebars to the wallpaper, with every
  generated colour checked against Orca's contrast and opacity rules.
- Settings page with 40 settings, an ASCII status bar item that shows render progress, and
  commands to open the editor, choose media, render, cancel, go back to the sample picture, reset
  settings and show the setup checklist.
- Plugin icon, cover and screenshots for Orca's plugin page.
- Credit for the sample picture, from Wuthering Waves (© Kuro Games), which stays outside the MIT
  license.
- Node and Python test suites.

[Unreleased]: https://github.com/Nanangprasetya/ascii-glyphscape/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Nanangprasetya/ascii-glyphscape/releases/tag/v1.0.0
