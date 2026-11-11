"""Regenerate the small raster glyph atlas. Usage: python build-glyphs.py DejaVuSans.ttf.
Only rendered glyphs ship in the app; no system font lookup is needed at runtime.
"""
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont
chars = '0123456789.:-/ PM₂₅K⁺µgm³'
font = ImageFont.truetype(sys.argv[1], 30)
image = Image.new('RGBA', (40 * len(chars), 48))
draw = ImageDraw.Draw(image)
for index, char in enumerate(chars):
    draw.text((40 * index, 0), char, font=font, fill='#455468')
image.save(Path(__file__).resolve().parents[2] / 'src-tauri/assets/station-chart-glyphs.png')
