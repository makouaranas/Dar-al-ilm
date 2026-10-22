# Texture licences

Every texture in this folder is generated procedurally by `scripts/generate_textures.py` (no
photographs, no downloads). They were made for Dar al Ilm and are dedicated to the public
domain under CC0 1.0 Universal (https://creativecommons.org/publicdomain/zero/1.0/).

| File | Content | Size |
|---|---|---|
| `limestone-floor.webp` | Pale limestone, 1.2 x 0.6 m tiles in running bond (2.4 m square) | 1024 |
| `limestone.webp` | Pale limestone without joints (columns, desk top) | 512 |
| `ash.webp` | Light ash with fine straight grain (1 m square) | 1024 |
| `mashrabiya.webp` | Dark wood lattice of eight-point stars, transparent openings | 512 |
| `floor-light.webp` | Light map of one skylight's star pattern on the nave floor (4.0 x 3.4 m) | 1024 x 870 |
| `medallion.webp`, `medallion-mr.webp` | Entrance medallion (lapis star, brass lines) and its metalness/roughness map | 1024 |
| `halo.webp` | Radial falloff for lamp halos and light pools | 256 |
| `wall-wash.webp` | Wall-washer scallop | 256 x 512 |
| `shade-glow.webp` | Perforated star pattern of the pendant shade (emissive) | 256 |
| `contact.webp` | Baked contact darkening under furniture (multiplied over the floor) | 128 |

To change a texture, edit the generator and run `backend/.venv/bin/python scripts/generate_textures.py`.
