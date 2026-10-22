"""Generate the hall's material textures procedurally (docs/DESIGN.md sections 2-4).

The textures are committed under frontend/public/textures/, so this script only needs to run
again when a texture design changes. Everything is drawn from code (no downloads), and the
output is dedicated to the public domain (CC0 1.0, see frontend/public/textures/LICENSES.md).

Usage (from the repository root; needs Pillow and NumPy, both present in the backend venv):

    backend/.venv/bin/python scripts/generate_textures.py
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "frontend" / "public" / "textures"
RNG = np.random.default_rng(1405)  # fixed seed: the output is reproducible


def hex_rgb(value: str) -> np.ndarray:
    return np.array([int(value[i : i + 2], 16) for i in (1, 3, 5)], dtype=np.float64) / 255.0


def periodic_noise(size: int, scale: float, aspect: float = 1.0) -> np.ndarray:
    """Tileable noise in [-1, 1]: white noise filtered in the frequency domain.

    `scale` is the feature size in pixels; `aspect` > 1 stretches features along y.
    """
    white = RNG.standard_normal((size, size))
    fy = np.fft.fftfreq(size)[:, None]
    fx = np.fft.fftfreq(size)[None, :]
    radius = np.sqrt((fx * scale) ** 2 + (fy * scale * aspect) ** 2)
    spectrum = np.fft.fft2(white) * np.exp(-(radius**2) * 4.0)
    field = np.real(np.fft.ifft2(spectrum))
    field -= field.mean()
    return field / (np.abs(field).max() + 1e-9)


def to_image(rgb: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(rgb * 255.0 + 0.5, 0, 255).astype(np.uint8))


def save(image: Image.Image, name: str, quality: int = 90) -> None:
    path = OUT / name
    image.save(path, "WEBP", quality=quality, method=6)
    print(f"{path.relative_to(OUT.parent.parent.parent)}  {image.size[0]}x{image.size[1]}  {path.stat().st_size // 1024} KB")


# --- Limestone -----------------------------------------------------------------------------


def limestone(size: int, joints: bool) -> Image.Image:
    """Pale limestone with large-scale variation. With joints: 2.4 m square of 1.2 x 0.6 m tiles."""
    base = hex_rgb("#E7E3DB")
    tone = 0.035 * periodic_noise(size, 120) + 0.02 * periodic_noise(size, 30) + 0.012 * periodic_noise(size, 6)
    warm = 0.012 * periodic_noise(size, 80)
    rgb = np.empty((size, size, 3))
    rgb[..., 0] = base[0] * (1 + tone + warm)
    rgb[..., 1] = base[1] * (1 + tone)
    rgb[..., 2] = base[2] * (1 + tone - warm)
    # Sparse darker fossil flecks.
    flecks = periodic_noise(size, 1.2)
    rgb *= 1 - 0.05 * np.clip((flecks - 0.55) * 6, 0, 1)[..., None]
    if joints:
        px_per_m = size / 2.4
        tile_w, tile_h = int(round(1.2 * px_per_m)), int(round(0.6 * px_per_m))
        for row in range(int(math.ceil(size / tile_h))):
            offset = (tile_w // 2) * (row % 2)
            y0, y1 = row * tile_h, min(size, (row + 1) * tile_h)
            for col in range(-1, int(math.ceil(size / tile_w)) + 1):
                x0 = col * tile_w + offset
                shift = RNG.uniform(-0.018, 0.018)
                xs = np.arange(x0, x0 + tile_w) % size
                rgb[y0:y1][:, xs] *= 1 + shift
        joint = np.zeros((size, size), dtype=bool)
        for row in range(int(math.ceil(size / tile_h)) + 1):
            joint[(row * tile_h) % size, :] = True
            offset = (tile_w // 2) * (row % 2)
            y0, y1 = row * tile_h, min(size, (row + 1) * tile_h)
            for col in range(int(math.ceil(size / tile_w)) + 1):
                joint[y0:y1, (col * tile_w + offset) % size] = True
        rgb[joint] *= 0.9
    return to_image(rgb)


# --- Ash wood ------------------------------------------------------------------------------


def ash(size: int) -> Image.Image:
    """Light ash with fine straight grain running along y (1 m square).

    The grain is a random profile across x (not a regular wave, which would shimmer as
    moire at a distance), nudged slightly along y so the lines are not ruler-straight.
    """
    base = hex_rgb("#C8B699")
    profile = np.zeros(size)
    for scale, weight in ((40, 0.5), (12, 0.35), (4, 0.25)):
        white = RNG.standard_normal(size)
        freq = np.fft.fftfreq(size)
        profile += weight * np.real(np.fft.ifft(np.fft.fft(white) * np.exp(-((freq * scale) ** 2) * 4)))
    profile /= np.abs(profile).max()
    shift = (6 * periodic_noise(size, 300, aspect=0.2)).astype(int)
    columns = (np.arange(size)[None, :] + shift) % size
    grain = profile[columns]
    lines = np.clip(grain, 0, 1) ** 2 * 0.07
    tone = 0.03 * periodic_noise(size, 180, aspect=0.25)
    pores = np.clip((periodic_noise(size, 0.9, aspect=0.1) - 0.5) * 4, 0, 1) * 0.04
    shade = 1 + tone - lines - pores + 0.02 * grain
    rgb = base[None, None, :] * shade[..., None]
    return to_image(rgb)


# --- Mashrabiya lattice and its light pattern ----------------------------------------------


def star_points(cx: float, cy: float, radius: float) -> list[list[tuple[float, float]]]:
    """An eight-point star as two squares (one rotated 45 degrees)."""
    squares = []
    for rotation in (0.0, math.pi / 4):
        squares.append(
            [
                (cx + radius * math.cos(rotation + math.pi / 4 + k * math.pi / 2), cy + radius * math.sin(rotation + math.pi / 4 + k * math.pi / 2))
                for k in range(4)
            ]
        )
    return squares


def lattice_mask(size: int, cells: int, supersample: int = 3) -> Image.Image:
    """White where light passes: khatam stars on a grid with small squares between them."""
    big = size * supersample
    image = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(image)
    step = big / cells
    for i in range(-1, cells + 1):
        for j in range(-1, cells + 1):
            cx, cy = (i + 0.5) * step, (j + 0.5) * step
            for square in star_points(cx, cy, step * 0.40):
                draw.polygon(square, fill=255)
            # Small diamond openings at the cell corners.
            r = step * 0.14
            draw.polygon([(cx + step / 2, cy + step / 2 - r), (cx + step / 2 + r, cy + step / 2), (cx + step / 2, cy + step / 2 + r), (cx + step / 2 - r, cy + step / 2)], fill=255)
    # The wooden lattice bars: shrink openings a little so bars read clearly.
    image = image.filter(ImageFilter.MinFilter(2 * supersample + 1))
    return image.resize((size, size), Image.Resampling.LANCZOS)


def mashrabiya(size: int) -> Image.Image:
    """Dark wood lattice with transparent star openings (tileable, 4 x 4 cells)."""
    openings = np.asarray(lattice_mask(size, 4), dtype=np.float64) / 255.0
    base = hex_rgb("#3A3026")
    tone = 1 + 0.08 * periodic_noise(size, 40)
    rgb = base[None, None, :] * tone[..., None]
    alpha = 1.0 - openings
    rgba = np.dstack([rgb, alpha])
    return Image.fromarray(np.clip(rgba * 255 + 0.5, 0, 255).astype(np.uint8), "RGBA")


def floor_light(width: int, height: int) -> Image.Image:
    """Light map tile for the nave floor: 4.0 m across x 3.4 m along the nave.

    One skylight slot's lattice pattern, cast at a slight angle, with soft penumbra and a
    soft overall falloff. Black is no extra light.
    """
    px_x, px_y = width / 4.0, height / 3.4  # 1024 x 870 px keeps the pixels square
    # The lattice pattern seen on the floor: 0.3 m cells, sheared by the sun angle.
    cell = 0.26
    big = Image.new("L", (width * 2, height * 2), 0)
    draw = ImageDraw.Draw(big)
    sx, sy = px_x * 2, px_y * 2
    shear = 0.18
    patch_w, patch_h = 1.6, 2.7  # metres, the slot's light patch
    cx0, cy0 = 2.0 + 0.25, 1.7 + 0.3  # patch centre, shifted by the sun angle
    n = 14
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            mx = cx0 + i * cell + j * cell * shear
            my = cy0 + j * cell
            for square in star_points(mx * sx, my * sy, cell * 0.40 * sx):
                draw.polygon(square, fill=255)
            r = cell * 0.13 * sx
            dx, dy = mx * sx + cell * sx * (0.5 + shear / 2), my * sy + cell * sy / 2
            draw.polygon([(dx, dy - r), (dx + r, dy), (dx, dy + r), (dx - r, dy)], fill=255)
    big = big.filter(ImageFilter.MinFilter(5))
    pattern = big.resize((width, height), Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(2.2))
    light = np.asarray(pattern, dtype=np.float64) / 255.0
    # Soft-edged patch envelope.
    y = (np.arange(height)[:, None] + 0.5) / px_y
    x = (np.arange(width)[None, :] + 0.5) / px_x
    u = (x - cx0 - (y - cy0) * shear) / (patch_w / 2)
    v = (y - cy0) / (patch_h / 2)
    envelope = np.clip(1.0 - np.abs(u) ** 5, 0, 1) * np.clip(1.0 - np.abs(v) ** 5, 0, 1)
    glow = np.exp(-(u**2 + v**2) * 0.9) * 0.18  # soft bloom of the slot itself
    value = np.clip(light * envelope * 0.95 + glow, 0, 1)
    color = hex_rgb("#E9EEF6")
    rgb = value[..., None] * color[None, None, :]
    return to_image(rgb)


# --- Medallion -----------------------------------------------------------------------------


def medallion(size: int) -> tuple[Image.Image, Image.Image]:
    """Eight-point star medallion: lapis field, brass lines. Returns (colour RGBA, metal/rough)."""
    ss = 3
    big = size * ss
    c = big / 2
    brass_mask = Image.new("L", (big, big), 0)
    field_mask = Image.new("L", (big, big), 0)
    star_mask = Image.new("L", (big, big), 0)
    d_brass = ImageDraw.Draw(brass_mask)
    d_field = ImageDraw.Draw(field_mask)
    d_star = ImageDraw.Draw(star_mask)
    r_outer = big * 0.49
    d_field.ellipse([c - r_outer, c - r_outer, c + r_outer, c + r_outer], fill=255)
    line = big * 0.011
    # Outer brass band and a fine inner ring.
    d_brass.ellipse([c - r_outer, c - r_outer, c + r_outer, c + r_outer], outline=255, width=int(line * 1.8))
    r_inner_ring = big * 0.455
    d_brass.ellipse([c - r_inner_ring, c - r_inner_ring, c + r_inner_ring, c + r_inner_ring], outline=255, width=int(line * 0.6))
    # The lapis star (two squares), outlined in brass, with a nested brass star and a centre.
    for square in star_points(c, c, big * 0.43):
        d_star.polygon(square, fill=255)
    for radius, width in ((big * 0.43, line), (big * 0.25, line * 0.7)):
        for square in star_points(c, c, radius):
            d_brass.line(square + [square[0]], fill=255, width=int(width), joint="curve")
    r_c = big * 0.07
    d_brass.ellipse([c - r_c, c - r_c, c + r_c, c + r_c], outline=255, width=int(line * 0.7))
    shrink = lambda m: np.asarray(m.resize((size, size), Image.Resampling.LANCZOS), dtype=np.float64) / 255.0  # noqa: E731
    brass, field, star = shrink(brass_mask), shrink(field_mask), shrink(star_mask)

    lapis = hex_rgb("#2C4C9C")
    veins = periodic_noise(size, 18)
    flecks = np.clip((periodic_noise(size, 1.0) - 0.6) * 6, 0, 1)
    stone = lapis[None, None, :] * (1 + 0.12 * veins)[..., None]
    stone = stone * (1 - flecks[..., None]) + hex_rgb("#C9A55C")[None, None, :] * flecks[..., None] * 0.85  # pyrite
    disc = hex_rgb("#DDD7CB")[None, None, :] * (1 + 0.03 * periodic_noise(size, 60))[..., None]
    inlay = disc * (1 - star[..., None]) + stone * star[..., None]
    brass_rgb = hex_rgb("#B08A4E")[None, None, :] * np.ones((size, size, 1))
    rgb = inlay * (1 - brass[..., None]) + brass_rgb * brass[..., None]
    rgba = np.dstack([rgb, field])
    colour = Image.fromarray(np.clip(rgba * 255 + 0.5, 0, 255).astype(np.uint8), "RGBA")
    # metalnessMap reads blue, roughnessMap reads green (three.js convention).
    rough = (0.40 * (1 - star) + 0.30 * star) * (1 - brass) + 0.25 * brass
    mr = np.dstack([np.zeros_like(brass), rough, brass])
    return colour, to_image(mr)


# --- Light sprites -------------------------------------------------------------------------


def halo(size: int) -> Image.Image:
    """Radial falloff for additive halos and light pools (white; tinted by the material)."""
    y, x = np.mgrid[0:size, 0:size]
    r = np.sqrt((x - size / 2 + 0.5) ** 2 + (y - size / 2 + 0.5) ** 2) / (size / 2)
    value = np.clip(np.exp(-(r**2) * 4.5) - np.exp(-4.5) * r, 0, 1)
    return to_image(np.repeat(value[..., None], 3, axis=2))


def wall_wash(width: int, height: int) -> Image.Image:
    """A wall-washer's scallop: bright at the top, fading down, soft at the sides."""
    y = (np.arange(height)[:, None] + 0.5) / height
    x = (np.arange(width)[None, :] + 0.5) / width
    vertical = np.exp(-(y**1.4) * 3.2) * (1 - np.exp(-y * 40))
    horizontal = np.exp(-(((x - 0.5) * 2.2) ** 4))
    return to_image(np.repeat((vertical * horizontal)[..., None], 3, axis=2))


