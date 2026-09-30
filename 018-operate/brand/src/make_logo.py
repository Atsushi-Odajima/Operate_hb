"""Generate Operate brand SVGs. Wordmark outlines come from Plus Jakarta Sans ExtraBold (SIL OFL 1.1),
instanced from the variable font. The "O" mark is original vector artwork."""
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import os

OUT = os.path.join(os.path.dirname(__file__), '..')
font = instantiateVariableFont(TTFont('PlusJakartaSans.ttf'), {'wght': 800})
gs = font.getGlyphSet(); cmap = font.getBestCmap(); upm = font['head'].unitsPerEm
hmtx = font['hmtx']

def text_path(text, size, x0, baseline, tracking=0):
    scale = size / upm
    pen = SVGPathPen(gs)
    x = x0
    for ch in text:
        g = cmap[ord(ch)]
        tp = TransformPen(pen, (scale, 0, 0, -scale, x, baseline))
        gs[g].draw(tp)
        x += hmtx[g][0] * scale + tracking
    return pen.getCommands(), x

GRAD = '''<linearGradient id="og" x1="0.1" y1="0.05" x2="0.9" y2="0.95"><stop offset="0" stop-color="#22D3EE"/><stop offset="0.5" stop-color="#2563EB"/><stop offset="1" stop-color="#1E3A8A"/></linearGradient>'''
GRAD_DARK = '''<linearGradient id="og" x1="0.1" y1="0.05" x2="0.9" y2="0.95"><stop offset="0" stop-color="#67E8F9"/><stop offset="0.5" stop-color="#3B82F6"/><stop offset="1" stop-color="#2563EB"/></linearGradient>'''

def mark(cx, cy, r, stroke, gap, mid='m'):
    # ring split by a "/" diagonal gap (original design)
    s = r + stroke
    return f'''<mask id="{mid}" maskUnits="userSpaceOnUse" x="{cx-s-4}" y="{cy-s-4}" width="{2*s+8}" height="{2*s+8}"><rect x="{cx-s-4}" y="{cy-s-4}" width="{2*s+8}" height="{2*s+8}" fill="#fff"/><rect x="{cx-gap/2}" y="{cy-s-8}" width="{gap}" height="{2*s+16}" fill="#000" transform="rotate(45 {cx} {cy})"/></mask>
<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="url(#og)" stroke-width="{stroke}" mask="url(#{mid})"/>'''

def write(name, svg):
    with open(os.path.join(OUT, name), 'w') as f: f.write(svg)

# mark only
for name, grad in (('logo-mark.svg', GRAD), ('logo-mark-dark.svg', GRAD_DARK)):
    write(name, f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="Operate"><title>Operate</title><defs>{GRAD}</defs>{mark(60,60,41,24,11)}</svg>\n'.replace(GRAD, grad))

# favicon: slightly thicker ring, wider gap for 16px legibility
write('favicon.svg', f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>{GRAD}</defs>{mark(32,32,21,14,7)}</svg>\n')

# horizontal logo: mark + wordmark
d, end = text_path('Operate', 92, 140, 92)
w = int(end + 8)
for name, color, grad in (('logo-horizontal.svg', '#0B1A33', GRAD), ('logo-horizontal-dark.svg', '#FFFFFF', GRAD_DARK)):
    write(name, f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} 124" role="img" aria-label="Operate"><title>Operate</title><defs>{grad}</defs>{mark(60,62,40,23,11)}<path fill="{color}" d="{d}"/></svg>\n')

# wordmark only (for the app header)
d2, end2 = text_path('Operate', 100, 0, 100)
write('wordmark.svg', f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {-2} {int(end2)+4} 132"><path fill="currentColor" d="{d2}"/></svg>\n')
print('ok', w)
