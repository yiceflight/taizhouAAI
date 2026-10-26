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

class TemplateFidelity(unittest.TestCase):
    def setUp(self):
        self.reference = ZipFile(ROOT / 'src-tauri/assets/flight-report-reference.docx')
        self.addCleanup(self.reference.close)
        self.ref = E.fromstring(self.reference.read('word/document.xml'))

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
                    out = next(p for p in paragraphs if content(p) == name)
                    adjusted=deepcopy(out)
                    if name != '周山河街区无人机机库智能巡飞监测快报' and name != '环境监测信息快报':
                        self.assertEqual(out.find('w:pPr/w:keepNext',NS).get('{'+NS['w']+'}val'),'1')
                        for tag in ['keepNext','pageBreakBefore']:
                            for el in adjusted.findall('w:pPr/w:'+tag,NS): el.getparent().remove(el)
                        original=deepcopy(orig)
                        for tag in ['keepNext','pageBreakBefore']:
                            for el in original.findall('w:pPr/w:'+tag,NS): el.getparent().remove(el)
                        self.assertEqual(signature(adjusted),signature(original),name)
                    else: self.assertEqual(signature(out),signature(orig),name)
                self.assertEqual(signature(doc.find('.//w:sectPr', NS)), signature(self.ref.find('.//w:sectPr', NS)))
                for original_index in [7, 8, 13, 15, 20, 25, 29, 30]:
                    original = ref_p[original_index]
                    para_id = original.get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId')
                    out = next(p for p in paragraphs if p.get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId') == para_id)
                    self.assertEqual(signature(out.find('w:pPr', NS)), signature(original.find('w:pPr', NS)))
                # Two more subscripts exist only in the discarded historical
                # example. Compare the authored body, not that example.
                ref_body = self.ref.find('w:body', NS)
                end = list(ref_body).index(ref_p[30])
                expected = sum(len(c.findall('.//w:vertAlign', NS)) for c in list(ref_body)[:end+1])
                self.assertEqual(len(doc.findall('.//w:vertAlign', NS)), expected)
                self.assertEqual(len(doc.findall('.//w:drawing', NS)) >= 1, True)
                ref_line = self.ref.xpath('.//w:body/w:p[9]/w:r[1]', namespaces=NS)[0]
                out_line = doc.xpath('.//w:body/w:p[9]/w:r[1]', namespaces=NS)[0]
                self.assertEqual(signature(out_line), signature(ref_line))
                tables = doc.xpath('./w:body/w:tbl', namespaces=NS)
                self.assertEqual(len(tables), 4)
                for table_index, (table, orig, cols) in enumerate(zip(tables, self.ref.xpath('./w:body/w:tbl', namespaces=NS), [6, 7, 9])):
                    self.assertEqual(len(table.findall('w:tblGrid/w:gridCol', NS)), cols)
                    self.assertEqual(signature(table.find('w:tblPr', NS)), signature(orig.find('w:tblPr', NS)))
                    self.assertEqual(sum(int(c.get('{'+NS['w']+'}w')) for c in table.find('w:tblGrid',NS)), sum(int(c.get('{'+NS['w']+'}w')) for c in orig.find('w:tblGrid',NS)))
                    if table_index != 2: self.assertEqual(content(table.find('w:tr',NS)),content(orig.find('w:tr',NS)))
                    self.assertIsNotNone(table.find('w:tr/w:trPr/w:tblHeader',NS))
                    self.assertEqual([signature(x) for x in table.find('w:tr',NS).findall('.//w:rPr',NS)], [signature(x) for x in orig.find('w:tr',NS).findall('.//w:rPr',NS)])
                    for para in table.findall('.//w:p',NS):
                        self.assertEqual(para.find('w:pPr/w:snapToGrid',NS).get('{'+NS['w']+'}val'),'0')
                        self.assertEqual(para.find('w:pPr/w:spacing',NS).get('{'+NS['w']+'}line'),'260')
                    for row in table.findall('w:tr', NS): self.assertEqual(len(row.findall('w:tc', NS)), cols)
                appendix = tables[3]
                self.assertEqual([content(c) for c in appendix.find('w:tr',NS).findall('w:tc',NS)],
                    [content(c) for c in self.ref.findall('.//w:tbl',NS)[3].find('w:tr',NS).findall('w:tc',NS)])
                self.assertIsNotNone(appendix.find('w:tr/w:trPr/w:tblHeader',NS))
                self.assertEqual(doc.find('w:body/w:sectPr/w:pgSz',NS).get('{'+NS['w']+'}orient'),'landscape')
                for row in appendix.findall('w:tr',NS):
                    self.assertEqual(len(row.findall('w:tc',NS)),6)
                    self.assertIsNotNone(row.find('w:trPr/w:cantSplit',NS))
                text = content(doc)
                for stale in ['2026-06-01', '举例：', '2026年6月18日', '巡飞监测记录', '附录  Immediate-Media', '经AI智能识别，发现异常情况']:
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
                        chart = data['air'].get('chart')
                        if chart:
                            expected_images.add(hashlib.sha256(base64.b64decode(chart['dataUrl'].split(',', 1)[1])).hexdigest())
                            self.assertLess(text.index('平台原图截图'), text.index('五、结论和对策建议'))
                            self.assertIn('表4及结论仍仅统计实际执飞时段', text)
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
                                self.assertEqual(cells[6], review['result'])
                        for index, key in [(29, 'conclusion'), (30, 'recommendation')]:
                            para_id = ref_p[index].get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId')
                            out = next(p for p in paragraphs if p.get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId') == para_id)
                            if evidence.get(key): self.assertTrue(content(out).startswith(evidence[key]))
                        if evidence.get('trigger'): self.assertIn(evidence['trigger'], text)
                        if evidence.get('cityHours'):
                            valid = [h for h in evidence['cityHours'] if h['potassium'] is not None]
                            if valid:
                                self.assertIn(f"{len(valid)}个有效观测小时", text)
                                self.assertIn(f"{max(h['potassium'] for h in valid):.2f}", text)
                        if not data.get('withoutAirData'):
                            window = [(i,p) for i,p in enumerate(data['air']['points']) if data['mission']['startTime'] <= p['time'] <= data['mission']['endTime']]
                            values = [p['pm25'] for _,p in window if p['pm25'] is not None]
                            actual_rows = tables[2].findall('w:tr', NS)[1:]
                            self.assertEqual(len(actual_rows), 2)
                            for row, maximum in zip(actual_rows, [True, False]):
                                cells = [content(c) for c in row.findall('w:tc', NS)]
                                aggregate = lambda vs: max(vs) if maximum else sum(vs) / len(vs)
                                self.assertEqual(cells[0], '最高值' if maximum else '平均值')
                                self.assertEqual(int(cells[2]), len(values))
                                self.assertAlmostEqual(float(cells[3]), aggregate(values), delta=0.051)
                                for col,name,mass in [(4,'pm10',1),(5,'so2',64.06/25.4*1000),(6,'no2',46.01/25.4*1000),(7,'co',28.01/25.4),(8,'o3',48/25.4*1000)]:
                                    channel=data['air'].get('channels',{}).get(name)
                                    if channel is None: self.assertEqual(cells[col], '未取得')
                                    else:
                                        vs = [channel['values'][i] * mass for i,_ in window if channel['values'][i] is not None]
                                        if not vs: self.assertEqual(cells[col], '缺测')
                                        else: self.assertAlmostEqual(float(cells[col]), aggregate(vs), delta=0.051 if name!='co' else 0.00051)
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
