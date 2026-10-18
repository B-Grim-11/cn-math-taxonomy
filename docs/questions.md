# 题库说明（data/questions.json）

给每个正式知识点（315 个；小学外部节点不出题）建的小题库，供 `diagnose/` 诊断工具按「每个知识点最多 2 题」的规则出题。**题目与答案全部由 AI 生成，没有教师审核**；正确性靠下面的自动核验与独立复核尽量保证，但不等于权威答案。

## 格式

`data/questions.json` 是一个 JSON 数组，每题一个对象：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | `<topicId>_q<N>`，如 `cnm_221_q2`；`_q1` 由 `topics.json` 的 `diagnostic_question` 迁移而来（题干以原题文字开头，必要时在后面追加答案格式说明） |
| `topicId` | 是 | 知识点 id，必须是正式知识点 |
| `difficulty` | 是 | `basic`（直接套定义 / 一步计算）、`standard`（课本例题水平，2–3 步）、`advanced`（综合、多步或易错点） |
| `type` | 是 | `numeric` 数值题、`choice` 选择题、`short` 短答题、`self` 开放题（必须自评） |
| `prompt` | 是 | 中文题干，自包含、纯文字（不依赖图形；几何条件用文字、长度、角度、坐标写全）。单位写在题干里，答案不带单位 |
| `answer` | 是 | 字符串。numeric：一个数（整数 / 小数 / 分数 `a/b` / 负数），多个答案用全角「，」分隔；choice：正确选项字母；short：标准短答案；self：参考答案 |
| `choices` | choice 必填 | `[{"key":"A","text":"…"}, …]`，3–4 个选项，key 依次为 A、B、C、D，选项文字互不相同 |
| `accept` | 否 | short（也可用于 numeric）的等价答案列表 |
| `explanation` | 是 | 1–3 句中文解析，答题后显示 |
| `verify` | 否 | 一个 Python 表达式字符串，用于机器核验 `answer`（见下） |
| `unordered` | 否 | numeric 且多个答案顺序无关时为 `true`（如方程的两个根）；没有这个字段的多答案题按顺序比较 |
| `fixed_from_source` | 否 | 迁移 `diagnostic_question` 时补充了条件（原题有歧义）才有，写明原因。目前 3 题：`cnm_061_q1`、`cnm_070_q1`、`cnm_253_q1` |

`topics.json` 里的 `diagnostic_question` 原样保留（兼容；题库缺失时诊断工具回退到它）。

## 统计（`python3 scripts/validate.py` / `verify_questions.py` 输出）

- 总数 **1407** 题，覆盖全部 315 个正式知识点；每个知识点 4 题（168 个）或 5 题（147 个），最少 4、最多 5、平均 4.47。
- 按 type：numeric 903，choice 475，short 23，self 6；**numeric + choice 占 97.9%**。
- 按 difficulty：basic 591，standard 537，advanced 279。每个知识点都含 basic 和 standard，并且除 q1 之外至少还有一道 basic（诊断时「第二题优先出 basic」要用）。
- choice 的正确选项分布：A 124，B 126，C 126，D 99；101 题 3 个选项，374 题 4 个选项。

## 核验方法

### 1. 自动核验：`python3 scripts/verify_questions.py`

numeric 和 choice 题可以带 `verify` 表达式，脚本在**受限环境**里求值（Python `ast` 白名单：四则运算、`**`、`//`、`%`、比较、列表 / 元组 / 推导式、下标；只能调用 `Fraction sqrt pi sin cos … comb perm gcd lcm sum min max sorted range ceil floor mean median pvariance …`，外加 `solve2`（解二元一次方程组，精确分数）、`roots2`（一元二次方程实根）；没有 import、属性访问、赋值，单次求值 2 秒超时），再与 `answer` 比较：

- numeric：结果与 `answer` 逐项比较；整数 / 分数结果**精确比较**，浮点结果容差 1e-9；多个答案按 `unordered` 决定是否顺序无关；
- choice：结果与**正确选项的内容**比较（选项是数时按数值比较，否则要求文字完全相同），同时要求没有第二个选项与它相同（防双解）。

脚本会同时做格式检查，输出 `auto_verified`（有 verify 且通过）、`mismatch`、`unverifiable`，明细写入 `data/verification_report.json`。当前：

| 项 | 数量 |
|---|---|
| numeric + choice 题 | 1378 |
| **auto_verified**（有 verify 且通过） | **875**（占 numeric + choice 的 63.5%） |
| **mismatch** | **0** |
| unverifiable（无 verify） | 532：choice 464（选项是文字 / 式子，没法用表达式算）、numeric 39（推理型）、short 23、self 6 |

自动核验的局限：`verify` 是出题者自己写的，可能和答案「同源」（算法写错一样会错）；个别题的 verify 只是把常数列出来（出题者在备注里标注过 `cnm_248_q4`、`cnm_093_q5`），这类题的保证主要来自第二遍独立复核。