def contact(size: int) -> Image.Image:
    """Baked contact darkening under furniture: white outside, soft darker footprint (multiply)."""
    y, x = np.mgrid[0:size, 0:size]
    u = np.abs((x + 0.5) / size * 2 - 1)
    v = np.abs((y + 0.5) / size * 2 - 1)
    edge = np.maximum(u, v)
    darkness = np.clip((1 - edge) / 0.45, 0, 1) ** 1.6 * 0.42
    return to_image(np.repeat((1 - darkness)[..., None], 3, axis=2))


def shade_glow(size: int) -> Image.Image:
    """Emissive map of a perforated star-pattern pendant shade."""
    openings = np.asarray(lattice_mask(size, 6), dtype=np.float64) / 255.0
    return to_image(np.repeat(openings[..., None], 3, axis=2))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    save(limestone(1024, joints=True), "limestone-floor.webp")
    save(limestone(512, joints=False), "limestone.webp")
    save(ash(1024), "ash.webp")
    save(mashrabiya(512), "mashrabiya.webp", quality=92)
    save(floor_light(1024, 870), "floor-light.webp")
    colour, mr = medallion(1024)
    save(colour, "medallion.webp", quality=92)
    save(mr, "medallion-mr.webp")
    save(halo(256), "halo.webp")
    save(wall_wash(256, 512), "wall-wash.webp")
    save(shade_glow(256), "shade-glow.webp")
    save(contact(128), "contact.webp")


if __name__ == "__main__":
    main()
