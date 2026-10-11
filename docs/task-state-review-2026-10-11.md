# 任务状态流转审查（2026-10-11）

审查对象为当前工作区（含已有未提交修改），覆盖 Rust 巡飞状态机、Chrome 插件提交与状态读取、前端操作入口、重启恢复，以及任务历史和报告列表衔接。首次审查确认 4 类缺陷，随后按用户要求全部修复；下文问题与覆盖表记录修复前的证据，文末记录修复及自测结果。未操作真实平台任务。

## 已确认的问题

### 1. P1：人工确认任务进入 ready 后无法继续跟踪

- 位置：`src-tauri/src/flight.rs:237–238、324–326、379–384`；`src/components/DroneStatus.tsx:57–59、97–108`。
- 触发：开启“起飞前人工确认”（默认设置），自动准备完成，用户按提示到司空确认起飞。
- 实际：后台只轮询 `submitted/uncertain/flying/paused`，`ready` 不在其中；即使传入匹配任务的“执行成功”，`apply_observation` 也直接忽略。界面没有刷新、取消或结束此状态的入口；新的手动和自动任务均被阻塞。重启保留 `ready`，不能恢复。
- 演练同样停留 `ready`，需要独立的“结束演练”出口，不能把演练直接并入真实起飞轮询。
- 修复方向：为真实人工确认任务提供匹配平台结果的只读跟踪；为未提交草稿/演练提供有明确语义的结束方式。不能仅把 `ready` 当终态放开重发，因为用户可能已经在平台提交。
- 复现：`review_ready_accepts_platform_completion_after_human_submit` 期望 `completed`，实际为 `ready`。

### 2. P1：执飞异常进入 flight_error 后形成无法处理的占用

- 位置：`src-tauri/src/flight.rs:326、333、384、479`；`src/components/DroneStatus.tsx:57–59、103–108`。
- 触发：平台回报“部分执行”“执行失败”或“执行终止”。
- 实际：状态变为 `flight_error` 后退出轮询，同时不属于终态；界面只有打开司空入口，没有刷新或核查后结束入口。即使平台后来明确成功，本地仍忽略结果；已明确结束的失败任务也会一直阻塞下一次任务。重启无恢复路径。
- 修复方向：区分仍需跟踪的异常与已确认结束的失败；提供持续核查和核查后的结束/归档动作。不能把所有执飞异常无条件视为可立即再次起飞。
- 复现：`review_flight_error_can_reconcile_later_platform_success` 先进入 `flight_error`，随后提供匹配的“执行成功”，期望 `completed`，实际仍为 `flight_error`。

### 3. P1：not_flown 阻塞后续新的自动超标轮次

- 位置：`src-tauri/src/flight.rs:83、179–186、345–353`。
- 触发：提交结果待核查，读取到原草稿明确天气阻飞回执后变成 `not_flown`；随后 K⁺ 恢复正常，再出现新的有效超标小时，天气与自动开关均允许执行。
- 实际：正常值已清空 `flight_episode`，但 `not_flown` 不在 `terminal()` 中，自动调度继续被当前事件占用检查拦截。手动入口单独允许覆盖此状态，因此手动可用、自动却持续不恢复；不是同一轮超标不重试的问题。
- 修复方向：统一 `not_flown` 的终态语义，同时保留原小时去重与当前超标轮次抑制，允许正常数据重新武装后的新轮次运行。
- 复现：`review_not_flown_allows_a_new_episode_after_normal_hour` 验证正常小时已清空轮次标记，新超标仍返回 `None`。

### 4. P2：新任务覆盖 completed/canceled 等旧事件，遗漏历史归档

- 位置：`src-tauri/src/flight.rs:192–198、475–484`。
- 触发：任务完成后创建下一次手动任务，或者正常小时后再次超标创建下一次自动任务。
- 实际：两条路径均直接写入单例 `flight_event`；手动路径只在失败重试时归档，自动路径只在特定失败/禁飞分支归档。一般的完成事件没有保存至 `flight_history:<id>`，被覆盖后其本地状态、起飞检查天气快照和核查回执从任务历史中消失。已保存的 Word 文件不因此删除，但平台任务和后补天气不能恢复这份本地决策证据。
- 修复方向：所有替换当前事件的入口统一在同一事务内归档旧事件、写入新事件；处理“收起提醒”时保留原始执行结果。
- 复现：`review_completed_manual_task_is_retained_when_next_task_begins` 和 `review_completed_auto_task_is_retained_on_next_episode` 均确认新任务已创建、旧事件对应历史键不存在。

## 状态覆盖表

