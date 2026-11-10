"""Prepare the runtime report template from the supplied standard DOCX."""
from copy import deepcopy
from pathlib import Path
import hashlib, sys
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree as ET

ROOT = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'src-tauri/assets/flight-report-reference.docx'
target = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'src-tauri/assets/flight-report-template.docx'
EXPECTED = '25aa8b8df042c1f4577fc3ba0a19712dabd5a88543ff24abc75ec09c0c30b141'
assert hashlib.sha256(source.read_bytes()).hexdigest() == EXPECTED, 'Review the standard template before changing its slot map'
NS = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
def w(name): return '{'+NS['w']+'}'+name
def text(el): return ''.join(el.xpath('.//w:t/text()', namespaces=NS))
def serialize(el): return ET.tostring(el, encoding='UTF-8', xml_declaration=True, standalone=True)
def remove_child(child):
    if child.getparent() is not None: child.getparent().remove(child)
def set_text(el, value):
    ppr = el.find(w('pPr'))
    first = el.find('.//' + w('r'))
    rpr = deepcopy(first.find(w('rPr'))) if first is not None and first.find(w('rPr')) is not None else None
    for child in list(el):
        if child is not ppr: el.remove(child)
    run = ET.SubElement(el, w('r'))
    if rpr is not None: run.append(rpr)
    t = ET.SubElement(run, w('t')); t.text = value
    t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
def set_cell(cell, value):
    p = cell.find('.//' + w('p'))
    if p is None: p = ET.SubElement(cell, w('p'))
    set_text(p, value)
    # Runtime table values are report data, not review markup. Keep the
    # standard table typography but remove the reference template's red
    # editable-cell color so generated reports use black text consistently.
    for color in p.xpath('.//w:color', namespaces=NS):
        if color.get(w('val')) == 'FF0000':
            color.getparent().remove(color)
def replace_text(el, old, new):
    """Replace the first text span without flattening the surrounding Word runs."""
    nodes = el.findall('.//' + w('t'))
    start = text(el).index(old)
    end = start + len(old)
    offset = 0
    inserted = False
    for node in nodes:
        value = node.text or ''
        next_offset = offset + len(value)
        if offset < end and next_offset > start:
            left, right = max(0, start-offset), min(len(value), end-offset)
            node.text = value[:left] + (new if not inserted else '') + value[right:]
            node.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
            inserted = True
        offset = next_offset
with ZipFile(source) as z: parts = {n:z.read(n) for n in z.namelist()}
doc = ET.fromstring(parts['word/document.xml']); body = doc.find(w('body'))
rels = ET.fromstring(parts['word/_rels/document.xml.rels'])
original_tables = body.findall(w('tbl'))
# Keep the report through the two conclusion slots, dropping examples and sample media.
ps = body.findall(w('p'))
def findp(needle, occurrence=0):
    return [p for p in body.findall(w('p')) if needle in text(p)][occurrence]
heading = findp('五、结论和对策建议')
conclusion = next(p for p in body.findall(w('p')) if text(p).startswith('【根据巡航'))
recommendation = next(p for p in body.findall(w('p')) if text(p).startswith('【结合监测'))
seen_air_title = seen_air_note = 0
stop = False
for child in list(body):
    if child is heading: stop = True
    if stop and child not in (heading, conclusion, recommendation) and child.tag == w('p'):
        remove_child(child); continue
    if child.tag == w('p'):
        t = text(child)
        if t.startswith('表4　空气六参数监测数据'):
            seen_air_title += 1
            if seen_air_title > 1: remove_child(child); continue
        if t.startswith('注：PM2.5'):
            seen_air_note += 1
            if seen_air_note > 1: remove_child(child); continue
        if child.xpath('.//@r:embed', namespaces=NS): remove_child(child)
    elif child.tag == w('tbl'):
        # Empty layout tables and the duplicate air table in the authored file.
        table_index = original_tables.index(child) if child in original_tables else -1
        if table_index in (0, 2, 5) or not text(child).strip(): remove_child(child)
