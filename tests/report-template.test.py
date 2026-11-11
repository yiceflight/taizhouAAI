"""Structural fidelity contract against the retained, unmodified user template.

Run with bundled Python: python tests/report-template.test.py [generated.docx]
An optional real output is checked in addition to the prepared runtime template.
"""
from pathlib import Path
import base64
import hashlib
import json
import io
import sys
import unittest
from copy import deepcopy
from zipfile import ZipFile
from lxml import etree as E
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else None
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
def signature(el):
    if el is None: return None
    return el.tag, sorted(el.attrib.items()), el.text, [signature(c) for c in el]
def content(el): return ''.join(el.xpath('.//w:t/text()', namespaces=NS))

def layout_signature(el):
    """Compare retained design excluding the explicitly normalized typography."""
    el = deepcopy(el)
    if el is None: return None
    for node in el.xpath('.//w:rFonts | .//w:sz | .//w:szCs | .//w:color | .//w:highlight | .//w:shd | .//w:b | .//w:bCs | .//w:jc | .//w:ind | .//w:spacing | .//w:snapToGrid | .//w:widowControl', namespaces=NS):
        node.getparent().remove(node)
    for node in el.xpath('.//w:rPr', namespaces=NS):
        if not len(node) and not node.attrib: node.getparent().remove(node)
    return signature(el)