| 当前状态 | 当前主要出口 | 审查结论 |
| --- | --- | --- |
| 无当前任务 | 有效超标创建 countdown；手动创建 preparing | 创建前有有效数据、天气、禁飞及占用检查 |
| countdown | preparing / canceled / restricted | 已有测试覆盖到期、取消、切换人工确认和禁飞；重启取消 |
| preparing | ready / submitting / failed / canceled / restricted | 提交前再次检查当前任务与状态；重启转 failed |
| ready | 仅打开司空 | 缺陷 1；人工确认与演练均缺闭环 |
| submitting | submitted / uncertain / canceled | 不确定结果不自动重试；重启转 uncertain |
| submitted | flying / paused / completed / flight_error | 通过匹配平台回执推进 |
| uncertain | submitted / flying / paused / completed / flight_error / not_flown / 手动刷新后移入历史 | “手动刷新未识别到状态时解除占用”为当前文档明确规定的行为；它不证明未起飞 |
| flying / paused | flying / paused / completed / flight_error | 持续只读轮询；缺行保持原状态 |
| flight_error | 仅打开司空 | 缺陷 2；既不跟踪又不释放 |
| not_flown | 手动新任务 | 缺陷 3；后续自动轮次不能恢复 |
| failed | 确认后手动重试 / dismissed；自动失败遇更新有效小时重新判断 | 已有测试覆盖失败快照和同小时去重 |
| restricted | 历史展示 / 新有效小时再判断 | 既有禁飞边界与不补飞测试通过 |
| completed / canceled / dismissed | 允许新的任务，受轮次去重约束 | 缺陷 4；替换缺少统一归档 |
| 报告读取 / 核对 / 保存 | run 锁和 finally 释放 busy，保存状态独立于飞行结果 | 已审查相关前端代码及任务列表测试；本次没有生成真实报告作为验收 |

## 验证结果与限制

- 原工作区：`cargo test --manifest-path src-tauri/Cargo.toml --lib flight::tests`，35/35 通过。
- 原工作区：`pnpm exec vitest run tests/drone.test.tsx tests/manual-launch.test.tsx tests/settings-flight.test.tsx tests/patrol-report.test.tsx`，64/64 通过。
- 原工作区：`node --test tests/flight-plan.test.mjs tests/extension.test.mjs`，25/25 通过。
- 隔离副本：在原有 `flight::tests` 模块加入 5 个表达正确行为的断言，5/5 失败，分别复现上述 4 类问题。测试使用内存 SQLite，不连接真实司空，不调用实际提交。
- 复现用例存放于 `output/task-state-review-20261011/repro-tests.rs`。修复后这 5 个用例已纳入 `src-tauri/src/flight.rs` 的既有 `tests` 模块，直接执行 `cargo test --manifest-path src-tauri/Cargo.toml --lib flight::tests::review_ -- --nocapture`。首次复现在隔离副本执行；修复后用例作为正常回归测试保留，现已全部通过。
- 这份结论是源码审查与隔离状态机复现证据，不代表真实客户端、已加载插件或实飞验收。现有全绿测试没有覆盖这些跨状态边界。


## 修复与自测结果

2026-10-11 已修复上述 4 类缺陷：

1. `ready`（排除演练）及 `flight_error` 统一进入 `trackable()`，后台轮询、手动刷新和结果写入使用同一条件；待执行、执行中、暂停、结束均能继续更新。演练有独立的结束入口。
2. 新增 `resolve_flight` 和确认弹窗。真实待确认或执飞异常任务须人工核实后才能结束本地处理；校验原任务 ID、原状态和确认标记。活动中的其他状态不能通过此命令解除占用。
3. `not_flown` 纳入终态，同时在天气阻飞回执落库时保留本轮抑制，避免立即自动重试；有效正常小时数据之后的新超标轮次可自动创建任务。
4. 新任务替换统一通过事务内的 `replace_current()`，保留旧任务与天气证据。收起失败提醒和核查结束同样归档原状态并记录 `resolvedAt`，不再用 `dismissed` 覆盖真实结果。

最终自测：

| 检查 | 结果 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 78 通过，0 失败；2 个既有外部验收测试忽略 |
| `pnpm test:ui` | 95 通过，0 失败 |
| `pnpm test` | 65 通过，0 失败 |
| `pnpm build` | TypeScript 与 Vite 构建通过 |

新增 9 个 Rust 回归测试（包含原 5 个失败复现用例）及 5 个界面测试。覆盖正常恢复、演练隔离、重启后继续跟踪、无匹配状态不自动释放、确认期间状态变化、重复点击、已知活动任务不可结束、写入失败整体回滚、历史与天气保留。

两个忽略项分别是需要真实报告夹具的 DOCX 验收和实时 Open-Meteo 网络检查；本次没有重启客户端、重新加载插件或执行实飞，自动化自测不替代这些现场验收。
