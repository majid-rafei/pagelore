"""Generate the extension icons (public/icons/icon-*.png). Requires Pillow: python3 scripts/make-icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

S = 512  # draw large, then downscale for smooth edges
OUT = Path(__file__).resolve().parent.parent / 'public' / 'icons'


def gradient(size, top, bottom):
    img = Image.new('RGBA', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        d.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    return img


def draw():
    bg = gradient(S, (79, 70, 229), (13, 148, 136))  # indigo → teal
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([16, 16, S - 16, S - 16], radius=112, fill=255)
    icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(icon)
    white = (255, 255, 255, 255)
    # Speech bubble
    d.rounded_rectangle([96, 120, 416, 352], radius=64, fill=white)
    d.polygon([(150, 340), (150, 430), (240, 346)], fill=white)
    # Four-point sparkle inside the bubble ("AI")
    cx, cy, r, w = 256, 236, 84, 22
    accent = (79, 70, 229, 255)
    d.polygon([(cx, cy - r), (cx + w, cy - w), (cx + r, cy), (cx + w, cy + w),
               (cx, cy + r), (cx - w, cy + w), (cx - r, cy), (cx - w, cy - w)], fill=accent)
    return icon


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    big = draw()
    for size in (16, 32, 48):
        big.resize((size, size), Image.LANCZOS).save(OUT / f'icon-{size}.png')
    # Chrome Web Store guideline: 128×128 with the artwork in the central 96×96 (16 px transparent padding).
    padded = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
    padded.paste(big.resize((96, 96), Image.LANCZOS), (16, 16))
    padded.save(OUT / 'icon-128.png')
    print('Icons written to', OUT)


if __name__ == '__main__':
    main()
