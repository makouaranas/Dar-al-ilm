# Look development: the premium hall in Blender

A procedural Blender scene of the reading hall, built to agree on a more realistic look before
any of it moves into the app. It is not part of the app and nothing here runs at app time.
The renders are not committed (generated images stay out of git).

## What the scene contains

- The nave and side aisles at the app's layout: limestone floor with brass inlays, fluted
  columns under the arcade beam at every bay boundary, plaster clerestory with mashrabiya
  windows, skylight wells, ash-slat aisle ceilings, slat-clad partition faces, the end-wall niche.
- Arched mashrabiya windows (eight-point stars tied to the frame) with window seats in the
  entrance zone and one window per bay.
- Four bays with facing ash bookcases, a reading table, chairs, a reading lamp and a pendant.
- Books placed from contact geometry: upright rows on the shelf with hairline gaps and spines
  aligned behind the shelf lip; rows end against a panel, a bookend, a leaning book resting on
  its neighbour, or a flat stack lying fully on the shelf. Spine titles in gilt or ink
  (English, French, Arabic) come from a Chromium-drawn atlas.
- The entrance desk with three books on stands, gilt cover designs.
- Signage in three levels: lit bronze section names above each bay, brass range plates at eye
  level on the bookcase ends (with the section's real book count), a directory stele at the
  entrance.

## Requirements

- Linux with Python 3.13 (Blender 5.2 as a Python module, `bpy`, needs it) and about 1.2 GB of
  disk for `tools/lookdev/.venv`.
- The frontend packages (`./scripts/setup.sh --frontend`): the mask scripts use its Playwright
  and the app's own fonts. In the cloud container set
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`.
- Cycles renders on the CPU. A 1600 px still with 48 samples takes about 6 to 8 minutes on
  4 cores.

## Usage

```bash
./tools/lookdev/render.sh                                        # all five shots, 1600 px, 48 samples
./tools/lookdev/render.sh --shot nave --res 960 --samples 16     # a quick preview
```

`render.sh` creates the virtual environment on first use, draws the masks into
`tools/lookdev/tex/`, runs the shelf collision check, then renders into
`tools/lookdev/renders/`. Any `hall.py` option can be passed through:

| Option | Meaning |
|---|---|
| `--shot a,b` | Shots: `entrance`, `nave`, `bayview`, `bay`, `desk`, `overview`. |
| `--res N` | Image width in pixels (16:9). |
| `--samples N` | Cycles samples per pixel (denoised with OpenImageDenoise). |
| `--tag S` | Suffix for the file names, e.g. `--tag=_v2`. |
| `--exposure EV` | Exposure offset. |
| `--blend file.blend` | Also save the scene, to open in the Blender app. |
| `--check` | Build only and report book overlaps, books cutting into the bookcases and unsupported books (exit code 1 when any). |
| `--counts file.json` | Build only and write the number of books per section. |

## Files

| File | Role |
|---|---|
| `hall.py` | The scene: materials, geometry, shelf filling, lighting, cameras, checks. |
| `lattice.mjs` | The mashrabiya tile mask. |
| `spine_atlas.mjs` | 256 spine labels (8 x 32 cells of 512 x 64 px). |
| `covers.mjs` | Gilt cover designs for the desk books. |
| `signs.mjs` | Section headers, range plates and the directory. |
| `render.sh` | Runs everything in order. |
