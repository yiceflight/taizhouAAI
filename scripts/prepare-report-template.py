"""Build-time only: distill the retained user's template into a clean runtime DOCX.
Run with python-docx. The installed client uses Rust/OOXML and needs no Python.
"""
from copy import deepcopy
from pathlib import Path
import sys, zipfile, io
from docx import Document
from docx.shared import Pt
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
source=Document(sys.argv[1]); out=Document()
body=out._element.body
for item in list(body): body.remove(item)
section=deepcopy(source.sections[0]._sectPr)
# Do not retain historic headers, footers, page numbering or relationships.
for item in list(section):
 if item.tag in [qn('w:headerReference'),qn('w:footerReference'),qn('w:pgNumType')]:section.remove(item)
body.append(section)
def clone(index,text):
 el=deepcopy(source.paragraphs[index]._p)
 for child in list(el):
  if child.tag!=qn('w:pPr'):el.remove(child)
 body.insert(len(body)-1,el)
 from docx.text.paragraph import Paragraph
 p=Paragraph(el,out._body);r=p.add_run(text)
 if source.paragraphs[index].runs:
  pr=source.paragraphs[index].runs[0]._r.rPr
  if pr is not None:r._r.insert(0,deepcopy(pr))
 # Source relationships are not copied; clear numbering inherited from example.
 pr=p._p.pPr
 if pr is not None:
  for e in list(pr):
   if e.tag==qn('w:numPr'):pr.remove(e)
 if index in [13,15,20,25,29,30]:
  r.font.size=Pt(14);p.paragraph_format.line_spacing=Pt(24)
 p.paragraph_format.keep_with_next=index==29
 p.paragraph_format.space_before=Pt(0);p.paragraph_format.space_after=Pt(8)
 if index in [12,14,19,24,28]:p.paragraph_format.keep_with_next=True
 return p
clone(6,'环境监测信息快报')
clone(7,'巡飞监测记录 {{DATE}}')
clone(8,'江苏省泰州环境监测中心                  {{ISSUED}}')
clone(10,'周山河街区无人机机库智能巡飞监测快报')
clone(12,'一、污染过程总体特征')
clone(13,'{{OVERVIEW}}')
clone(14,'二、巡航执行情况')
clone(15,'{{MISSION}}')
clone(16,'{{SUMMARY_TABLE}}')
clone(19,'三、大疆司空平台抓拍图片信息')
clone(20,'{{PHOTO_SUMMARY}}')
clone(21,'{{PHOTO_TABLE}}')
clone(24,'四、可飞平台 PM2.5 与航线监测')
clone(25,'{{PM_SUMMARY}}')
clone(26,'{{PM_CHART}}')
clone(27,'图1  PM2.5 随采样时间变化（北京时间，单位 μg/m³）')
clone(26,'{{ROUTE_CHART}}')
clone(27,'图2  可飞采样航迹（按平台原始经纬度绘制，无底图）')
clone(28,'五、结论和对策建议')
clone(29,'{{CONCLUSION}}')
clone(30,'{{NOTES}}')
clone(19,'附录  Immediate-Media 巡航照片').paragraph_format.page_break_before=True
clone(20,'{{PHOTOS}}')
# Write a clean package; none of the reference images or historical signatures survive.
footer=out.sections[0].footer.paragraphs[0]
footer.alignment=1
r=footer.add_run();r.font.size=Pt(10.5)
fld=OxmlElement('w:fldSimple');fld.set(qn('w:instr'),'PAGE');r._r.addnext(fld)
out.core_properties.title='周山河街区无人机机库智能巡飞监测快报' 
out.core_properties.author='江苏省泰州环境监测中心'
out.core_properties.comments='由客户端按本次巡航资料生成，正式发布前请复核。'
out.save(sys.argv[2])
