# Word固定模板字段契约

版本：fill-v8；参考文件：src-tauri/assets/flight-report-reference.docx，原文件不修改。

## 固定结构

保留原刊头、红线、五章标题、原字体/样式/编号/页边距/科学符号。正文固定文本只允许构建脚本中列明的字段化改动。删除模板填表指导语和“举例”之后的历史材料。三张表保留6/7/9列；六参数表采用已经确认的最高值/平均值口径，第一、二、三列为统计项、执飞时段、PM2.5有效点数。照片在第二、三章原有位置填充，不新增附件。原始宋体等字体不改；本机渲染可用宋体替代字体验证，Word/WPS分页仍以实际字体为准。

## 字段来源与缺失

| 字段 | 来源/计算 | 缺失或未确认 |
|---|---|---|
| ISSUE/SERIES_ISSUE | 人工编期（当前无自动编期来源） | 【待编】 |
| ISSUED/ANALYSIS_WINDOW | 生成日期 / 精确匹配航次自动事件的 sourceHour（旧事件回退整点 observedAt）；没有本地监测触发记录的司空/手动航次用实际起飞所在小时，北京时间 | 支持缺少 localEventId 时按唯一起止时间恢复本地事件；不得用生成时刻代替。flightHour 归档实际起飞小时，event 保留优先采用的触发依据 |
| CITY_PM/K/RATIO_START/END | 各指标在触发小时之前最近有效值 → 触发小时值（允许跨日）；比值仅同小时配对且PM2.5>0 | 红色【 】；当前小时缺失不得用旧值回填，方向需两端均有效 |
| CITY_*_DIRECTION | 升至、降至、持平于 | 【 】 |
| CITY_PM_CHANGE/LABEL | 前一有效值至当前小时变化率绝对值及升幅/降幅 | 起点为0则百分数留空 |
| CITY_HIGH_HOURS/WINDOW | K⁺严格大于1的有效小时数、对应时刻列表 | 无数据留空；有数据但无高值，小时数0、时段留空 |
| CITY_PROCESS_COUNT/TIME | 尚未定义过程划分规则 | 保留【 】，不推断 |
| CITY_K_PEAK/PEAK_PM/MAX_RATIO | 触发日00时至触发小时有效K⁺峰值、对应小时PM2.5、配对比值最大值 | 【 】 |
| COMBUSTION_FINDING | 完整航次判读文件combustionConfirmed=true | 【 】 |
| TRIGGER | 精确航次匹配的事件/已保存原因 | 【 】；不采用任务名称或平台类型 |
| FLIGHT_WINDOW | 航次实际起止时间 | 验证失败阻止生成 |
| PHOTO_COUNT | 本航次实际归档照片数量 | 无照片0 |
| REVIEW_METHOD/ANOMALY_COUNT | 完整航次判读的reviewMethod/anomalyCount | 【 】，不将照片/分组数当异常处数 |
| 表1 | 匹配航线、实际时间、照片数量 | 未确认覆盖和异常留空 |
| 表2 | 时间、EXIF经纬度、XMP影像类型、按原图哈希绑定的location/description/result | 【 】 |
| 表4 | 实际执飞时段含端点，各参数有效值分别计算max/mean | 缺失不填0，无可飞模式保留两行空位 |
| CONCLUSION/RECOMMENDATION | 完整航次判读的conclusion/recommendation原文 | 【 】；不追加统计或默认文案 |

## 人工确认文件

沿用report-photo-reviews.json的localEventId、missionStart、missionEnd、photos（原图SHA-256键）、conclusion、recommendation。新增可选photos[hash].location、anomalyCount（非负整数）、combustionConfirmed（布尔，默认false）。reviewMethod填写可直接放入模板的短语，如“经人工复核”或确已进行的“经AI智能识别”。不从单张识别结果推断整体确认。完整集合不匹配时，不载入整体结论、建议、识别方式、异常数或燃烧判断。

## 照片规则

图1为代表照片；图2为整体离散拍摄位置图（不连线、不推断航迹），缺GPS留空。第三章全部照片沿用3秒分组、每组两张并排；图3起连续编号，标注表2序号。原图/标注合成图归档不变。平台空气曲线保留归档，不自动增入正文。

## 验收

运行Python模板保真及固定段落检查、Rust flight_report测试、Node报告相关测试。至少验证44张照片无可飞航次和有六参数航次，独立输出到验收目录；旧报告不覆盖。逐页渲染检查中文、图片、表格、分页。生成器改动不等同于运行客户端已采用新版本。

所有未填写的【 】及【待编】以红色显示，保留模板字体和字号，提醒人工核对。