# Refresh after removals.
p7 = findp('第【1】期'); p8 = findp('江苏省泰州环境监测中心')
p13 = findp('近期监测显示'); p16 = findp('周山河街区大气超级站')
p24 = findp('通过大疆司空2平台')
set_text(p7, '第{{ISSUE}}期（泰智飞  第{{SERIES_ISSUE}}期）')
set_text(p8, '江苏省泰州环境监测中心                     {{ISSUED}}')
# Keep the user's authored prose, paragraph properties and scientific subscripts.
# Only dates, observations and evidence-dependent wording are runtime slots.
replace_text(p13, '2026年11月03日08时', '{{ANALYSIS_WINDOW}}')
for old, new in [
    ('【2026年11月03日07时，前1小时的浓度】克', '{{CITY_PM_START}}微克'),
    ('升至【2026年11月03日08时浓度】', '{{CITY_PM_DIRECTION}}{{CITY_PM_END}}'),
    ('升幅【需要计算，使用（08时浓度-07时浓度）/07时浓度*100】', '{{CITY_PM_CHANGE_LABEL}}{{CITY_PM_CHANGE}}'),
    ('【07时浓度】', '{{CITY_K_START}}'),
    ('升至【08时浓度】', '{{CITY_K_DIRECTION}}{{CITY_K_END}}'),
    ('【07时浓度】', '{{CITY_RATIO_START}}'),
    ('升至【08时浓度】', '{{CITY_RATIO_DIRECTION}}{{CITY_RATIO_END}}'),
    ('【统计当日的小时数】', '{{CITY_HIGH_HOURS}}'),
    ('【00:00、01:00、02:00、03:00、04:00、05:00、06:00、07:00】', '{{CITY_HIGH_WINDOW}}'),
    ('【统计超过1的次数】', '{{CITY_PROCESS_COUNT}}'),
    ('【具体时间段】', '{{CITY_PROCESS_TIME}}'),
    ('【1.29具体数值】', '{{CITY_K_PEAK}}'),
    ('【47.0具体数值】', '{{CITY_PEAK_PM}}'),
    ('【3.47具体数值，高值时间段的数据】', '{{CITY_MAX_RATIO}}'),
]:
    replace_text(p13, old, new)
set_text(p16, '周山河街区大气超级站在东南风向下易出现K⁺浓度异常升高的现象，站点东侧、东南、南侧农田连片分布，泰州中心综合分析周山河街区大气超级站监测数据规律与区域地理特征，在站点周边布设无人机机库，划定东侧、东南、南侧三条常态化自主巡航航线。本次任务{{TRIGGER}}，巡航时段为{{FLIGHT_WINDOW}}。各巡航区段执行情况如下。')
set_text(p24, '通过大疆司空2平台制定并执行无人机机库自动巡航任务，任务照片自动回传司空平台。本次巡航期间，司空平台共抓拍图片{{PHOTO_COUNT}}张，{{PHOTO_REVIEW_SUMMARY}}。主要抓拍图片信息如下：')
set_text(conclusion, '{{CONCLUSION}}'); set_text(recommendation, '{{RECOMMENDATION}}')
# Remove all authored figure paragraphs and leave runtime slots at the standard locations.
for p in list(body.findall(w('p'))):
    if text(p).startswith(('图1　','图2　','图3　','图4　','图5　','图6　','图7　')): remove_child(p)
def new_slot(source_p, value):
    p = deepcopy(source_p); set_text(p, value); return p
# Tables are: execution (6 cols), photo metadata (6 cols), air data (9 cols).
tables = body.findall(w('tbl'))
table1 = next(t for t in tables if len(t.findall(w('tr'))[0].findall(w('tc'))) == 6)
table2 = next(t for t in tables if len(t.findall(w('tr'))[0].findall(w('tc'))) == 7)
# The standard's final AI识别结果 column is intentionally deferred and is
# not part of the current report contract. Remove it from every table row.
for row in table2.findall(w('tr')):
    cells = row.findall(w('tc'))
    if len(cells) == 7:
        row.remove(cells[-1])
grid = table2.find(w('tblGrid'))
if grid is not None and len(grid.findall(w('gridCol'))) == 7:
    grid.remove(grid.findall(w('gridCol'))[-1])
table4 = next(t for t in tables if len(t.findall(w('tr'))[0].findall(w('tc'))) == 9)
# Ozone is not collected by the platform: remove its column and peak row.
for row in table4.findall(w('tr')):
    row.remove(row.findall(w('tc'))[-1])
