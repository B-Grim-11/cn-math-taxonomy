#!/usr/bin/env python3
"""校验 data/topics.json 与 data/dependencies.json（仅使用标准库）。

用法：python3 scripts/validate.py
全部通过时打印 "VALIDATION PASSED" 并以退出码 0 结束，否则退出码为 1。

课标对齐（data/cn-curriculum-standards.json）：
- 文件存在时，topic.standards[].id 必须出现在其 items[].id 中，confidence 只能是 exact / inferred；
- 正式知识点 standards 为空只打印 WARNING（至多列 30 个），不影响退出码；
  设置环境变量 STRICT_STANDARDS=1 时，此类空 standards 视为错误。
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict
from fractions import Fraction

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOPICS_PATH = os.path.join(ROOT, "data", "topics.json")
DEPS_PATH = os.path.join(ROOT, "data", "dependencies.json")
STANDARDS_PATH = os.path.join(ROOT, "data", "cn-curriculum-standards.json")
QUESTIONS_PATH = os.path.join(ROOT, "data", "questions.json")
STRICT_STANDARDS = os.environ.get("STRICT_STANDARDS") == "1"

MATH_DOMAINS = {"数与代数", "图形与几何", "统计与概率", "综合与实践"}
EN_DOMAINS = {"语音", "词汇", "语法", "日常表达", "读写"}
DOMAINS = MATH_DOMAINS | EN_DOMAINS
TYPES = {"conceptual", "procedural", "reasoning", "application", "modeling"}
STRENGTHS = {"hard", "soft"}
CONFIDENCES = {"exact", "inferred"}
MAX_STANDARDS_PER_TOPIC = 3
MAX_WARNINGS_LISTED = 30
STD_DOMAIN_CODES = {"NA": "数与代数", "GG": "图形与几何", "SP": "统计与概率", "IP": "综合与实践"}
STD_ID_RE = re.compile(r"^cms-2022:([1-4])\.(NA|GG|SP|IP)\.(\d{2,})$")
# 高中必修：cms-2017:H.<模块>.NN。模块不是领域代码（几何与代数横跨数与代数和图形与几何）。
HS_STD_ID_RE = re.compile(r"^cms-2017:H\.(PRE|FUN|GA|PS|MI)\.(\d{2,})$")
HS_STD_MODULES = ("PRE", "FUN", "GA", "PS", "MI")
EN_STD_CODES = {"PH": "语音", "VO": "词汇", "GR": "语法", "FU": "日常表达", "RW": "读写"}
EN_STD_ID_RE = re.compile(r"^ces-2022:([12])\.(PH|VO|GR|FU|RW)\.(\d{2,})$")
EN_PROMPT_START_RE = re.compile(r"^(同一|上题|该题|同上)")
EN_PROMPT_BAN_RE = re.compile(r"本知识点|课标|是否要求")
CORE_FIELDS = ["id", "name", "domain", "grade", "semester", "chapter", "type",
               "description", "mastery_criteria", "diagnostic_question", "external"]
EXT_FIELDS = ["id", "name", "domain", "grade", "description", "external"]
# cnm_001 初中正式；cnm_p001 小学正式；cnm_h001 高中正式。cne_p001 小学英语。cnm_ext_* 已迁到 data/id-aliases.json。
ID_RE = re.compile(r"^(?:cnm_(?:p|h)?|cne_p)\d{3,}$")
# 10、11 是必修第一、二册；12、13、14 是选择性必修第一、二、三册，不是教学年份。
GRADES = (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14)
ALIASES_PATH = os.path.join(ROOT, "data", "id-aliases.json")
ALIAS_ID_RE = re.compile(r"^cnm_ext_\d{3,}$")

errors = []
warnings = []


def err(msg):
    errors.append(msg)


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        err("文件不存在：%s" % path)
    except json.JSONDecodeError as e:
        err("JSON 不合法：%s（%s）" % (path, e))
    return None


def nonempty_str(v):
    return isinstance(v, str) and v.strip() != ""


def is_english_id(tid):
    return str(tid).startswith("cne_")


def topic_subject(tid):
    if is_english_id(tid):
        return "english"
    if str(tid).startswith("cnm_"):
        return "math"
    return ""


def volume_rank(topic):
    grade = topic.get("grade")
    if not isinstance(grade, int):
        return None
    return grade * 2 + (1 if topic.get("semester") == "下" else 0)


def english_prompt_problem(text):
    s = str(text or "").strip()
    if EN_PROMPT_START_RE.match(s):
        return "题干不能以「同一 / 上题 / 该题 / 同上」开头"
    if EN_PROMPT_BAN_RE.search(s):
        return "题干不能出现「本知识点 / 课标 / 是否要求」"
    return ""


def check_topics(topics):
    ids = {}
    if not isinstance(topics, list):
        err("topics.json 顶层必须是数组")
        return ids
    for i, t in enumerate(topics):
        where = "topics[%d]" % i
        if not isinstance(t, dict):
            err("%s 不是对象" % where)
            continue
        tid = t.get("id")
        if not nonempty_str(tid):
            err("%s 缺少 id" % where)
            continue
        where = "%s(%s)" % (tid, t.get("name", "?"))
        if tid in ids:
            err("id 重复：%s" % tid)
        ids[tid] = t
        if not ID_RE.match(tid):
            err("%s id 格式不合法" % where)
        ext = t.get("external")
        if not isinstance(ext, bool):
            err("%s 的 external 必须是布尔值" % where)
            continue
        if ext != ("_ext_" in tid):
            err("%s 的 external 与 id 前缀不一致" % where)
        fields = EXT_FIELDS if ext else CORE_FIELDS
        for f in fields:
            if f not in t:
                err("%s 缺少必填字段 %s" % (where, f))
            elif f not in ("mastery_criteria", "diagnostic_question", "external") and not nonempty_str(t[f]) \
                    and not (f == "grade" and isinstance(t[f], int)):
                err("%s 字段 %s 为空或类型错误" % (where, f))
        subj = topic_subject(tid)
        marked = t.get("subject")
        if subj == "english":
            if marked != "english":
                err("%s 英语知识点的 subject 必须是 english" % where)
            if t.get("domain") not in EN_DOMAINS:
                err("%s 英语 domain 取值非法：%r" % (where, t.get("domain")))
        else:
            if marked not in (None, "math"):
                err("%s 数学知识点不能标成其他学科：%r" % (where, marked))
            if t.get("domain") not in MATH_DOMAINS:
                err("%s domain 取值非法：%r" % (where, t.get("domain")))
        if ext:
            if t.get("grade") != "小学":
                err("%s 外部节点 grade 必须为 \"小学\"" % where)
            continue
        if t.get("grade") not in GRADES:
            err("%s grade 必须是 1–14 的整数（10、11 为必修两册，12–14 为选择性必修三册）" % where)
        if subj == "english" and t.get("grade") not in (3, 4, 5, 6):
            err("%s 小学英语 grade 必须是 3–6" % where)
        if t.get("semester") not in ("上", "下"):
            err("%s semester 必须是 上/下" % where)
        if t.get("type") not in TYPES:
            err("%s type 取值非法：%r" % (where, t.get("type")))
        mc = t.get("mastery_criteria")
        if not (isinstance(mc, list) and 2 <= len(mc) <= 3 and all(nonempty_str(x) for x in mc)):
            err("%s mastery_criteria 必须是 2-3 条非空字符串" % where)
        dq = t.get("diagnostic_question")
        if not (isinstance(dq, dict) and nonempty_str(dq.get("question")) and nonempty_str(dq.get("answer"))):
            err("%s diagnostic_question 必须含非空 question 与 answer" % where)
        if "root_reason" in t and not nonempty_str(t["root_reason"]):
            err("%s root_reason 为空" % where)
        if subj == "english" and isinstance(t.get("diagnostic_question"), dict):
            problem = english_prompt_problem(t["diagnostic_question"].get("question"))
            if problem:
                err("%s 诊断题%s" % (where, problem))
    return ids


def check_deps(deps, ids):
    prereqs = defaultdict(list)   # topic -> [prerequisite]
    dependents = defaultdict(list)
    seen = set()
    n_hard = n_soft = n_en_hard = n_en_soft = 0
    if not isinstance(deps, list):
        err("dependencies.json 顶层必须是数组")
        return prereqs, dependents, 0, 0, 0, 0
    for i, d in enumerate(deps):
        where = "dependencies[%d]" % i
        if not isinstance(d, dict):
            err("%s 不是对象" % where)
            continue
        a, b = d.get("topicId"), d.get("prerequisiteId")
        for f in ("topicId", "prerequisiteId", "strength", "reason"):
            if not nonempty_str(d.get(f)):
                err("%s 缺少或为空字段 %s" % (where, f))
        if a not in ids:
            err("%s topicId 不存在：%r" % (where, a))
        if b not in ids:
            err("%s prerequisiteId 不存在：%r" % (where, b))
        if a == b:
            err("%s 自环：%r" % (where, a))
        if d.get("strength") not in STRENGTHS:
            err("%s strength 取值非法：%r" % (where, d.get("strength")))
        elif d["strength"] == "hard":
            n_hard += 1
        else:
            n_soft += 1
        sa, sb = topic_subject(a), topic_subject(b)
        if sa and sb and sa != sb:
            err("%s 跨学科边：%s -> %s" % (where, a, b))
        if sa == "english" and d.get("strength") in STRENGTHS:
            if d["strength"] == "hard":
                n_en_hard += 1
            else:
                n_en_soft += 1
        if sa == "english" and sb == "english" and a in ids and b in ids:
            ra, rb = volume_rank(ids[a]), volume_rank(ids[b])
            if ra is not None and rb is not None and rb > ra:
                err("%s 英语先修年级或册次更晚：%s 依赖 %s" % (where, a, b))
        key = (a, b)
        if key in seen:
            err("%s 重复边：%s -> %s" % (where, a, b))
        seen.add(key)
        if a in ids and b in ids and a != b:
            prereqs[a].append(b)
            dependents[b].append(a)
    return prereqs, dependents, n_hard, n_soft, n_en_hard, n_en_soft


def find_cycle(ids, prereqs):
    WHITE, GREY, BLACK = 0, 1, 2
    color = {t: WHITE for t in ids}
    for start in ids:
        if color[start] != WHITE:
            continue
        stack = [(start, iter(prereqs.get(start, [])))]
        path = [start]
        color[start] = GREY
        while stack:
            node, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                color[node] = BLACK
                stack.pop()
                path.pop()
                continue
            if color[nxt] == GREY:
                return path[path.index(nxt):] + [nxt]
            if color[nxt] == WHITE:
                color[nxt] = GREY
                stack.append((nxt, iter(prereqs.get(nxt, []))))
                path.append(nxt)
    return None


def check_graph(ids, prereqs, dependents):
    cyc = find_cycle(ids, prereqs)
    if cyc:
        err("存在环路：" + " -> ".join("%s(%s)" % (c, ids[c].get("name")) for c in cyc))
    for tid, t in ids.items():
        has_pre = bool(prereqs.get(tid))
        has_dep = bool(dependents.get(tid))
        if not t.get("external") and not has_pre and not nonempty_str(t.get("root_reason")):
            err("%s(%s) 没有先修边，也没有 root_reason" % (tid, t.get("name")))
        if not has_pre and not has_dep:
            err("%s(%s) 完全孤立（既无先修也未被依赖）" % (tid, t.get("name")))


def report(ids, prereqs, dependents, n_hard, n_soft, n_en_hard, n_en_soft):
    core = [t for t in ids.values() if not t.get("external")]
    ext = [t for t in ids.values() if t.get("external")]
    math_core = [t for t in core if not is_english_id(t.get("id"))]
    en_core = [t for t in core if is_english_id(t.get("id"))]
    print("知识点总数：%d（正式 %d，小学外部 %d）" % (len(ids), len(core), len(ext)))
    print("其中数学 %d，小学英语 %d" % (len(math_core), len(en_core)))
    print("\n按 domain（数学正式知识点）：")
    for k, v in sorted(Counter(t["domain"] for t in math_core).items(), key=lambda x: -x[1]):
        print("  %-8s %d" % (k, v))
    print("\n按 grade+semester（数学正式知识点）：")
    zh = {1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八", 9: "九"}

    def vol_label(t):
        if t["grade"] == 10:
            return "高一必修一"
        if t["grade"] == 11:
            return "高二必修二"
        if t["grade"] == 12:
            return "选必一"
        if t["grade"] == 13:
            return "选必二"
        if t["grade"] == 14:
            return "选必三"
        return "%s%s" % (zh.get(t["grade"], t["grade"]), t["semester"])

    c = Counter(vol_label(t) for t in math_core)
    order = ["一上", "一下", "二上", "二下", "三上", "三下", "四上", "四下", "五上", "五下", "六上", "六下",
             "七上", "七下", "八上", "八下", "九上", "九下", "高一必修一", "高二必修二", "选必一", "选必二", "选必三"]
    for k in order:
        if c.get(k, 0) or k[0] in "七八九" or k.startswith("高") or k.startswith("选必"):
            print("  %-8s %d" % (k, c.get(k, 0)))
    n_pri = sum(1 for t in math_core if isinstance(t.get("grade"), int) and t["grade"] <= 6)
    n_jun = sum(1 for t in math_core if isinstance(t.get("grade"), int) and 7 <= t["grade"] <= 9)
    n_req = sum(1 for t in math_core if t.get("grade") in (10, 11))
    n_sel = sum(1 for t in math_core if isinstance(t.get("grade"), int) and t["grade"] >= 12)
    print("其中小学（1–6 年级）%d，初中（7–9 年级）%d，高中必修（10–11）%d，选择性必修（12–14）%d" % (
        n_pri, n_jun, n_req, n_sel))
    if en_core:
        print("\n小学英语按 domain：")
        for k, v in sorted(Counter(t["domain"] for t in en_core).items(), key=lambda x: -x[1]):
            print("  %-8s %d" % (k, v))
        print("小学英语按册：")
        ec = Counter(vol_label(t) for t in en_core)
        for k in ["三上", "三下", "四上", "四下", "五上", "五下", "六上", "六下"]:
            print("  %-8s %d" % (k, ec.get(k, 0)))
    print("\n按 type（正式知识点）：")
    for k, v in sorted(Counter(t["type"] for t in core).items(), key=lambda x: -x[1]):
        print("  %-12s %d" % (k, v))
    total = n_hard + n_soft
    print("\n先修边：%d 条（hard %d，soft %d）" % (total, n_hard, n_soft))
    if en_core:
        print("其中小学英语 %d 条（hard %d，soft %d），数学 %d 条" % (
            n_en_hard + n_en_soft, n_en_hard, n_en_soft, total - n_en_hard - n_en_soft))
    roots = [t["id"] for t in core if not prereqs.get(t["id"])]
    leaves = [t["id"] for t in core if not dependents.get(t["id"])]
    print("带 root_reason 的根节点：%d；未被任何知识点依赖的末端节点：%d" % (len(roots), len(leaves)))
    if core:
        print("正式知识点平均先修数：%.2f" % (sum(len(prereqs.get(t["id"], [])) for t in core) / len(core)))


def check_standards_file(std):
    """校验课标条目文件本身，返回 {id: item}。文件不存在时返回 None。"""
    if std is None:
        return None
    items_by_id = {}
    if not isinstance(std, dict):
        err("cn-curriculum-standards.json 顶层必须是对象")
        return items_by_id
    src = std.get("source")
    if not isinstance(src, dict):
        err("cn-curriculum-standards.json 缺少 source 对象")
    else:
        for f in ("title", "issuer", "stage", "url", "retrieved", "note"):
            if not nonempty_str(src.get(f)):
                err("source.%s 缺失或为空" % f)
        if not isinstance(src.get("year"), int):
            err("source.year 必须是整数")
    items = std.get("items")
    if not isinstance(items, list) or not items:
        err("cn-curriculum-standards.json 的 items 必须是非空数组")
        return items_by_id
    last = {}
    saw_english = False
    for i, it in enumerate(items):
        where = "standards.items[%d]" % i
        if not isinstance(it, dict):
            err("%s 不是对象" % where)
            continue
        sid = it.get("id")
        if not nonempty_str(sid):
            err("%s 缺少 id" % where)
            continue
        where = "%s(%s)" % (where, sid)
        if sid in items_by_id:
            err("课标条目 id 重复：%s" % sid)
        items_by_id[sid] = it
        m = STD_ID_RE.match(sid)
        hm = HS_STD_ID_RE.match(sid)
        em = EN_STD_ID_RE.match(sid)
        if m:
            stage, code, num = m.group(1), m.group(2), int(m.group(3))
            if it.get("domain") != STD_DOMAIN_CODES[code]:
                err("%s domain 与 id 中的领域代码不一致：%r" % (where, it.get("domain")))
            key = ("2022", stage, code)
            if num != last.get(key, 0) + 1:
                err("%s 编号在域内不连续（上一条为 %02d）" % (where, last.get(key, 0)))
            last[key] = num
        elif hm:
            code, num = hm.group(1), int(hm.group(2))
            if it.get("domain") not in MATH_DOMAINS:
                err("%s domain 取值非法：%r" % (where, it.get("domain")))
            key = ("2017", code)
            if num != last.get(key, 0) + 1:
                err("%s 编号在模块内不连续（上一条为 %02d）" % (where, last.get(key, 0)))
            last[key] = num
            if it.get("verbatim") is not False:
                err("%s 高中条目必须显式标 verbatim:false（原文未逐页核对）" % where)
        elif em:
            saw_english = True
            level, code, num = em.group(1), em.group(2), int(em.group(3))
            if it.get("domain") != EN_STD_CODES[code]:
                err("%s domain 与 id 中的领域代码不一致：%r" % (where, it.get("domain")))
            if level not in ("1", "2"):
                err("%s 英语课标级别必须是 1 或 2" % where)
            key = ("ces", level, code)
            if num != last.get(key, 0) + 1:
                err("%s 编号在级别和领域内不连续（上一条为 %02d）" % (where, last.get(key, 0)))
            last[key] = num
            if it.get("verbatim") is not False:
                err("%s 英语课标必须显式标 verbatim:false（原文未逐页核对）" % where)
            if it.get("page_or_ref") != "待核":
                err("%s 英语课标 page_or_ref 必须是「待核」，不能编页码" % where)
        else:
            err("%s id 格式不合法（应为 cms-2022:<学段>.<NA|GG|SP|IP>.<NN>、cms-2017:H.<PRE|FUN|GA|PS|MI>.<NN> 或 ces-2022:<1|2>.<PH|VO|GR|FU|RW>.<NN>）" % where)
        for f in ("domain", "section", "text"):
            if not nonempty_str(it.get(f)):
                err("%s 字段 %s 缺失或为空" % (where, f))
        if "verbatim" in it and not isinstance(it["verbatim"], bool):
            err("%s verbatim 必须是布尔值" % where)
        if nonempty_str(it.get("text")) and not re.search(r"[\u4e00-\u9fff]", it["text"]):
            err("%s text 必须是中文" % where)
    if saw_english:
        eng = std.get("english")
        if not isinstance(eng, dict):
            err("有英语课标条目，但缺少 english 对象")
        else:
            for f in ("title", "issuer", "stage", "note"):
                if not nonempty_str(eng.get(f)):
                    err("english.%s 缺失或为空" % f)
            if not isinstance(eng.get("year"), int):
                err("english.year 必须是整数")
    return items_by_id


def check_topic_standards(ids, std_items):
    """校验每个知识点的 standards 字段，返回 (被引用的课标 id 集合, 正式知识点中 standards 为空的列表)。"""
    cited = set()
    empty_core = []
    for tid, t in ids.items():
        where = "%s(%s)" % (tid, t.get("name"))
        core = not t.get("external")
        if "standards" not in t:
            if core:
                empty_core.append(t)
            continue
        sts = t["standards"]
        if not isinstance(sts, list):
            err("%s 的 standards 必须是数组" % where)
            continue
        if not sts and core:
            empty_core.append(t)
        if len(sts) > MAX_STANDARDS_PER_TOPIC:
            err("%s 的 standards 超过 %d 条" % (where, MAX_STANDARDS_PER_TOPIC))
        seen = set()
        for j, s in enumerate(sts):
            sw = "%s standards[%d]" % (where, j)
            if not isinstance(s, dict):
                err("%s 不是对象" % sw)
                continue
            sid = s.get("id")
            if not nonempty_str(sid):
                err("%s 缺少 id" % sw)
                continue
            if sid in seen:
                err("%s 重复引用课标条目 %s" % (where, sid))
            seen.add(sid)
            if std_items is None:
                err("%s 引用了 %s，但 data/cn-curriculum-standards.json 不存在" % (sw, sid))
            elif sid not in std_items:
                err("%s 的课标条目不存在于 cn-curriculum-standards.json：%s" % (sw, sid))
            else:
                cited.add(sid)
            if s.get("confidence") not in CONFIDENCES:
                err("%s confidence 只能是 exact 或 inferred：%r" % (sw, s.get("confidence")))
            if "note" in s and not nonempty_str(s["note"]):
                err("%s note 为空" % sw)
    return cited, empty_core


def report_standards(ids, std_items, cited, empty_core):
    core = [t for t in ids.values() if not t.get("external")]
    if std_items is None:
        print("\n课标对齐：未找到 data/cn-curriculum-standards.json，跳过")
        return
    c = Counter(it.get("domain") for it in std_items.values())
    std_order = ("数与代数", "图形与几何", "统计与概率", "综合与实践", "语音", "词汇", "语法", "日常表达", "读写")
    print("\n课标条目：%d 条（%s）" % (len(std_items), "，".join("%s %d" % (k, c[k]) for k in std_order if c[k])))
    n_ok = len(core) - len(empty_core)
    pct = 100.0 * n_ok / len(core) if core else 0.0
    print("正式知识点 standards 非空：%d / %d（%.1f%%）；standards 为空：%d" % (n_ok, len(core), pct, len(empty_core)))
    conf = Counter(s.get("confidence") for t in core for s in t.get("standards", []) if isinstance(s, dict))
    print("映射条数：exact %d，inferred %d；至少有一条 exact 的知识点 %d" % (
        conf.get("exact", 0), conf.get("inferred", 0),
        sum(1 for t in core if any(isinstance(s, dict) and s.get("confidence") == "exact" for s in t.get("standards", [])))))
    print("被至少一个知识点引用的课标条目：%d / %d；无对应知识点的课标条目：%d" % (
        len(cited), len(std_items), len(std_items) - len(cited)))
    if empty_core:
        label = "ERROR" if STRICT_STANDARDS else "WARNING"
        print("\n%s：以下正式知识点的 standards 为空（共 %d 个，至多列 %d 个）：" % (label, len(empty_core), MAX_WARNINGS_LISTED))
        for t in empty_core[:MAX_WARNINGS_LISTED]:
            print("  %s %s" % (t["id"], t.get("name")))
        if len(empty_core) > MAX_WARNINGS_LISTED:
            print("  ……另有 %d 个未列出" % (len(empty_core) - MAX_WARNINGS_LISTED))


# ---------------------------------------------------------------- 题库（data/questions.json）

Q_DIFFICULTIES = ("basic", "standard", "advanced")
Q_TYPES = ("numeric", "choice", "short", "self")
Q_FIELDS = {"id", "topicId", "difficulty", "type", "prompt", "answer", "choices", "accept",
            "explanation", "verify", "unordered", "fixed_from_source"}
Q_ID_RE = re.compile(r"^((?:cnm_(?:p|h)?|cne_p)\d{3,})_q([1-9]\d*)$")
NUM_RE = re.compile(r"^-?\d+(?:\.\d+)?(?:/\d+(?:\.\d+)?)?$")
MIN_QUESTIONS_PER_TOPIC = 3
MIN_AUTO_SHARE = 0.60


def parse_numeric_answer(s):
    """把 numeric 题的 answer 解析成 Fraction 列表；不合法返回 None。
    单个数：整数、小数、分数 a/b、负数；多个答案用全角「，」（或半角逗号）分隔。"""
    if not isinstance(s, str):
        return None
    parts = [p.replace(" ", "") for p in re.split(r"[，,]", s)]
    out = []
    for p in parts:
        if not NUM_RE.match(p):
            return None
        try:
            out.append(Fraction(p))
        except (ValueError, ZeroDivisionError):
            return None
    return out


def question_errors(questions, topics_by_id, require_coverage=True):
    """返回 (错误列表, 统计字典)。require_coverage=False 时用于单个批次文件（不要求每个知识点 >=3 题）。"""
    errs = []
    stats = {"total": 0, "by_type": Counter(), "by_difficulty": Counter(), "per_topic": Counter()}
    if not isinstance(questions, list):
        return ["questions.json 顶层必须是数组"], stats
    seen = set()
    by_topic = defaultdict(list)
    for i, q in enumerate(questions):
        w = "questions[%d]" % i
        if not isinstance(q, dict):
            errs.append("%s 不是对象" % w)
            continue
        qid = q.get("id")
        if not nonempty_str(qid):
            errs.append("%s 缺少 id" % w)
            continue
        w = qid
        if qid in seen:
            errs.append("%s id 重复" % w)
        seen.add(qid)
        m = Q_ID_RE.match(qid)
        if not m:
            errs.append("%s id 格式应为 <topicId>_q<N>" % w)
        unknown = set(q) - Q_FIELDS
        if unknown:
            errs.append("%s 含未知字段：%s" % (w, "、".join(sorted(unknown))))
        tid = q.get("topicId")
        t = topics_by_id.get(tid) if isinstance(tid, str) else None
        if t is None:
            errs.append("%s 的 topicId 不存在：%r" % (w, tid))
        elif t.get("external"):
            errs.append("%s 的 topicId 是外部节点（外部节点不出题）：%s" % (w, tid))
        if m and tid != m.group(1):
            errs.append("%s 的 id 前缀与 topicId(%r) 不一致" % (w, tid))
        for f in ("difficulty", "type", "prompt", "answer", "explanation"):
            if not nonempty_str(q.get(f)):
                errs.append("%s 字段 %s 缺失或为空（answer 必须是字符串）" % (w, f))
        if is_english_id(tid):
            problem = english_prompt_problem(q.get("prompt"))
            if problem:
                errs.append("%s %s" % (w, problem))
        diff, typ = q.get("difficulty"), q.get("type")
        if nonempty_str(diff) and diff not in Q_DIFFICULTIES:
            errs.append("%s difficulty 取值非法：%r" % (w, diff))
        if nonempty_str(typ) and typ not in Q_TYPES:
            errs.append("%s type 取值非法：%r" % (w, typ))
        if "accept" in q:
            acc = q["accept"]
            if not (isinstance(acc, list) and all(nonempty_str(x) for x in acc)):
                errs.append("%s accept 必须是非空字符串数组" % w)
        if "verify" in q and not nonempty_str(q["verify"]):
            errs.append("%s verify 必须是非空字符串" % w)
        if "unordered" in q and not (q["unordered"] is True and typ == "numeric"):
            errs.append("%s unordered 只能用于 numeric 题且取值为 true" % w)
        if "fixed_from_source" in q and not nonempty_str(q["fixed_from_source"]):
            errs.append("%s fixed_from_source 为空" % w)
        ans = q.get("answer")
        if typ == "choice":
            ch = q.get("choices")
            if not (isinstance(ch, list) and 3 <= len(ch) <= 4):
                errs.append("%s choice 题必须有 3–4 个选项" % w)
            else:
                keys = []
                texts = []
                for c in ch:
                    if not (isinstance(c, dict) and nonempty_str(c.get("key")) and nonempty_str(c.get("text"))
                            and set(c) <= {"key", "text"}):
                        errs.append("%s 选项必须形如 {key, text} 且非空" % w)
                        break
                    keys.append(c["key"])
                    texts.append(c["text"].strip())
                else:
                    if len(set(keys)) != len(keys):
                        errs.append("%s 选项 key 重复" % w)
                    if keys != list("ABCD")[:len(keys)]:
                        errs.append("%s 选项 key 必须依次为 A、B、C、D：%r" % (w, keys))
                    if len(set(texts)) != len(texts):
                        errs.append("%s 选项文字重复" % w)
                    if nonempty_str(ans) and ans not in keys:
                        errs.append("%s answer(%r) 不是任何一个选项的 key" % (w, ans))
        elif "choices" in q:
            errs.append("%s 只有 choice 题可以带 choices" % w)
        if typ == "numeric" and nonempty_str(ans):
            vals = parse_numeric_answer(ans)
            if vals is None:
                errs.append("%s numeric 题 answer 不是可解析的数：%r" % (w, ans))
            elif len(vals) == 1 and q.get("unordered") is True:
                errs.append("%s 只有一个答案时不应写 unordered" % w)
        if isinstance(tid, str):
            by_topic[tid].append(q)
        if nonempty_str(typ):
            stats["by_type"][typ] += 1
        if nonempty_str(diff):
            stats["by_difficulty"][diff] += 1
        stats["total"] += 1
    for tid, qs in by_topic.items():
        stats["per_topic"][tid] = len(qs)
    if require_coverage:
        for tid, t in topics_by_id.items():
            if t.get("external"):
                continue
            qs = by_topic.get(tid, [])
            if len(qs) < MIN_QUESTIONS_PER_TOPIC:
                errs.append("%s(%s) 只有 %d 道题，至少需要 %d 道" % (tid, t.get("name"), len(qs), MIN_QUESTIONS_PER_TOPIC))
            ds = {q.get("difficulty") for q in qs}
            if qs and not {"basic", "standard"} <= ds:
                errs.append("%s(%s) 的难度需至少含 basic 和 standard" % (tid, t.get("name")))
            q1 = [q for q in qs if q.get("id") == tid + "_q1"]
            dq = (t.get("diagnostic_question") or {}).get("question")
            if qs and not q1:
                errs.append("%s 缺少 %s_q1（应由 diagnostic_question 迁移）" % (tid, tid))
            elif q1 and nonempty_str(dq) and "fixed_from_source" not in q1[0] \
                    and not str(q1[0].get("prompt", "")).startswith(dq):
                errs.append("%s_q1 的题干应以 topics.json 的 diagnostic_question.question 开头" % tid)
    return errs, stats


def report_questions(stats, topics_by_id):
    core = [tid for tid, t in topics_by_id.items() if not t.get("external")]
    counts = [stats["per_topic"].get(tid, 0) for tid in core]
    print("\n题库：共 %d 题" % stats["total"])
    print("按 type：" + "，".join("%s %d" % (k, stats["by_type"].get(k, 0)) for k in Q_TYPES))
    print("按 difficulty：" + "，".join("%s %d" % (k, stats["by_difficulty"].get(k, 0)) for k in Q_DIFFICULTIES))
    auto = stats["by_type"].get("numeric", 0) + stats["by_type"].get("choice", 0)
    if stats["total"]:
        print("numeric + choice 占比：%.1f%%" % (100.0 * auto / stats["total"]))
    if counts:
        dist = Counter(counts)
        print("每知识点题数：最少 %d，最多 %d，平均 %.2f；分布 %s" % (
            min(counts), max(counts), sum(counts) / float(len(counts)),
            "，".join("%d 题×%d" % (k, dist[k]) for k in sorted(dist))))


def check_aliases(ids):
    """data/id-aliases.json：旧 cnm_ext_* 必须映射到仍存在的小学正式知识点。"""
    if not os.path.exists(ALIASES_PATH):
        err("缺少 data/id-aliases.json（旧 cnm_ext_* 的跳转表）")
        return
    data = load(ALIASES_PATH)
    if not isinstance(data, dict):
        return
    aliases = data.get("aliases")
    if not isinstance(aliases, dict) or not aliases:
        err("id-aliases.json 的 aliases 必须是非空对象")
        return
    for i in range(1, 19):
        key = "cnm_ext_%03d" % i
        if key not in aliases:
            err("id-aliases.json 缺少旧节点 %s" % key)
    for key, spec in aliases.items():
        if not ALIAS_ID_RE.match(key):
            err("别名 id 格式不合法：%s" % key)
        if key in ids:
            err("别名 %s 仍作为知识点存在，应只出现在 id-aliases.json" % key)
        targets = spec.get("targets") if isinstance(spec, dict) else None
        if not (isinstance(targets, list) and targets):
            err("别名 %s 的 targets 必须是非空数组" % key)
            continue
        if len(set(targets)) != len(targets):
            err("别名 %s 的 targets 有重复" % key)
        for tid in targets:
            t = ids.get(tid)
            if t is None:
                err("别名 %s 指向不存在的知识点 %s" % (key, tid))
            elif t.get("external") or not (isinstance(t.get("grade"), int) and t["grade"] <= 6):
                err("别名 %s 必须指向小学正式知识点，而不是 %s" % (key, tid))
        if isinstance(spec, dict) and not nonempty_str(spec.get("name")):
            err("别名 %s 缺少原名称 name" % key)


def main():
    topics = load(TOPICS_PATH)
    deps = load(DEPS_PATH)
    if topics is None or deps is None:
        for e in errors:
            print("错误：" + e)
        print("VALIDATION FAILED")
        return 1
    ids = check_topics(topics)
    check_aliases(ids)
    prereqs, dependents, n_hard, n_soft, n_en_hard, n_en_soft = check_deps(deps, ids)
    check_graph(ids, prereqs, dependents)
    std_items = None
    if os.path.exists(STANDARDS_PATH):
        std_items = check_standards_file(load(STANDARDS_PATH))
    cited, empty_core = check_topic_standards(ids, std_items)
    if STRICT_STANDARDS and std_items is not None and empty_core:
        err("STRICT_STANDARDS=1：%d 个正式知识点的 standards 为空" % len(empty_core))
    report(ids, prereqs, dependents, n_hard, n_soft, n_en_hard, n_en_soft)
    report_standards(ids, std_items, cited, empty_core)
    if os.path.exists(QUESTIONS_PATH):
        qs = load(QUESTIONS_PATH)
        if qs is not None:
            qerrs, qstats = question_errors(qs, ids, require_coverage=True)
            for e in qerrs:
                err("题库：" + e)
            auto = qstats["by_type"].get("numeric", 0) + qstats["by_type"].get("choice", 0)
            if qstats["total"] and auto < MIN_AUTO_SHARE * qstats["total"]:
                err("题库：numeric + choice 占比 %.1f%% < %d%%" % (100.0 * auto / qstats["total"], MIN_AUTO_SHARE * 100))
            report_questions(qstats, ids)
    else:
        print("\n题库：未找到 data/questions.json，跳过")
    print()
    if errors:
        for e in errors:
            print("错误：" + e)
        print("\n共 %d 个错误" % len(errors))
        print("VALIDATION FAILED")
        return 1
    print("VALIDATION PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
