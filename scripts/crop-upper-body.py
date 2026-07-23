#!/usr/bin/env python3
"""Normalize player renders to the card guidelines.

Run after scripts/fetch-player-images.js:

    python3 scripts/crop-upper-body.py [dir]

For each PNG (default: public/img/players/) the subject is read from the
alpha channel and normalized so every card shares the same framing:

1. multi-player renders are flagged (two+ large alpha blobs) and left alone —
   the caller should replace them with a single-player source ("MULTI <file>"
   lines on stdout make them easy to collect).
2. full-body renders (subject height/width > 1.45) are cropped to the upper
   body: half the subject height, clamped to 0.9~1.4x its width.
3. wide poses (outstretched arms etc. — final ratio closer to 1:1 than the
   other cards) are narrowed around the head column so height/width lands
   near TARGET_RATIO. Native face shots (< 0.9 without an upper-body crop)
   pass through — narrowing a headshot just cuts ears.

Idempotent: normalized images re-enter within the accepted band and are not
touched again.
"""
import os
import sys

from PIL import Image

IMG_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "..", "public", "img", "players"
)

FULL_BODY_RATIO = 1.45  # subject taller than this counts as full body
MAX_RATIO = 1.4         # upper-body crop: never taller than 1.4x width
MIN_RATIO = 0.9         # ...and never shorter than 0.9x (wide poses)
HEADROOM = 0.02
SIDE_MARGIN = 0.03
WIDE_TRIGGER = 1.05     # final ratio below this = too wide vs the other cards
TARGET_RATIO = 1.15     # horizontal crop aims here
MIN_KEEP = 0.62         # keep at least this share of the subject's width
ALPHA_T = 32


def subject_bbox(im):
    mask = im.split()[3].point(lambda a: 255 if a > ALPHA_T else 0)
    return mask.getbbox()


def component_areas(im):
    """Areas of connected alpha blobs on a 64px-wide downscale (pure PIL)."""
    W = 64
    H = max(1, round(im.height * W / im.width))
    a = im.split()[3].resize((W, H))
    px = a.load()
    seen = [[False] * W for _ in range(H)]
    areas = []
    for y0 in range(H):
        for x0 in range(W):
            if px[x0, y0] > ALPHA_T and not seen[y0][x0]:
                stack = [(x0, y0)]
                seen[y0][x0] = True
                n = 0
                while stack:
                    cx, cy = stack.pop()
                    n += 1
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < W and 0 <= ny < H and not seen[ny][nx] and px[nx, ny] > ALPHA_T:
                            seen[ny][nx] = True
                            stack.append((nx, ny))
                areas.append(n)
    return areas


def is_multi_player(im):
    areas = component_areas(im)
    total = sum(areas) or 1
    return sum(1 for a in areas if a / total >= 0.18) >= 2


def head_center_x(im, bbox):
    """Alpha center of mass over the subject's top 40% — the head column."""
    left, top, right, bottom = bbox
    band_h = max(1, int((bottom - top) * 0.4))
    region = im.crop((left, top, right, top + band_h)).split()[3]
    px = region.load()
    w, h = region.size
    sx = 0
    n = 0
    for y in range(0, h, 2):
        for x in range(w):
            if px[x, y] > ALPHA_T:
                sx += x
                n += 1
    return left + (sx / n if n else w / 2)


def crop_file(path):
    im = Image.open(path)
    if im.mode != "RGBA":
        im = im.convert("RGBA")  # footyrenders saves palette-mode PNGs
    if not im.getextrema()[3][0] < 255:
        return "skip-no-alpha"
    bbox = subject_bbox(im)
    if not bbox:
        return "skip-empty"

    # guideline 2: never a two-player render on a card
    if is_multi_player(im):
        return "multi"

    left, top, right, bottom = bbox
    w = right - left
    h = bottom - top
    changed = False
    was_full = h / w > FULL_BODY_RATIO

    # guideline 3: upper body only
    if was_full:
        crop_h = min(0.5 * h, MAX_RATIO * w)
        crop_h = max(crop_h, MIN_RATIO * w)
        margin_x = int(w * SIDE_MARGIN)
        headroom = int(h * HEADROOM)
        im = im.crop((
            max(0, left - margin_x),
            max(0, top - headroom),
            min(im.width, right + margin_x),
            min(im.height, top + int(crop_h)),
        ))
        changed = True
        bbox = subject_bbox(im)
        if not bbox:
            return "skip-empty"
        left, top, right, bottom = bbox
        w = right - left
        h = bottom - top

    # guideline 4: wide poses get narrowed around the head column so the
    # cards keep a common ratio. native face shots (< MIN_RATIO with no
    # upper-body crop) stay untouched.
    ratio = h / w
    if ratio < WIDE_TRIGGER and (was_full or ratio >= MIN_RATIO):
        target_w = max(h / TARGET_RATIO, w * MIN_KEEP)
        if target_w < w - 2:
            cx = head_center_x(im, bbox)
            x0 = cx - target_w / 2
            x0 = min(max(x0, left), right - target_w)
            im = im.crop((int(x0), 0, int(x0 + target_w), im.height))
            changed = True

    if changed:
        im.save(path)
        return "cropped"
    return "skip-already-ok"


def main():
    counts = {}
    for name in sorted(os.listdir(IMG_DIR)):
        if not name.endswith(".png"):
            continue
        try:
            r = crop_file(os.path.join(IMG_DIR, name))
        except Exception as e:  # noqa: BLE001
            r = f"error ({e})"
        counts[r] = counts.get(r, 0) + 1
        if r == "multi":
            print(f"MULTI {name}")
        if r.startswith("error"):
            print(f"  {name}: {r}", file=sys.stderr)
    print(counts)


if __name__ == "__main__":
    main()
