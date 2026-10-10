# Deep-space background credits

Lane LA (宇宙背景 / V8). This directory holds the **real photograph** used as the
dark-theme home-page backdrop. Nothing here is procedurally generated.

The image is served under **CC BY 4.0**, which permits commercial use and
adaptation **provided the credit below stays clear and visible to every user**.
Honour that: render the credit line in the site footer or the legal/about page.

---

## `stars-milkyway.webp` — primary dark-theme backdrop

| field | value |
|---|---|
| Subject | The Milky Way panorama — 360° all-sky mosaic, galactic plane horizontal |
| Source page | https://www.eso.org/public/images/eso0932a/ |
| Direct file | https://cdn.eso.org/images/original/eso0932a.tif |
| Original resolution | 6000 × 3000 px, TIFF (LZW), 29,082,084 bytes |
| Author / institution | ESO / S. Brunier (Serge Brunier) |
| Licence | Creative Commons Attribution 4.0 International (CC BY 4.0) |
| Licence URL | https://creativecommons.org/licenses/by/4.0/ |
| Required credit | `ESO/S. Brunier` |
| Downloaded | re-fetch with `tools/fetch-space-bg.sh` |
| Processed resolution | 4096 × 2048 px (exact 2:1, equirectangular) |
| Processed encoding | WebP, quality 80, method 6 |
| Processed size | 1380720 bytes (1.317 MB) — budget 1.50 MiB |
| Grade applied | gamma 1.12, saturation ×1.10 (adapted — darkened) |
| Mean luminance | master 16.98 / 255 → final 13.42 / 255 |
| Brightest-1% mean luminance | 129.45 / 255 |
| 360° wrap continuity | wrap delta inside the normal column-to-column range; brightness step across the join is 1.65× the image's typical adjacent-column drift |

**Why this image.** It is a genuine 120-hour photographic mosaic from ESO's La
Silla and Paranal observatories, not a render or a catalog-derived chart. It is
an exact 2:1 equirectangular projection, so a 360° horizontal wrap is
photographically continuous with no seam. The galactic plane runs horizontally
through the middle, leaving the top ~20 % and bottom ~30 % of the frame as
near-black, low-detail sky — exactly where the headline and the particle comet
need to read. The Magellanic Clouds sit below the band, resolving as real
nebulosity rather than a smear.

**Grade rationale.** Gamma 1.12 is a *step* curve, not a uniform dim: it pulls the
low end (where the diffuse galactic glow lives) down hard while leaving
saturated star cores essentially untouched. That is what makes the sky deep
enough to sit behind white text and animated particles without flattening the
stars to mush. Saturation is lifted to ×1.10 to recover the colour the gamma
pull removes from the mid-tones.

## `stars-milkyway-lite.webp` — narrow viewports

Same source, same grade, 2048 × 1024 px, WebP q78, 234154 bytes (229 KB). Load
**either** this or the full-size file, never both: pick with a media query or
`window.devicePixelRatio` / `innerWidth` and load only the chosen one. Roughly a
sixth of the bytes for phones and low-DPR laptops, where 4096 px of star detail
is thrown away anyway.

---

## Candidates considered and rejected

| candidate | licence | why not used |
|---|---|---|
| NASA SVS *Deep Star Maps 2020* / `milkyway_2020_4k.exr` (Ernie Wright, GSFC SVS) | Public domain (NASA) | Clean licence and genuinely useful as a fallback, but it is a star map *computed* from Hipparcos-2 / Tycho-2 / Gaia DR2 catalogs with a photographic texture underneath — not a photograph of the sky. Measured visibly grainier and flatter than eso0932a, with a chroma flare artifact at a frame edge. Also HDR half-float OpenEXR, which needs a tone-map step in the pipeline for no visual gain here. |
| ESO `eso0933a` — Milky Way over the VLT | CC BY 4.0 | Beautiful, but 3000 × 2000 — below the 4000 px width requirement, and it is a landscape vista with a horizon and telescope silhouettes, not a deep-space field. The horizon would fight the particle scene. |
| Wikimedia Commons `File:ESO - Milky Way.jpg` | CC BY 4.0 | Byte-identical derivative of the same ESO eso0932a photograph (Commons-served 7.23 MB JPEG re-encode). **Chose the ESO CDN original TIFF instead**: same licence, 6000 × 3000, 29 MB lossless-ish master — a better input for the grade and resize, no double JPEG generation. |
| Unsplash "milky way" searches | Unsplash License | Rejected outright. The licence is free for commercial use but the *provenance* of any given upload is unverifiable — Unsplash cannot confirm a contributor actually shot the frame. This brief requires a traceable author and institution, so an Unsplash upload is strictly worse than an observatory release. |

## Reproduce

```bash
tools/fetch-space-bg.sh            # download -> grade -> encode -> verify
tools/fetch-space-bg.sh --check    # verify the existing output only
```

The script asserts the 1.5 MiB ceiling, the 4000 px minimum width, and the
360° seam, and exits non-zero if any of them fails. It writes the measured
numbers back to stdout and to `.verify.json`.
