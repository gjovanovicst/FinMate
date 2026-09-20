# README assets

## `banner.png`

The banner at the top of the root `README.md`. `banner.svg` is the editable source; `banner.png` is
what the README references, because a PNG renders everywhere a README does while an SVG's fonts are
whatever the viewer happens to have.

**The colours are the shipped design tokens** (`apps/web/src/styles.css`, ADR-039) rather than invented
ones, so the banner cannot drift from the product: `#0a0e18` ground, the `135deg` `#5b6cf9 → #8b5cf6`
brand gradient on the mark, `#eef2fa` wordmark, `#9aa8c0` tagline, `#a99cff` on a 14 % `#6d5cf6` pill,
`#242e45` hairlines. The mark is the same path `ui-brand` draws inline.

Committed at **2560 × 576** (1280 × 288 CSS pixels at 2×), which GitHub displays at roughly 1012 px wide
and stays crisp on a high-density display.

### Re-rendering it

This repository has no image library and no Playwright dependency (rule 9), so both tools below are
whatever the machine already has. Playwright's browser cache is a common place to find Chromium.

```bash
# 1. Rasterise the SVG at 2x.
CHROME=~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell

"$CHROME" \
  --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1280,288 \
  --screenshot=/tmp/banner-raw.png \
  "file://$PWD/docs/assets/banner.svg"

# 2. Quantise to a 256-colour palette. This is not cosmetic — see below.
ffmpeg -y -i /tmp/banner-raw.png \
  -vf "split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4" \
  docs/assets/banner.png
```

### Why step 2 exists, and why the dither is not optional

Chrome writes a **469 KB** truecolour PNG. Quantising it takes that to **135 KB**, which is the whole
reason for the step — but the two ways of quantising are not equivalent, and only one of them is
acceptable:

| Variant                         | Size   | At 1:1                                                           |
| ------------------------------- | ------ | ---------------------------------------------------------------- |
| truecolour (as Chrome wrote it) | 469 KB | clean                                                            |
| 256 colours, `dither=none`      | 145 KB | **visible banding** — concentric rings through both radial glows |
| 256 colours, Bayer dither       | 135 KB | clean; the grain reads as texture beside the dot grid            |

The no-dither banding is invisible in a scaled-down preview and obvious in a 1:1 crop, which is the
trap: it looks fine in a screenshot thumbnail and ships. Crop to 1:1 before accepting any quantisation.

### Two more traps, both of which produce a PNG rather than an error

1. **An XML comment may not contain a double hyphen.** Writing a design token by its real name
   (`--color-bg`) or a command flag (`--no-sandbox`) inside `banner.svg`'s comment makes the file
   _invalid XML_. Chrome does not fail — it writes a PNG of its own XML parse-error page, which looks
   like a successful render until you open it. That is why the token names in the comment have no
   leading dashes, and why this recipe lives in Markdown.
2. **Fonts are not embedded.** Text renders with the machine's fonts, so the PNG is **not
   byte-reproducible** elsewhere. The stack is `Ubuntu, Liberation Sans, DejaVu Sans` because Ubuntu is
   the closest widely-available face to the app's `system-ui`. A committed PNG that differs from a fresh
   render is a font difference, not an SVG change.

Validate before rendering, which catches trap 1 in one line:

```bash
python3 -c "import xml.etree.ElementTree as ET; ET.parse('docs/assets/banner.svg'); print('valid XML')"
```