### 2. 独立第二遍复核：`scripts/second_pass.py`

由**没看到答案**的独立解题者（Claude 子任务）重新解题，再逐题与题库比对：

- 把 numeric / choice / short 题去掉 `answer`、`explanation`、`verify`、`accept`，只留题干和选项，分块给解题者（`second_pass.py prepare`）；解题者只能读自己的那一块，我核对过他们的工具调用记录，没有读过题库或其它文件；
- **A 轮（全量）**：19 个解题者，1401 道题（numeric 903、choice 475、short 23），一次性作答；
- **B 轮（风险题，更仔细）**：16 个解题者，752 道题——所有没有 `verify` 的 numeric / choice / short 题加上全部 `advanced` 题；要求分小批逐题推理、非平凡的计算用 Python 精确算、每题写出推导（`work_b_NN.json`）；
- 解题者的原始答案、推导和存疑备注保留在 `data/_second_pass/`（`ans_NN.json`、`ans_b_NN.json`、`work_b_NN.json`、`notes_NN.json`、`mismatches*.json`），题干分块文件（`blind_*.json`）可随时用 `second_pass.py prepare` 重新生成；
- `second_pass.py compare` 比对：choice 比字母，numeric 比数值（有序 / 无序），short 规范化后比 `answer` + `accept`；不一致的逐条裁决。

结果（详见 `data/verification_report.json` 的 `second_pass` 与 `data/second_pass_log.json`）：

- A 轮 3 处不一致（`cnm_090_q3`、`cnm_213_q4`、`cnm_311_q4`），我用精确计算逐条裁决，**3 处都是解题者算错，题库答案正确**；B 轮 0 处不一致。
- **发现并修正答案错误：0 处**。发现并修正的其它问题 5 处：4 处题干含糊（解题者提示后改写）、1 处解析写错。例：
  - `cnm_133_q2`「到线段 AB 两个端点距离相等的点，一定在：」只在平面内成立 → 补「在同一平面内」；
  - `cnm_053_q3` 题干写「图中……」却没有图 → 删去「图中」；
  - `cnm_306_q2` 样本方差除以 n 还是 n−1 有口径之分 → 写明「各数据与平均数之差的平方的平均数」；
  - `cnm_151_q3` 解析把正确选项 C 写成「没提干净」→ 由「解析里选项字母与答案矛盾」的扫描发现并改正。
- 解题者另外标出 16 条「存疑」，逐条看过：除上面 4 处外，题干条件已足以唯一确定答案，不改。
- 报告里 `mismatch = 0`，`second_pass_mismatch = []`。
- 出题阶段每位出题者交稿前自己跑过 `verify_questions.py --file`（要求 mismatch = 0，格式错误 = 0）；这一步里被他们自己改掉的问题没有留下记录，所以不计入上面的「修正」数字。

### 3. 格式校验：`python3 scripts/validate.py`

题 id 唯一且与 topicId 一致；topicId 存在且不是外部节点；`difficulty` / `type` 合法；choice 有 3–4 个选项、key 依次为 A–D 且不重复、answer 是某个 key、选项文字不重复；numeric 的 answer 能解析成数（含分数、负数、多值）；必填字段非空；没有未知字段；每个正式知识点 ≥ 3 题且含 basic 与 standard；q1 存在且题干以 `diagnostic_question` 开头（或带 `fixed_from_source`）；numeric + choice 占比 ≥ 60%。打印题量统计。

## 局限

- **没有教师审核**；独立复核的解题者与出题者是同一模型家族，如果对某个知识点有共同的误解，这种错误两边都不会暴露。「0 处答案错误」说明没有发现分歧，不是「保证无错」。
- 约 36% 的 numeric + choice 题没有 `verify`，主要是选项为文字 / 式子的选择题，它们只靠独立复核保证。
- 题干纯文字，不能画图：几何题用文字描述条件，没有图形题、作图题、证明题（证明思路类用 choice 或 `self`）。
- **选择题干扰项**只对应「典型错误」的猜测，没有真实学生数据校准；难度标注（basic / standard / advanced）是出题者的主观判断，同一难度内也没有区分度数据。
- 每个知识点只有 4–5 题：重测几次后会重复（诊断工具会优先出没出过的题，出完才重复）；也不足以支撑严肃的测评。
- numeric 答案限于有理数（含小数），含根号、π 的答案只能做成选择题；short 题（23 道）和 self 题（6 道）靠规范化精确匹配或自评，等价写法可能被判成「需自评」。
- 批次文件（出题者的中间产物）合并后已删除；题库现在是唯一来源，要改题直接改 `data/questions.json`，再跑 `verify_questions.py` 和 `validate.py`。