table4.find(w('tblGrid')).remove(table4.find(w('tblGrid')).findall(w('gridCol'))[-1])
# Keep the overall table width, distributing the removed column among readings.
for cell, label in zip(table4.findall(w('tr'))[0].findall(w('tc'))[:3], ['序号', '监测时间', '点位/经纬度']):
    set_cell(cell, label)
widths = [500, 1320, 1830, 1040, 1040, 1040, 1040, 1037]
for col, width in zip(table4.find(w('tblGrid')).findall(w('gridCol')), widths):
    col.set(w('w'), str(width))
for row in table4.findall(w('tr')):
    for cell, width in zip(row.findall(w('tc')), widths):
        cell.find(w('tcPr')).find(w('tcW')).set(w('w'), str(width))
        margins = ET.SubElement(cell.find(w('tcPr')), w('tcMar'))
        for side in ['left', 'right']:
            ET.SubElement(margins, w(side), {w('w'): '40', w('type'): 'dxa'})
        for run in cell.findall('.//' + w('r')):
            props = run.find(w('rPr'))
            if props is None: props = ET.SubElement(run, w('rPr'))
            size = props.find(w('sz'))
            if size is None: size = ET.SubElement(props, w('sz'))
            size.set(w('val'), '18')
title1 = findp('表1　巡航执行情况'); title2 = findp('表2　大疆司空平台抓拍图片信息')
body.insert(list(body).index(table1)+1, new_slot(title1, '{{SECTION_PHOTOS}}'))
body.insert(list(body).index(table2)+1, new_slot(title2, '{{PHOTOS}}'))
note_paragraph = next(p for p in body.findall(w('p')) if text(p).startswith('注：PM2.5'))
body.insert(list(body).index(note_paragraph)+1, new_slot(note_paragraph, '第1—5行依次为PM2.5、PM10、SO₂、NO₂、CO最高值对应的采样记录，各行其余指标均取同一时刻同一点位；该行对应指标最高值加粗，并列最高值取最早记录。仅统计实际执飞时段，缺测不补0。'))
replace_text(note_paragraph, '、O3', '')
for paragraph in body.findall(w('p')):
    while '六参数' in text(paragraph):
        replace_text(paragraph, '六参数', '五参数')
def prepare_table(table, index, total):
    rows = table.findall(w('tr'))
    data = rows[1]
    for col, cell in enumerate(data.findall(w('tc'))): set_cell(cell, '{{T%d_%d}}' % (index, col))
    for extra in (rows[2:-1] if total else rows[2:]): table.remove(extra)
    if total and len(table.findall(w('tr'))) > 2:
        for col, cell in enumerate(table.findall(w('tr'))[-1].findall(w('tc'))):
            if col: set_cell(cell, '{{TOTAL%d_%d}}' % (index, col))
prepare_table(table1, 0, True); prepare_table(table2, 1, True); prepare_table(table4, 2, False)
caption = deepcopy(title2); set_text(caption, '{{CAPTION}}'); parts['word/report-caption.xml'] = serialize(caption)
# Remove unused image parts and comment parts; preserve all other standard package parts.
used = set(doc.xpath('//@r:embed | //@r:id | //@r:link', namespaces=NS))
for rel in list(rels):
    if 'comment' in rel.get('Type','').lower() or 'comment' in rel.get('Target','').lower():
        rels.remove(rel)
        continue
    if rel.get('Type','').endswith('/image') and rel.get('Id') not in used:
        parts.pop('word/' + rel.get('Target','').lstrip('/'), None); rels.remove(rel)
parts['word/_rels/document.xml.rels'] = serialize(rels); parts['word/document.xml'] = serialize(doc)
if '[Content_Types].xml' in parts:
    types = ET.fromstring(parts['[Content_Types].xml'])
    for item in list(types):
        if 'comment' in (item.get('PartName','') + item.get('ContentType','')).lower(): types.remove(item)
    parts['[Content_Types].xml'] = serialize(types)
with ZipFile(target, 'w', ZIP_DEFLATED) as z:
    for name, content in parts.items():
        if name.lower().endswith('comments.xml') or 'comments' in name.lower(): continue
        z.writestr(name, content)
print(target)
