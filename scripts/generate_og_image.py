#!/usr/bin/env python3
"""
Generate og-image.png (1200×630) for social-share previews.

Designed to run once locally (or in CI if we ever want dynamic dates).
Uses Georgia as the serif fallback when Fraunces isn't installed.

Run:
  python3 scripts/generate_og_image.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1200, 630
OUTPUT = Path(__file__).resolve().parent.parent / "og-image.png"

# Pick the nicest serif available on the machine
SERIF_CANDIDATES = [
    "/Library/Fonts/Fraunces-SemiBold.ttf",
    "/Users/someshdeswardt/Library/Fonts/Fraunces-SemiBold.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
    "/System/Library/Fonts/Supplemental/Georgia.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
]
SANS_CANDIDATES = [
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]


def pick(candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def main() -> None:
    img = Image.new("RGB", (WIDTH, HEIGHT), "#ffffff")
    d = ImageDraw.Draw(img)

    # Top-left civic-blue square, echoes favicon
    square = 56
    pad = 64
    d.rectangle([pad, pad, pad + square, pad + square], fill="#1f3a93")
    y_font = pick(SERIF_CANDIDATES, 48)
    d.text((pad + square / 2, pad + square / 2), "Y", font=y_font, fill="#ffffff", anchor="mm")

    # Eyebrow
    eyebrow_font = pick(SANS_CANDIDATES, 26)
    d.text(
        (pad + square + 20, pad + square / 2),
        "UK LOCAL ELECTIONS · 7 MAY 2026",
        font=eyebrow_font, fill="#3a4049", anchor="lm",
    )

    # Main title
    title_font = pick(SERIF_CANDIDATES, 160)
    d.text((pad, 250), "Your Ballot", font=title_font, fill="#000000")

    # Tagline
    tagline_font = pick(SERIF_CANDIDATES, 38)
    d.text(
        (pad, 420),
        "Enter your postcode. See who's standing",
        font=tagline_font, fill="#111418",
    )
    d.text(
        (pad, 468),
        "in your ward.",
        font=tagline_font, fill="#111418",
    )

    # Footer URL
    url_font = pick(SANS_CANDIDATES, 24)
    d.text(
        (pad, HEIGHT - pad - 10),
        "civictoolbox.github.io/your-ballot",
        font=url_font, fill="#3a4049", anchor="lb",
    )

    img.save(OUTPUT, optimize=True)
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