class TemplateFidelity(unittest.TestCase):
    def test_masthead_rule_and_caption_table_adjacency(self):
        with ZipFile(ROOT / 'src-tauri/assets/flight-report-template.docx') as z:
            doc = E.fromstring(z.read('word/document.xml'))
        body = doc.find('w:body', NS)
        masthead = next(p for p in body if '{{ISSUED}}' in content(p))
        border = masthead.find('w:pPr/w:pBdr/w:bottom', NS)
        self.assertIsNotNone(border)
        self.assertEqual(border.get('{'+NS['w']+'}color'), 'FF0000')
        self.assertEqual(border.get('{'+NS['w']+'}val'), 'single')
        caption = next(p for p in body if content(p) == '表1　巡航执行情况')
        self.assertEqual(caption.getnext().tag, '{'+NS['w']+'}tbl')
        spacing = caption.find('w:pPr/w:spacing', NS)
        self.assertEqual(spacing.get('{'+NS['w']+'}before'), '240')
        self.assertEqual(spacing.get('{'+NS['w']+'}after'), '0')
        heading = next(p for p in body if content(p) == '三、大疆司空平台抓拍图片信息')
        self.assertEqual(heading.find('w:pPr/w:spacing', NS).get('{'+NS['w']+'}before'), '240')

    def test_government_typography_and_scientific_scripts(self):
        with ZipFile(ROOT / 'src-tauri/assets/flight-report-template.docx') as z:
            doc = E.fromstring(z.read('word/document.xml'))
        val = '{'+NS['w']+'}val'
        paragraphs = doc.findall('w:body/w:p', NS)
        cases = [
            ('周山河街区无人机机库智能巡飞监测快报', '方正小标宋_GBK', '44'),
            ('污染过程总体特征', '黑体', '32'),
            ('（一）综合结论', '楷体_GB2312', '32'),
            ('（二）工作建议', '楷体_GB2312', '32'),
            ('{{CONCLUSION}}', '方正仿宋_GBK', '32'),
        ]
        for label, font, size in cases:
            p = next(p for p in paragraphs if content(p) == label)
            for props in p.findall('w:r/w:rPr', NS):
                self.assertEqual(props.find('w:rFonts', NS).get('{'+NS['w']+'}eastAsia'), font)
                self.assertEqual(props.find('w:sz', NS).get(val), size)
                self.assertEqual(props.find('w:szCs', NS).get(val), size)
        for p in doc.findall('.//w:p', NS):
            if not content(p) or content(p) == '环境监测信息快报': continue
            for props in p.findall('w:r/w:rPr', NS):
                self.assertEqual(props.find('w:color', NS).attrib, {val: '000000'})
        original = next(p for p in self.ref.findall('w:body/w:p', NS) if content(p).startswith('近期监测显示'))
        current = next(p for p in paragraphs if content(p).startswith('近期监测显示'))
        self.assertEqual([signature(v) for v in original.findall('.//w:vertAlign', NS)],
                         [signature(v) for v in current.findall('.//w:vertAlign', NS)])

    def setUp(self):
        self.reference = ZipFile(ROOT / 'src-tauri/assets/flight-report-reference.docx')
        self.addCleanup(self.reference.close)
        self.ref = E.fromstring(self.reference.read('word/document.xml'))

    def test_conclusion_subsections_and_fixed_advice_formatting(self):
        with ZipFile(ROOT / 'src-tauri/assets/flight-report-template.docx') as z:
            doc = E.fromstring(z.read('word/document.xml'))
        paragraphs = doc.findall('w:body/w:p', NS)
        start = next(i for i, p in enumerate(paragraphs) if content(p) == '五、结论和对策建议')
        ending = paragraphs[start + 1:]
        self.assertEqual([content(p) for p in ending[:3]],
                         ['（一）综合结论', '{{CONCLUSION}}', '（二）工作建议'])
        leads = ['一是强化重点区域和重点时段精准管控。', '二是深化空地一体化智能巡查。',
                 '三是广泛宣传，深化网格源头治理。', '四是预警联动，健全长效防控体系。']
        for paragraph, lead in zip(ending[3:], leads):
            runs = paragraph.findall('w:r', NS)
            self.assertEqual(content(runs[0]), lead)
            self.assertIsNotNone(runs[0].find('w:rPr/w:b', NS))
            self.assertIsNone(runs[1].find('w:rPr/w:b', NS))
        self.assertEqual(len(ending[3:7]), 4)
        self.assertEqual([content(p) for p in ending[7:]], [
            '江苏省泰州环境监测中心', '{{FLIGHT_DATE}}',
            '分送：第一专员办泰州监察室、泰州市生态环境局。',
            '签发：宋兴伟　审核：杨文武　编制：朱俊、彭婷、毛慧、王玉祥、赵美玲',
        ])
        for p in ending[7:9]:
            self.assertEqual(p.find('w:pPr/w:jc', NS).get('{'+NS['w']+'}val'), 'right')
        self.assertNotIn('{{RECOMMENDATION}}', content(doc))

    def test_first_paragraph_uses_local_slots_and_retains_run_formatting(self):
        with ZipFile(ROOT / 'src-tauri/assets/flight-report-template.docx') as z:
            doc = E.fromstring(z.read('word/document.xml'))
        original = next(p for p in self.ref.findall('w:body/w:p', NS) if content(p).startswith('近期监测显示'))
        paragraph = next(p for p in doc.findall('w:body/w:p', NS) if content(p).startswith('近期监测显示'))
        value = content(paragraph)
        self.assertNotIn('{{NARRATIVE}}', content(doc))
        self.assertNotIn('{{COMBUSTION_FINDING}}', content(doc))
        self.assertIn('生物质燃烧特征明显。为核实高值点位、锁定污染源头，依托无人机机库启动自动巡飞。', value)
        for fixed in ['近期监测显示，', '泰州市PM2.5小时浓度由', 'K⁺小时浓度由',
                      '高于1微克/立方米的高值共', '次明显高值过程，其中',
                      '为核实高值点位、锁定污染源头，依托无人机机库启动自动巡飞。']:
            self.assertIn(fixed, value)
        for key in ['ANALYSIS_WINDOW', 'CITY_PM_START', 'CITY_PM_END', 'CITY_PM_CHANGE',
                    'CITY_K_START', 'CITY_K_END', 'CITY_RATIO_START', 'CITY_RATIO_END',
                    'CITY_HIGH_HOURS', 'CITY_HIGH_WINDOW', 'CITY_PROCESS_COUNT',
                    'CITY_PROCESS_TIME', 'CITY_K_PEAK', 'CITY_PEAK_PM', 'CITY_MAX_RATIO']:
            slot = '{{'+key+'}}'
            self.assertEqual(value.count(slot), 1)
            self.assertTrue(any(slot in (t.text or '') for t in paragraph.findall('.//w:t', NS)), key)
        for key in ['CITY_PM_START_TIME', 'CITY_PM_END_TIME', 'CITY_K_START_TIME',
                    'CITY_K_END_TIME', 'CITY_RATIO_START_TIME', 'CITY_RATIO_END_TIME']:
            self.assertNotIn('{{'+key+'}}', value)
        self.assertEqual(layout_signature(paragraph.find('w:pPr', NS)), layout_signature(original.find('w:pPr', NS)))
        self.assertEqual([layout_signature(r.find('w:rPr', NS)) for r in paragraph.findall('w:r', NS)],
                         [layout_signature(r.find('w:rPr', NS)) for r in original.findall('w:r', NS)])
        self.assertNotIn('【', value)

    def test_original_formatting_and_no_historical_material(self):
        candidates = [ROOT / 'src-tauri/assets/flight-report-template.docx']
        if OUTPUT: candidates.append(OUTPUT)
        for path in candidates:
            with self.subTest(path=str(path)), ZipFile(path) as z:
                doc = E.fromstring(z.read('word/document.xml'))
                for name in ['styles.xml', 'numbering.xml', 'theme/theme1.xml', 'fontTable.xml']:
                    self.assertEqual(z.read('word/'+name), self.reference.read('word/'+name), name)
                # The masthead, red line, margins, original heading numbering,
                # scientific subscripts, table borders, widths and cell styles
                # must not silently turn into a new document design again.
                ref_p = self.ref.xpath('./w:body/w:p', namespaces=NS)
                paragraphs = doc.xpath('./w:body/w:p', namespaces=NS)
                for i in range(7): self.assertEqual(signature(paragraphs[i]), signature(ref_p[i]))
                for name in ['环境监测信息快报', '周山河街区无人机机库智能巡飞监测快报',
                             '污染过程总体特征', '二、巡航执行情况', '三、大疆司空平台抓拍图片信息',
                             '四、可飞平台空气六参数数据', '五、结论和对策建议']:
                    orig = next(p for p in ref_p if content(p) == name)
                    out = next(p for p in paragraphs if content(p) == name.replace('六参数', '五参数'))
                    adjusted=deepcopy(out)
                    for node in adjusted.findall('.//w:t', NS):
                        if node.text: node.text = node.text.replace('五参数', '六参数')
                        if '六参数' in name: node.attrib.pop('{http://www.w3.org/XML/1998/namespace}space', None)
                    if name != '周山河街区无人机机库智能巡飞监测快报' and name != '环境监测信息快报':
                        for tag in ['keepNext','pageBreakBefore']:
                            for el in adjusted.findall('w:pPr/w:'+tag,NS): el.getparent().remove(el)
                        original=deepcopy(orig)
                        for tag in ['keepNext','pageBreakBefore']:
                            for el in original.findall('w:pPr/w:'+tag,NS): el.getparent().remove(el)
                        self.assertEqual(layout_signature(adjusted),layout_signature(original),name)
                    elif name == '环境监测信息快报': self.assertEqual(signature(out),signature(orig),name)
                    else: self.assertEqual(layout_signature(out),layout_signature(orig),name)
                self.assertEqual(signature(doc.find('.//w:sectPr', NS)), signature(self.ref.find('.//w:sectPr', NS)))
                tables = doc.xpath('./w:body/w:tbl', namespaces=NS)
                self.assertEqual(len(tables), 3)
                for table_index, (table, orig, cols) in enumerate(zip(tables, self.ref.xpath('./w:body/w:tbl', namespaces=NS)[:3], [6, 6, 8])):
                    self.assertEqual(len(table.findall('w:tblGrid/w:gridCol', NS)), cols)
                    self.assertEqual(signature(table.find('w:tblPr', NS)), signature(orig.find('w:tblPr', NS)))
                    self.assertIsNotNone(table.find('w:tr/w:trPr/w:tblHeader',NS))
                    for para in table.findall('.//w:p',NS):
                        self.assertEqual(para.find('w:pPr/w:snapToGrid',NS).get('{'+NS['w']+'}val'),'0')
                        self.assertEqual(para.find('w:pPr/w:spacing',NS).get('{'+NS['w']+'}line'),'240' if table_index == 1 else '260')
                    for row in table.findall('w:tr', NS): self.assertEqual(len(row.findall('w:tc', NS)), cols)
                text = content(doc)
                for stale in ['2026-06-01', '举例：', '2026年6月18日', '巡飞监测记录', '附录  Immediate-Media']:
                    self.assertNotIn(stale, text)
                if path == OUTPUT:
                    self.assertNotIn('{{', text)
                    self.assertNotIn('word/report-caption.xml', z.namelist())
                    self.assertNotIn('建议逐张', text)
                    self.assertNotIn('建议优先', text)
                    source_path = path.parent / 'source.json'
                    if source_path.exists():
                        data = json.loads(source_path.read_text())
                        photos = data['photos']
                        self.assertIn(f"共抓拍图片{len(photos)}张", text)
                        actual = {hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/') and not n.endswith('/') and not n.endswith('capture-locations.png')}
                        expected_images = {hashlib.sha256(base64.b64decode(((p.get('presentation') or {}).get('dataUrl') or p['dataUrl']).split(',', 1)[1])).hexdigest() for p in photos}
                        self.assertNotIn('平台原图截图', text)
                        self.assertNotIn('airins-pm25-chart.png', z.namelist())
                        self.assertEqual(actual, expected_images, 'All current display images (including annotations), and no historical images')
                        appendix_images = appendix.findall('.//w:drawing', NS)
                        self.assertEqual(len(appendix_images), len(photos))
                        for row in appendix.findall('w:tr',NS)[1:]:
                            for col in [0,1,2,4]:
                                self.assertIn(content(row.findall('w:tc',NS)[col]), ['待核实','【 】'])
                        evidence = data.get('evidence') or {}
                        photo_rows = tables[1].findall('w:tr', NS)[1:-1]
                        ordered = sorted(photos, key=lambda p: p['name'][4:18])
                        self.assertEqual(len(photo_rows), len(ordered))
                        for row, photo in zip(photo_rows, ordered):
                            raw = base64.b64decode(photo['dataUrl'].split(',', 1)[1])
                            cells = [content(c) for c in row.findall('w:tc', NS)]
                            with Image.open(io.BytesIO(raw)) as im:
                                gps = im.getexif().get_ifd(34853)
                            if gps and 2 in gps and 4 in gps:
                                coord = lambda parts: float(parts[0]) + float(parts[1])/60 + float(parts[2])/3600
                                self.assertEqual(cells[3], f"{coord(gps[4]):.6f}°{gps[3]} / {coord(gps[2]):.6f}°{gps[1]}")
                            if b'drone-dji:ImageSource="InfraredCamera"' in raw:
                                self.assertEqual(cells[4], '红外热成像')
                            if b'drone-dji:ImageSource="ZoomCamera"' in raw:
                                self.assertEqual(cells[4], '可见光（变焦）')
                            review = evidence.get('reviews', {}).get(hashlib.sha256(raw).hexdigest())
                            if review:
                                self.assertEqual(cells[5], review['description'])
                        for index, key in [(29, 'conclusion'), (30, 'recommendation')]:
                            para_id = ref_p[index].get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId')
                            out = next(p for p in paragraphs if p.get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId') == para_id)
                            if evidence.get(key): self.assertTrue(content(out).startswith(evidence[key]))
                        if evidence.get('trigger'): self.assertIn(evidence['trigger'], text)
                        if evidence.get('cityHours'):
                            event = evidence.get('event') or {}
                            trigger = (event.get('sourceHour') or event.get('observedAt')) if event.get('source') == 'auto' else evidence.get('flightHour')
                            valid = [h for h in evidence['cityHours'] if h['potassium'] is not None and trigger and h['time'][:10] == trigger[:10] and h['time'] <= trigger]
                            if valid:
                                self.assertIn(f"{len(valid)}个有效观测小时", text)
                                self.assertIn(f"{max(h['potassium'] for h in valid):.2f}", text)
                        if not data.get('withoutAirData'):
                            window = [(i,p) for i,p in enumerate(data['air']['points']) if data['mission']['startTime'] <= p['time'] <= data['mission']['endTime']]
                            values = [p['pm25'] for _,p in window if p['pm25'] is not None]
                            actual_rows = tables[2].findall('w:tr', NS)[1:]
                            self.assertEqual(len(actual_rows), 6)
                            specs = [('pm25',1),('pm10',1),('so2',64.06/25.4*1000),('no2',46.01/25.4*1000),('co',28.01/25.4),('o3',48/25.4*1000)]
                            def value(name, mass, i):
                                raw = data['air']['points'][i]['pm25'] if name == 'pm25' else data['air'].get('channels',{}).get(name,{}).get('values',[None]*len(data['air']['points']))[i]
                                return None if raw is None else raw * mass
                            for row_index, (row, (name, mass)) in enumerate(zip(actual_rows, specs)):
                                cells = [content(c) for c in row.findall('w:tc', NS)]
                                self.assertEqual(cells[0], str(row_index + 1))
                                candidates = [(value(name,mass,i), -p['time'], -i, i) for i,p in window if value(name,mass,i) is not None]
                                if not candidates: continue
                                peak_index = max(candidates)[3]
                                for col,(channel,factor) in enumerate(specs, 3):
                                    expected = value(channel,factor,peak_index)
                                    if expected is not None:
                                        self.assertAlmostEqual(float(cells[col]), expected, delta=0.00051 if channel=='co' else 0.051)
                                peak_cell = row.findall('w:tc', NS)[row_index + 3]
                                self.assertIsNotNone(peak_cell.find('.//w:rPr/w:b', NS))
                            self.assertNotIn('筛选阈值', text)
                        if data.get('withoutAirData'):
                            self.assertFalse(data['air']['points'])
                            for index in [25]:
                                para_id = ref_p[index].get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId')
                                out = next(p for p in paragraphs if p.get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId') == para_id)
                                self.assertIn(content(out), ['', '【 】'])
                            for row in tables[2].findall('w:tr', NS)[1:]:
                                self.assertTrue(all(content(c) == '【 】' for c in row.findall('w:tc', NS)))
                else:
                    self.assertFalse([n for n in z.namelist() if n.startswith('word/media/') and not n.endswith('/')])

if __name__ == '__main__': unittest.main()
