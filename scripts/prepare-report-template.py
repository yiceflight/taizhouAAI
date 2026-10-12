"""Prepare fill-in slots in the ORIGINAL package, never rebuild its formatting.

Build-time only. Runtime fills these slots in Rust without Python or Office.
The retained reference is the default input; an explicit input/output is supported.
"""
from copy import deepcopy
from pathlib import Path
import hashlib
import sys
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree as ET

ROOT = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'src-tauri/assets/flight-report-reference.docx'
target = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'src-tauri/assets/flight-report-template.docx'
EXPECTED = 'e30bc73f8f720df2c150e36a41a10080a3ff871be0be7cd3e9466f09c16c0a32'
assert hashlib.sha256(source.read_bytes()).hexdigest() == EXPECTED, 'Review new reference before changing its slot map'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
def w(name): return '{' + NS['w'] + '}' + name
def text(el): return ''.join(el.xpath('.//w:t/text()', namespaces=NS))
def replace(el, old, new):
    """Replace across split runs, leaving all run properties/drawings untouched."""
    nodes = el.xpath('.//w:t', namespaces=NS)
    value = ''.join(n.text or '' for n in nodes)
    start = value.index(old)
    end = start + len(old)
    offset = 0
    for n in nodes:
        s = n.text or ''
        a, b = offset, offset + len(s)
        offset = b
        if b <= start or a >= end: continue
        n.text = s[:max(0, start-a)] + (new if a <= start < b else '') + s[max(0, end-a):]
        n.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
def slot(el, value):
    old = text(el)
    if old: replace(el, old, value)
    else:
        run = ET.SubElement(el, w('r'))
        ET.SubElement(run, w('t')).text = value
def serialize(el): return ET.tostring(el, encoding='UTF-8', xml_declaration=True, standalone=True)

with ZipFile(source) as z: parts = {n: z.read(n) for n in z.namelist()}
doc = ET.fromstring(parts['word/document.xml'])
body = doc.find(w('body'))
paragraphs = body.findall(w('p'))
tables = body.findall(w('tbl'))
section = deepcopy(doc.xpath('.//w:sectPr', namespaces=NS)[0])
# The authored template ends at the two conclusion slots. Everything after
# that is historical guidance, approvals and photographs, not current facts.
last = list(body).index(paragraphs[30])
for child in list(body)[last+1:]: body.remove(child)
body.append(section)

replace(paragraphs[7], '第1期', '第{{ISSUE}}期')
replace(paragraphs[7], '第1期', '第{{SERIES_ISSUE}}期')
replace(paragraphs[8], '2026年X月X日', '{{ISSUED}}')
replace(paragraphs[13], '2026-06-01 【 】时', '{{ANALYSIS_WINDOW}}')
replace(paragraphs[13], '浓度由【 】微克/立方米升至【 】微克/立方米，升幅【 】%', '{{CITY_PM}}')
replace(paragraphs[13], '浓度由【 】微克/立方米升至【 】微克/立方米', '{{CITY_K}}')
replace(paragraphs[13], '由【 】%升至【 】%；高于', '{{CITY_RATIO}}')
replace(paragraphs[13], '微克/立方米的高值共【 】小时，主要集中在【 】时段；期间共出现【 】次明显高值过程，其中【 】前后高值过程最为突出，K⁺峰值浓度达【 】微克/立方米，对应PM', '微克/立方米{{CITY_HIGH}}')
replace(paragraphs[13], '浓度达【 】微克/立方米，时段内K⁺/PM', '{{CITY_PEAK_PM}}')
replace(paragraphs[13], '比值最高达【 】%', '{{CITY_MAX_RATIO}}')
replace(paragraphs[13], '，生物质燃烧特征明显。为核实高值点位、锁定污染源头，依托无人机机库启动自动巡飞。', '{{CITY_NOTE}}')
replace(paragraphs[15], '由钾离子（K⁺）异常高值触发', '{{TRIGGER}}')
replace(paragraphs[15], '【XXXX年XX月XX日XX时～XX时】', '{{FLIGHT_WINDOW}}')
replace(paragraphs[15], '各巡航区段执行情况如下，每个区段填写一行，并在对应位置插入该区段的现场照片与位置图（照片与位置图一一对应，图注连续编号）。', '各巡航区段执行情况如下。')
replace(paragraphs[20], '【】张', '{{PHOTO_COUNT}}张')
replace(paragraphs[20], '经AI智能识别，发现异常情况【】处', '{{PHOTO_REVIEW_SUMMARY}}')
slot(paragraphs[29], '{{CONCLUSION}}')
slot(paragraphs[30], '{{RECOMMENDATION}}')
# Keep the no-Airins paragraph as an editable blank in its original style.
slot(paragraphs[25], '{{AIR_INTRO}}')

# Retain the exact caption paragraph for repeated figures. Blank picture slots
# in the reference use 10pt fixed line height: do not apply that to real images.
slot(paragraphs[18], '{{CAPTION}}')
parts['word/report-caption.xml'] = serialize(paragraphs[18])
slot(paragraphs[17], '{{SECTION_PHOTOS}}')
slot(paragraphs[22], '{{PHOTOS}}')
body.remove(paragraphs[18])
body.remove(paragraphs[23])

# Filled rows can grow: keep each original table title with its table.
# Preserve all typography, spacing and alignment from the reference.
for index in [16, 21, 26]:
    ppr = paragraphs[index].find(w('pPr'))
    if ppr is None: ppr = ET.SubElement(paragraphs[index], w('pPr'))
    keep = ppr.find(w('keepNext'))
    if keep is None: keep = ET.SubElement(ppr, w('keepNext'))
    keep.set(w('val'), '1')

# Clone the reference table's own data row, keeping tblGrid/tcW/pPr/rPr.
for index, table in enumerate(tables[:3]):
    rows = table.findall(w('tr'))
    row = rows[1]
    for col, cell in enumerate(row.findall(w('tc'))): slot(cell, '{{T%d_%d}}' % (index, col))
    for extra in rows[2:-1] if index < 2 else rows[2:]: table.remove(extra)
    if index < 2:
        for col, cell in enumerate(rows[-1].findall(w('tc'))):
            if col: slot(cell, '{{TOTAL%d_%d}}' % (index, col))

# Remove media relationships and bytes belonging only to historical examples.
# The red masthead rule is a retained vector drawing, not discarded with them.
rels = ET.fromstring(parts['word/_rels/document.xml.rels'])
used = set(doc.xpath('//@r:embed | //@r:id | //@r:link', namespaces=NS))
for rel in list(rels):
    if rel.get('Type', '').endswith('/image') and rel.get('Id') not in used:
        parts.pop('word/' + rel.get('Target'), None)
        rels.remove(rel)
parts['word/_rels/document.xml.rels'] = serialize(rels)
parts['word/document.xml'] = serialize(doc)
# This internal helper fragment is consumed and removed before export.
types = ET.fromstring(parts['[Content_Types].xml'])
for item in list(types):
    if item.get('PartName', '').startswith('/word/media/') and item.get('PartName')[1:] not in parts: types.remove(item)
parts['[Content_Types].xml'] = serialize(types)
# Historical editors and dates are not metadata of the new report.
core = ET.fromstring(parts['docProps/core.xml'])
for child in list(core): core.remove(child)
ET.SubElement(core, '{http://purl.org/dc/elements/1.1/}title').text = '周山河街区无人机机库智能巡飞监测快报'
ET.SubElement(core, '{http://purl.org/dc/elements/1.1/}creator').text = '江苏省泰州环境监测中心'
parts['docProps/core.xml'] = serialize(core)
with ZipFile(target, 'w', ZIP_DEFLATED) as z:
    for name, content in parts.items(): z.writestr(name, content)
print(target)
