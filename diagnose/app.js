/* 诊断小工具界面。核心逻辑全部在 engine.js，这里只负责数据加载、渲染与本地存储。 */
(function () {
  'use strict';
  const E = window.DiagEngine;
  const LS_SESSION = 'cnmDiagnose.session.v2';
  const LS_SETTINGS = 'cnmDiagnose.settings.v2';
  const LS_SEEN = 'cnmDiagnose.seen.v1';
  const LIMIT_MIN = 8, LIMIT_MAX = 30;
  const VOLUMES = [
    ['一上', '一年级上册'], ['一下', '一年级下册'], ['二上', '二年级上册'], ['二下', '二年级下册'],
    ['三上', '三年级上册'], ['三下', '三年级下册'], ['四上', '四年级上册'], ['四下', '四年级下册'],
    ['五上', '五年级上册'], ['五下', '五年级下册'], ['六上', '六年级上册'], ['六下', '六年级下册'],
    ['七上', '七年级上册'], ['七下', '七年级下册'], ['八上', '八年级上册'], ['八下', '八年级下册'],
    ['九上', '九年级上册'], ['九下', '九年级下册']
  ];
  const RESULT_LABEL = { correct: '对', wrong: '错', skip: '不会' };
  const STATUS_LABEL = { mastered: '已掌握', shaky: '不稳', weak: '薄弱', unknown: '未测' };
  const DIFF_LABEL = { basic: '基础', standard: '标准', advanced: '提高' };
  const TYPE_LABEL = { numeric: '数值题', choice: '选择题', short: '短答题', self: '开放题', legacy: '诊断题' };

  const root = document.getElementById('root');
  let D = null;            // 数据：{topics, deps, stdById, graph, tree}
  let session = null;      // 引擎会话
  let sessionMeta = null;  // {label, chapterKey?}
  let demo = null;         // 演示模式：{oracle}
  let ui = { key: null, phase: 'ask', answer: '', verdict: null };
  let startQuery = '';
  let startStage = '';
  let seedParam = null;    // URL 参数 seed：固定选题的随机种子

  /* ------------------------------------------------------------ 小工具 */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    const a = attrs || {};
    Object.keys(a).forEach(function (k) {
      const v = a[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'open' || k === 'disabled' || k === 'selected' || k === 'value') el[k] = v === true ? true : v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    const a = attrs || {};
    Object.keys(a).forEach(function (k) { if (a[k] != null) el.setAttribute(k, a[k]); });
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 隐私模式等 */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function nameOf(id) { const t = D.graph.byId[id]; return t ? t.name : id; }
  function getSettings() {
    const st = lsGet(LS_SETTINGS) || {};
    let limit = parseInt(st.limit, 10);
    if (!(limit >= LIMIT_MIN && limit <= LIMIT_MAX)) limit = E.DEFAULT_LIMIT;
    return { limit: limit };
  }
  function seenList() { const v = lsGet(LS_SEEN); return Array.isArray(v) ? v : []; }
  function markSeen(qid) {
    if (!qid || demo) return;
    const v = seenList();
    if (v.indexOf(qid) < 0) { v.push(qid); lsSet(LS_SEEN, v); }
  }
  function newSeed() { return seedParam != null ? seedParam : Math.random().toString(36).slice(2, 10); }
  function resetUi() { ui = { key: null, phase: 'ask', answer: '', verdict: null, picked: null }; }
  function clearRoot() { while (root.firstChild) root.removeChild(root.firstChild); }
  function show(node) { clearRoot(); root.append(node); window.scrollTo(0, 0); }

  /* ------------------------------------------------------------ 数据 */
  async function loadData() {
    const urls = ['../data/topics.json', '../data/dependencies.json', '../data/cn-curriculum-standards.json', '../data/id-aliases.json'];
    const rs = await Promise.all(urls.map(function (u) { return fetch(u); }));
    rs.forEach(function (r, i) { if (!r.ok) throw new Error(urls[i] + ' → HTTP ' + r.status); });
    const js = await Promise.all(rs.map(function (r) { return r.json(); }));
    // 题库可选：缺失（404）或损坏时回退到 topics.json 的 diagnostic_question
    let questions = null;
    try {
      const qr = await fetch('../data/questions.json');
      if (qr.ok) questions = await qr.json();
    } catch (e) { questions = null; }
    const stdById = {};
    js[2].items.forEach(function (x) { stdById[x.id] = x; });
    const graph = E.buildGraph(js[0], js[1], questions);
    D = { topics: js[0], deps: js[1], stdById: stdById, graph: graph, tree: buildTree(js[0]), aliases: (js[3] && js[3].aliases) || {} };
  }

  function buildTree(topics) {
    const vols = {};
    topics.forEach(function (t) {
      if (t.external) return;
      const c = E.parseChapter(t.chapter);
      const v = vols[c.volume] || (vols[c.volume] = { chapters: [], byKey: {} });
      const key = c.chapterNo + ' ' + c.chapterName;
      let ch = v.byKey[key];
      if (!ch) {
        ch = v.byKey[key] = { volume: c.volume, key: c.volume + ' ' + c.chapterNo, label: c.chapterNo + ' ' + c.chapterName, topics: [] };
        v.chapters.push(ch);
      }
      ch.topics.push({ t: t, section: c.section });
    });
    return vols;
  }

  /* ------------------------------------------------------------ 会话 */
  function save() {
    if (demo || !session) return;
    lsSet(LS_SESSION, {
      v: 2, targets: session.targets, limit: session.limit, label: sessionMeta.label, answers: session.answers,
      seed: session.seed, avoid: session.avoid, savedAt: new Date().toISOString()
    });
  }

  function startSession(targets, label, limit) {
    session = E.createSession(D.graph, targets, { limit: limit || getSettings().limit, seed: newSeed(), avoid: seenList() });
    sessionMeta = { label: label };
    resetUi();
    save();
    render();
  }

  function restoreSession(saved) {
    try {
      session = E.replay(D.graph, saved.targets, saved.answers, { limit: saved.limit, seed: saved.seed, avoid: saved.avoid });
      sessionMeta = { label: saved.label || saved.targets.map(nameOf).join('、') };
      return true;
    } catch (e) { return false; }
  }

  function restart() {
    session = null; demo = null;
    lsDel(LS_SESSION);
    if (location.search) history.replaceState(null, '', location.pathname);
    render();
  }

  function commit(result) {
    const item = E.nextItem(D.graph, session);
    session = E.applyAnswer(D.graph, session, item.topicId, result, { text: ui.answer });
    markSeen(item.question.id);
    resetUi();
    save();
    render();
  }

  function rebuild(answers, limit) {
    session = E.replay(D.graph, session.targets, answers, {
      limit: limit == null ? session.limit : limit, seed: session.seed, avoid: session.avoid
    });
    resetUi();
    save();
    render();
  }

  /* ------------------------------------------------------------ 演示模式 */
  // 演示用的“学生”：目标不会（错、错 -> 薄弱）；它的第一个可测先修也不会；再往前（或另一个先修）答错一次、第二题答对 -> 不稳；其余都会
  function makeOracle(targets) {
    const G = D.graph;
    const t0 = E.createSession(G, targets).stack[0];
    const testablePre = function (id) { return G.prereqs[id].filter(function (x) { return E.isTestable(G, x.id); }).map(function (x) { return x.id; }); };
    const weak = new Set([t0]);
    const shaky = new Set();
    const p = testablePre(t0);
    if (p.length) {
      const q = testablePre(p[0]);
      if (q.length) { weak.add(p[0]); shaky.add(q[0]); }
      else if (p.length > 1) { weak.add(p[0]); shaky.add(p[1]); }
      else shaky.add(p[0]);
    }
    return function (id, attempt) {
      if (weak.has(id)) return 'wrong';
      if (shaky.has(id)) return attempt === 1 ? 'wrong' : 'correct';
      return 'correct';
    };
  }

  function runDemo(steps) {
    let n = 0;
    while (n < steps) {
      const item = E.nextItem(D.graph, session);
      if (!item) break;
      session = E.applyAnswer(D.graph, session, item.topicId, demo.oracle(item.topicId, item.attempt));
      n++;
    }
  }

  /* ------------------------------------------------------------ 渲染入口 */
  function render() {
    if (!session) return renderStart();
    const item = E.nextItem(D.graph, session);
    if (item) renderQuestion(item); else renderResult();
  }

  /* ------------------------------------------------------------ 开始页 */
  function renderStart(errMsg) {
    const page = h('div');
    const saved = lsGet(LS_SESSION);
    if (saved && saved.targets && D.graph.byId[saved.targets[0]]) {
      page.append(h('div', { class: 'banner' },
        h('b', { text: '有一份未清除的诊断：' }), saved.label || saved.targets.map(nameOf).join('、'),
        '（已答 ' + (saved.answers || []).length + ' 题）　',
        h('button', { class: 'primary', onclick: function () { if (restoreSession(saved)) render(); else { lsDel(LS_SESSION); renderStart('存档无法恢复，已清除。'); } } }, '继续'),
        ' ', h('button', { onclick: function () { lsDel(LS_SESSION); renderStart(); } }, '放弃存档')));
    }
    if (errMsg) page.append(h('p', { class: 'err', text: errMsg }));

    const st = getSettings();
    const limitInput = h('input', { type: 'number', min: LIMIT_MIN, max: LIMIT_MAX, step: 1, value: String(st.limit), style: 'width:70px', id: 'limit-input' });
    limitInput.addEventListener('change', function () {
      let v = parseInt(limitInput.value, 10);
      if (!(v >= LIMIT_MIN)) v = LIMIT_MIN;
      if (v > LIMIT_MAX) v = LIMIT_MAX;
      limitInput.value = String(v);
      lsSet(LS_SETTINGS, { limit: v });
    });
    page.append(h('div', { class: 'card' },
      h('h2', { text: '1. 选择诊断目标' }),
      h('p', { class: 'muted' }, '选一个你想学会（或想检查）的知识点，或者选整章。工具会从目标开始提问：第一题答对就算掌握；答错会再出一道同级或更容易的题——第二题也错才算薄弱，并回溯到它的先修知识点，找到真正薄弱的根因；第二题答对则标为「不稳」。'),
      h('div', { class: 'row' },
        h('label', null, '题量上限（' + LIMIT_MIN + '–' + LIMIT_MAX + '）：', limitInput),
        h('span', { class: 'muted small' }, '每个知识点最多问 2 题；达到上限时，没测到的知识点会标为「未测」。')),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('select', { id: 'stage', onchange: function (e) { startStage = e.target.value; fillList(listBox); } },
          h('option', { value: '', selected: startStage === '', text: '全部学段' }),
          h('option', { value: 'p', selected: startStage === 'p', text: '小学 1–6 年级' }),
          h('option', { value: 'j', selected: startStage === 'j', text: '初中 7–9 年级' })),
        h('input', {
          type: 'search', class: 'grow', id: 'search', placeholder: '搜索知识点（名称、描述、章节），如：20 以内加法、配方法、一次函数',
          value: startQuery, oninput: function (e) { startQuery = e.target.value; fillList(listBox); }
        }))));
    const listBox = h('div', { id: 'target-list' });
    page.append(h('div', { class: 'card' }, h('h2', { text: '知识点列表（按年级 / 册 / 章节）' }), listBox));
    page.append(h('p', { class: 'muted small' },
      '数据来自本项目的 data/*.json（AI 生成的草稿，先修关系与题库未经教师审核）。进度和「出过的题」只保存在本机浏览器里（localStorage）。'));
    show(page);
    fillList(listBox);
    if (startQuery) { const el = document.getElementById('search'); if (el) el.focus(); }
  }

  function fillList(box) {
    while (box.firstChild) box.removeChild(box.firstChild);
    const q = startQuery.trim().toLowerCase();
    let shown = 0;
    const primaryGrade = '一二三四五六';
    VOLUMES.forEach(function (vv) {
      if (startStage === 'p' && primaryGrade.indexOf(vv[0].charAt(0)) < 0) return;
      if (startStage === 'j' && primaryGrade.indexOf(vv[0].charAt(0)) >= 0) return;
      const v = D.tree[vv[0]];
      if (!v) return;
      const chapters = [];
      v.chapters.forEach(function (ch) {
        const chHit = q && ch.label.toLowerCase().indexOf(q) >= 0;
        const rows = ch.topics.filter(function (x) {
          if (!q || chHit) return true;
          return (x.t.name + ' ' + x.t.description + ' ' + x.t.chapter).toLowerCase().indexOf(q) >= 0;
        });
        if (rows.length) chapters.push({ ch: ch, rows: rows });
      });
      if (!chapters.length) return;
      const count = chapters.reduce(function (n, c) { return n + c.rows.length; }, 0);
      shown += count;
      const det = h('details', { class: 'vol', open: !!q || (startStage === 'j' ? vv[0] === '七上' : vv[0] === '一上') },
        h('summary', null, vv[1] + '（' + count + ' 个知识点）'));
      chapters.forEach(function (c) {
        const ch = c.ch;
        det.append(h('div', { class: 'chap' },
          h('div', { class: 'chap-head' },
            h('span', { class: 't', text: ch.label }),
            h('button', {
              class: 'primary', title: '把本章全部 ' + ch.topics.length + ' 个知识点一起作为目标',
              onclick: function () { startSession(ch.topics.map(function (x) { return x.t.id; }), ch.volume + ' ' + ch.label + '（整章）'); }
            }, '以整章为目标')),
          c.rows.map(function (x) {
            return h('div', { class: 'topic-row', title: x.t.description },
              h('span', { class: 'nm', text: x.t.name }),
              h('span', { class: 'sec', text: x.section }),
              h('button', { onclick: function () { startSession([x.t.id], x.t.name); } }, '选为目标'));
          })));
      });
      box.append(det);
    });
    if (!shown) box.append(h('p', { class: 'muted', text: '没有匹配的知识点。' }));
  }

  /* ------------------------------------------------------------ 出题页 */
  function reasonFor(item) {
    const id = item.topicId;
    if (item.attempt === 2) return '第一题没答对，再出一道' + (item.question.difficulty === 'basic' ? '更基础' : '同级或更容易') + '的题确认：这一题也错才算薄弱，答对则标为「不稳」。';
    for (let i = session.answers.length - 1; i >= 0; i--) {
      const a = session.answers[i];
      if (a.result === 'correct') continue;
      const p = D.graph.prereqs[a.id].find(function (x) { return x.id === id; });
      if (p && E.statusOf(session, a.id) === 'weak') return '因为「' + nameOf(a.id) + '」两题都没通过，现在检查它的' + (p.strength === 'hard' ? '硬' : '软') + '先修知识点。';
    }
    if (session.targets.length > 1) return '这是所选章节的知识点（离章末最近的先测，答对会连带跳过它的先修）。';
    return session.targets.indexOf(id) >= 0 ? '这是你选择的目标知识点，先从它开始测。' : '检查目标的先修知识点。';
  }

  function judgeAndGo(item) {
    const q = item.question;
    const val = ui.answer.trim();
    if (!val) { const el = document.getElementById('ans'); if (el) el.focus(); return; }
    const r = E.judgeQuestion(q, val);
    ui.verdict = r;
    ui.phase = r.verdict === 'manual' ? 'self' : 'auto';
    renderQuestion(item);
  }

  function answerText(q) {
    if (q.type === 'choice') {
      const c = (q.choices || []).find(function (x) { return x.key === q.answer; });
      return q.answer + (c ? '. ' + c.text : '');
    }
    return q.answer;
  }

  function feedbackBlock(q) {
    return h('div', { class: 'feedback' },
      h('div', { class: 'refans' }, h('b', null, '参考答案：'), answerText(q)),
      q.explanation ? h('div', { class: 'explain', id: 'explain' }, h('b', null, '解析：'), q.explanation) : null);
  }

  function renderQuestion(item) {
    const id = item.topicId;
    const q = item.question;
    const t = D.graph.byId[id];
    const key = id + '#' + item.attempt;
    if (ui.key !== key) ui = { key: key, phase: 'ask', answer: '', verdict: null, picked: null };
    const n = session.answers.length;
    const card = h('div', { class: 'card' });
    card.append(
      h('div', { class: 'row' },
        h('span', { class: 'muted' }, '目标：' + sessionMeta.label),
        h('span', { class: 'grow' }),
        h('span', { class: 'muted' }, '第 ' + (n + 1) + ' 题 / 上限 ' + session.limit)),
      h('div', { class: 'progress' }, h('i', { style: 'width:' + Math.round(n / session.limit * 100) + '%' })),
      h('h2', { class: 'q-title' }, t.name, ' ', h('span', { class: 'tag', text: t.chapter })),
      h('div', { class: 'row small', style: 'margin:2px 0' },
        h('span', { class: 'tag diff-' + q.difficulty, text: DIFF_LABEL[q.difficulty] || q.difficulty }),
        h('span', { class: 'tag', text: TYPE_LABEL[q.type] || q.type }),
        h('span', { class: 'tag', text: '本知识点第 ' + item.attempt + ' 题' })),
      h('div', { class: 'reason', text: reasonFor(item) }),
      h('div', { class: 'q-text', id: 'q-text', text: q.prompt }));

    if (ui.phase === 'ask') {
      if (q.type === 'choice') {
        card.append(h('div', { class: 'choices', id: 'choices' }, (q.choices || []).map(function (c) {
          return h('button', {
            class: 'choice' + (ui.picked === c.key ? ' picked' : ''), id: 'choice-' + c.key, 'data-key': c.key,
            onclick: function () { ui.picked = c.key; ui.answer = c.key; renderQuestion(item); }
          }, h('b', { text: c.key + '.' }), ' ', c.text);
        })));
      } else if (q.type === 'self') {
        card.append(h('textarea', {
          class: 'ans-input', id: 'ans', rows: 3, placeholder: '开放题：可以写下自己的思路（不会自动判分），再点「看参考答案并自评」', value: ui.answer,
          oninput: function (e) { ui.answer = e.target.value; }
        }));
      } else {
        card.append(h('input', {
          type: 'text', class: 'ans-input', id: 'ans', autocomplete: 'off', placeholder: '在这里输入答案（数字、分数、多个答案用逗号或“和”分开）', value: ui.answer,
          oninput: function (e) { ui.answer = e.target.value; },
          onkeydown: function (e) { if (e.key === 'Enter' && !e.isComposing) judgeAndGo(item); }
        }));
      }
      card.append(h('div', { class: 'row', style: 'margin-top:10px' },
        q.type === 'self' ? null : h('button', { class: 'primary', id: 'btn-submit', onclick: function () { judgeAndGo(item); } }, '提交答案'),
        q.type === 'choice' ? null : h('button', { id: 'btn-peek', onclick: function () { ui.phase = 'self'; ui.verdict = null; renderQuestion(item); } }, '看参考答案并自评'),
        h('button', { id: 'btn-skip', onclick: function () { ui.phase = 'skip'; renderQuestion(item); } }, '不会')));
    } else if (ui.phase === 'auto') {
      const ok = ui.verdict.verdict === 'correct';
      card.append(
        h('div', { class: 'muted' }, '你的答案：' + (q.type === 'choice' ? answerOfKey(q, ui.answer) : ui.answer)),
        h('div', { class: 'verdict ' + (ok ? 'ok' : 'no') }, ok ? '自动判定：正确' : '自动判定：不正确'),
        feedbackBlock(q),
        h('div', { class: 'row' },
          h('button', { class: 'primary', id: 'btn-next', onclick: function () { commit(ok ? 'correct' : 'wrong'); } }, '下一题'),
          h('button', { id: 'btn-flip', onclick: function () { commit(ok ? 'wrong' : 'correct'); } }, ok ? '判错了，我其实没做对' : '判错了，我其实做对了'),
          h('button', { onclick: function () { ui.phase = 'ask'; renderQuestion(item); } }, '重新作答')));
    } else if (ui.phase === 'skip') {
      card.append(
        h('div', { class: 'muted' }, '你选择了「不会」。看一下答案和解析再继续：'),
        feedbackBlock(q),
        h('div', { class: 'row' }, h('button', { class: 'primary', id: 'btn-next', onclick: function () { commit('skip'); } }, '下一题')));
    } else {
      card.append(
        ui.answer ? h('div', { class: 'muted' }, '你的答案：' + ui.answer) : null,
        q.type === 'self' ? h('div', { class: 'muted' }, '开放题：请对照参考答案自己判断。')
          : (ui.verdict ? h('div', { class: 'muted' }, '这道题的答案无法被自动可靠地判定，请对照参考答案自己判断。') : null),
        feedbackBlock(q),
        h('div', { class: 'row' },
          h('button', { class: 'good', id: 'btn-right', onclick: function () { commit('correct'); } }, '对（我做对了）'),
          h('button', { class: 'bad', id: 'btn-wrong', onclick: function () { commit('wrong'); } }, '不对'),
          h('button', { id: 'btn-skip2', onclick: function () { commit('skip'); } }, '不会')));
    }

    card.append(h('div', { class: 'notice' }, '提示：自动判题只是近似的（数字、分数、多个答案会做规范化后比较），一切以参考答案为准；判错了可以手动更正。'));
    card.append(h('div', { class: 'row no-print', style: 'margin-top:12px' },
      n > 0 ? h('button', { class: 'small', onclick: function () { rebuild(session.answers.slice(0, -1)); } }, '撤销上一题') : null,
      h('button', { class: 'small', onclick: function () { if (confirm('确定放弃当前诊断并回到开始页吗？')) restart(); } }, '重新开始')));
    const page = h('div');
    if (demo) page.append(demoBanner());
    page.append(card);
    show(page);
    const inp = document.getElementById('ans');
    if (inp && inp.setSelectionRange && inp.tagName === 'INPUT') { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    else if (inp) inp.focus();
  }

  function answerOfKey(q, key) {
    const c = (q.choices || []).find(function (x) { return x.key === key; });
    return c ? c.key + '. ' + c.text : key;
  }

  function demoBanner() {
    return h('div', { class: 'banner demo no-print' }, '演示模式：由程序模拟一位学生作答（不会保存进度）。',
      h('a', { href: location.pathname }, '退出演示'));
  }

  /* ------------------------------------------------------------ 结果页 */
  function standardsBlock(id) {
    const t = D.graph.byId[id];
    const list = t.standards || [];
    if (!list.length) return h('div', { class: 'muted small', text: t.external ? '小学阶段知识点，未对应第四学段课标条目。' : '没有对应的课标条目。' });
    return h('div', null, h('b', null, '课标条目：'), list.map(function (sd) {
      const item = D.stdById[sd.id];
      return h('div', { class: 'std' },
        h('code', { text: sd.id }), h('span', { class: 'conf', text: sd.confidence === 'exact' ? '直接对应' : '推断对应' }),
        h('div', { text: item ? item.text : '（课标文件中找不到该条目）' }),
        sd.note ? h('div', { class: 'muted small', text: '说明：' + sd.note }) : null);
    }));
  }

  function topicBody(id, extra) {
    const t = D.graph.byId[id];
    const body = h('div', { class: 'body' });
    body.append(h('div', { class: 'muted' }, (t.external ? '小学先修知识点（无诊断题）' : t.chapter) + (t.domain ? ' · ' + t.domain : '')));
    body.append(h('div', { text: t.description }));
    if (t.mastery_criteria && t.mastery_criteria.length) {
      body.append(h('div', null, h('b', null, '掌握标准：'), h('ul', null, t.mastery_criteria.map(function (m) { return h('li', { text: m }); }))));
    }
    if (extra) body.append(extra);
    body.append(standardsBlock(id));
    return body;
  }

  function topicItem(id, tags, extra) {
    const t = D.graph.byId[id];
    return h('details', { class: 'topic' },
      h('summary', null, tags, h('span', { text: t.name }), ' ', h('span', { class: 'muted small', text: t.external ? '小学' : t.chapter })),
      topicBody(id, extra));
  }

  function tag(cls, text) { return h('span', { class: 'tag ' + cls, text: text }); }
  function statusTags(id, rootSet, targetSet) {
    const st = E.statusOf(session, id);
    const out = [];
    if (targetSet.has(id)) out.push(tag('target', '目标'));
    if (rootSet.has(id)) out.push(tag('root', '根因'));
    out.push(tag(st, STATUS_LABEL[st]));
    if (D.graph.byId[id].external) out.push(tag('ext', '小学'));
    return out;
  }

  function renderResult() {
    const sum = E.summarize(D.graph, session);
    const rootSet = new Set(sum.roots.map(function (r) { return r.id; }));
    const targetSet = new Set(session.targets);
    const page = h('div');
    if (demo) page.append(demoBanner());

    const targetsMastered = session.targets.every(function (id) { return E.statusOf(session, id) === 'mastered'; });
    let headline;
    if (!sum.roots.length && !sum.shaky.length && targetsMastered) headline = '目标知识点已掌握，没有发现需要补的先修。';
    else if (!sum.roots.length && !sum.shaky.length) headline = '没有判出薄弱点，但目标尚未全部测到。';
    else if (!sum.roots.length) headline = '没有判出薄弱点，但有 ' + sum.shaky.length + ' 个知识点「不稳」（第一题没答对、第二题答对），建议巩固。';
    else headline = '共发现 ' + sum.roots.length + ' 个薄弱根因' + (sum.shaky.length ? '、' + sum.shaky.length + ' 个不稳的知识点' : '') + '，按下面的学习路径从前往后补。';

    const summaryCard = h('div', { class: 'card', id: 'summary' },
      h('h2', { text: '诊断结果：' + sessionMeta.label }),
      h('p', null, headline),
      h('div', { class: 'stats' },
        stat('ask', sum.asked, '已答题数'),
        stat('bad', sum.weak.length, '薄弱'),
        stat('shaky', sum.shaky.length, '不稳'),
        stat('ok', sum.mastered.length, '已掌握'),
        stat('unk', sum.untested.length, '未测')),
      sum.unconfirmed.length ? h('p', { class: 'notice' }, '「' + sum.unconfirmed.map(nameOf).join('」「') + '」只答了第一题（答错）就到了题量上限，没来得及复测，暂按薄弱处理。') : null,
      sum.limitReached ? h('p', { class: 'notice' }, '已达到题量上限（' + sum.limit + '），剩余没测到的知识点标为「未测」。薄弱根因的先修里若有未测点，真正的根因可能更靠前。',
        h('button', { class: 'no-print', style: 'margin-left:8px', onclick: function () { rebuild(session.answers, Math.min(session.limit + 4, 60)); } }, '再多答 4 题')) : null,
      h('p', { class: 'muted small' }, '自动判题只是近似的，答题记录里可以更正任何一题。生成时间：' + new Date().toLocaleString('zh-CN')),
      h('div', { class: 'row no-print' },
        h('button', { class: 'primary', id: 'btn-export', onclick: exportJson }, '导出 JSON'),
        h('button', { id: 'btn-print', onclick: printPage }, '打印 / 另存为 PDF'),
        h('button', { onclick: function () { if (confirm('重新开始会清除当前进度，确定吗？')) restart(); } }, '重新开始'),
        session.answers.length ? h('button', { onclick: function () { rebuild(session.answers.slice(0, -1)); } }, '撤销上一题') : null));
    page.append(summaryCard);

    page.append(h('div', { class: 'card', id: 'roots' },
      h('h2', { text: '薄弱的先修知识点（根因）' }),
      h('p', { class: 'muted small' }, '根因 = 被判为薄弱、且它的直接先修里没有薄弱点的知识点。点击展开看描述、掌握标准和课标条目。'),
      sum.roots.length ? sum.roots.map(function (r) {
        const notes = h('div');
        if (r.pendingPrereqs.length) notes.append(h('div', { class: 'notice', text: '它的先修「' + r.pendingPrereqs.map(nameOf).join('」「') + '」没来得及测（题量用完），真正的根因可能更靠前。' }));
        if (r.externalPrereqs.length) notes.append(h('div', { class: 'muted small', text: '小学先修（无诊断题，未测）：' + r.externalPrereqs.map(nameOf).join('、') }));
        return topicItem(r.id, statusTags(r.id, rootSet, targetSet), notes);
      }) : h('p', { text: targetsMastered ? '没有。' : '暂未发现。' })));

    page.append(h('div', { class: 'card', id: 'shaky' },
      h('h2', { text: '不稳的知识点（' + sum.shaky.length + '）' }),
      h('p', { class: 'muted small' }, '第一题没答对，但第二题（同级或更容易）答对了：可能是粗心，也可能掌握得不牢。它们会出现在学习路径里需要巩固，但工具没有继续向它们的先修回溯（只有两题都错才回溯）。'),
      sum.shaky.length ? sum.shaky.map(function (id) { return topicItem(id, statusTags(id, rootSet, targetSet)); }) : h('p', { text: '没有。' })));

    page.append(h('div', { class: 'card', id: 'path' },
      h('h2', { text: '推荐学习路径' }),
      h('p', { class: 'muted small' }, '从根因（和「不稳」的点）出发到目标之间、尚未判定为掌握的知识点，按年级从低到高排列（同一年级里先修在前），从上往下学。「不稳」「未测」的点也在路径上，建议先巩固 / 自查。'),
      sum.path.length ? h('ol', { class: 'path' }, sum.path.map(function (p) {
        return h('li', null, topicItem(p.id, statusTags(p.id, rootSet, targetSet)));
      })) : h('p', { text: '不需要补课。' })));

    page.append(h('div', { class: 'card', id: 'graph' },
      h('h2', { text: '路径图' }),
      h('div', { class: 'legend' },
        h('span', null, h('i', { class: 'm' }), '已掌握'), h('span', null, h('i', { class: 's' }), '不稳'), h('span', null, h('i', { class: 'w' }), '薄弱'),
        h('span', null, h('i', { class: 'u' }), '未测'), h('span', null, h('i', { class: 't' }), '目标（蓝色粗框）'),
        h('span', { class: 'muted' }, '箭头：先修 → 后续；虚线表示中间省略了未画出的知识点；浅色为软先修')),
      h('div', { class: 'svgwrap' }, renderGraph(sum))));

    page.append(h('details', { class: 'card', id: 'mastered' },
      h('summary', null, h('b', null, '已掌握的知识点（' + sum.mastered.length + '）')),
      sum.mastered.map(function (id) {
        const src = session.status[id].src === 'direct' ? '答对' : '由后续知识点答对推断';
        return topicItem(id, [tag('mastered', src)].concat(D.graph.byId[id].external ? [tag('ext', '小学')] : []));
      })));

    page.append(h('details', { class: 'card', id: 'untested' },
      h('summary', null, h('b', null, '未测的知识点（' + sum.untested.length + '）')),
      h('p', { class: 'muted small' }, '题量用完，或不必再测，所以没问到的知识点。小学知识点同样会出题。'),
      sum.untested.map(function (id) { return topicItem(id, statusTags(id, rootSet, targetSet)); })));

    page.append(standardsCard(sum));
    page.append(logCard());
    show(page);
  }

  function stat(cls, n, label) { return h('div', { class: 'stat ' + cls }, h('b', { text: String(n) }), label); }

  function standardsCard(sum) {
    const ids = new Set(session.targets);
    sum.path.forEach(function (p) { ids.add(p.id); });
    const by = {};
    ids.forEach(function (id) {
      (D.graph.byId[id].standards || []).forEach(function (sd) { (by[sd.id] || (by[sd.id] = [])).push(id); });
    });
    const keys = Object.keys(by).sort();
    return h('div', { class: 'card', id: 'standards' },
      h('h2', { text: '相关课标条目' }),
      h('p', { class: 'muted small' }, '目标与学习路径上的知识点对应的《义务教育数学课程标准（2022年版）》内容要求（第一至第四学段；映射由 AI 生成，未经专家审核）。'),
      keys.length ? keys.map(function (k) {
        const item = D.stdById[k];
        return h('div', { class: 'std' }, h('code', { text: k }),
          h('div', { text: item ? item.text : '' }),
          h('div', { class: 'muted small', text: '对应知识点：' + by[k].map(nameOf).join('、') }));
      }) : h('p', { class: 'muted', text: '无。' }));
  }

  function logCard() {
    const rows = session.answers.map(function (a, i) {
      const q = E.questionById(D.graph, a.qid) || { prompt: '', answer: '' };
      const sel = h('select', {
        onchange: function (e) {
          const next = session.answers.map(function (x, j) { return j === i ? Object.assign({}, x, { result: e.target.value }) : x; });
          rebuild(next);
        }
      }, ['correct', 'wrong', 'skip'].map(function (r) { return h('option', { value: r, selected: r === a.result }, RESULT_LABEL[r]); }));
      return h('tr', null, h('td', { text: String(i + 1) }),
        h('td', null, nameOf(a.id), h('div', { class: 'muted small', text: q.prompt.length > 60 ? q.prompt.slice(0, 59) + '…' : q.prompt })),
        h('td', { class: 'muted', text: a.text || '' }),
        h('td', null, sel), h('td', { class: 'muted', text: q.answer }));
    });
    return h('div', { class: 'card', id: 'log' },
      h('h2', { text: '答题记录（可更正）' }),
      h('p', { class: 'muted small' }, '自动判题可能判错。在这里改某一题的结果会重新计算整份诊断（后续是否还需要追问也会随之变化）。'),
      session.answers.length ? h('table', { class: 'log' },
        h('thead', null, h('tr', null, h('th', { text: '#' }), h('th', { text: '知识点 / 题目' }), h('th', { text: '你的答案' }), h('th', { text: '结果' }), h('th', { text: '参考答案' }))),
        h('tbody', null, rows)) : h('p', { class: 'muted', text: '还没有答题。' }));
  }

  /* ------------------------------------------------------------ 路径图（SVG） */
  function renderGraph(sum) {
    const lay = E.layout(D.graph, session, sum);
    const W = 176, H = 40, GX = 22, GY = 54, PAD = 18;
    const width = lay.maxCols * (W + GX) - GX + PAD * 2;
    const height = lay.layers * (H + GY) - GY + PAD * 2;
    const pos = {};
    lay.nodes.forEach(function (n) {
      const rowW = n.cols * (W + GX) - GX;
      pos[n.id] = { x: PAD + (width - PAD * 2 - rowW) / 2 + n.col * (W + GX), y: PAD + n.layer * (H + GY) };
    });
    const svg = s('svg', { class: 'graph', width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': '先修路径图' });
    svg.append(s('defs', null, s('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' },
      s('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#64748b' }))));
    lay.edges.forEach(function (e) {
      const a = pos[e.from], b = pos[e.to];
      const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y;
      const k = Math.max(20, (y2 - y1) / 2);
      svg.append(s('path', {
        class: 'e' + (e.strength === 'soft' ? ' soft' : '') + (e.direct ? '' : ' indirect'),
        d: 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + (y1 + k) + ' ' + x2 + ',' + (y2 - k) + ' ' + x2 + ',' + (y2 - 2), 'marker-end': 'url(#arr)'
      }));
    });
    lay.nodes.forEach(function (n) {
      const p = pos[n.id];
      const name = nameOf(n.id);
      const g = s('g', { class: 'n ' + n.status + (n.isTarget ? ' target' : ''), transform: 'translate(' + p.x + ',' + p.y + ')' },
        s('title', null, name + '（' + STATUS_LABEL[n.status] + (n.isTarget ? '，目标' : '') + (n.isRoot ? '，根因' : '') + '）'),
        s('rect', { class: 'body', width: W, height: H, rx: 7 }),
        s('text', { x: W / 2, y: H / 2 + 5, 'text-anchor': 'middle' }, name.length > 12 ? name.slice(0, 11) + '…' : name));
      if (n.isRoot) {
        g.append(s('rect', { x: -8, y: -10, width: 38, height: 19, rx: 9.5, fill: '#dc2626' }), s('text', { class: 'mark', x: 11, y: 4, 'text-anchor': 'middle' }, '根因'));
      }
      if (n.isTarget) {
        g.append(s('rect', { x: W - 30, y: -10, width: 38, height: 19, rx: 9.5, fill: '#2563eb' }), s('text', { class: 'mark', x: W - 11, y: 4, 'text-anchor': 'middle' }, '目标'));
      }
      svg.append(g);
    });
    return svg;
  }

  /* ------------------------------------------------------------ 导出 / 打印 */
  function exportJson() {
    const sum = E.summarize(D.graph, session);
    const stdIds = new Set();
    const brief = function (id) { return { id: id, name: nameOf(id) }; };
    sum.path.concat(session.targets.map(function (id) { return { id: id }; })).forEach(function (p) {
      (D.graph.byId[p.id].standards || []).forEach(function (sd) { stdIds.add(sd.id); });
    });
    const out = {
      tool: 'cn-math-taxonomy/diagnose', version: 2, generatedAt: new Date().toISOString(),
      note: '自动判题是近似的，以参考答案为准；数据为 AI 生成的草稿。',
      label: sessionMeta.label,
      targets: session.targets.map(brief),
      limit: session.limit, seed: session.seed, asked: sum.asked, finished: sum.finished, limitReached: sum.limitReached,
      answers: session.answers.map(function (a, i) {
        const q = E.questionById(D.graph, a.qid) || {};
        return {
          order: i + 1, topicId: a.id, name: nameOf(a.id), questionId: a.qid, difficulty: q.difficulty, type: q.type,
          prompt: q.prompt, userAnswer: a.text == null ? null : a.text, result: a.result,
          referenceAnswer: q.answer, explanation: q.explanation || ''
        };
      }),
      weakRoots: sum.roots.map(function (r) {
        return Object.assign(brief(r.id), {
          pendingPrereqs: r.pendingPrereqs, externalPrereqs: r.externalPrereqs,
          masteryCriteria: D.graph.byId[r.id].mastery_criteria || [],
          standards: (D.graph.byId[r.id].standards || []).map(function (sd) { return sd.id; })
        });
      }),
      path: sum.path.map(function (p, i) { return Object.assign({ order: i + 1 }, brief(p.id), { status: p.status, isRoot: p.isRoot, isTarget: p.isTarget }); }),
      weak: sum.weak.map(brief),
      shaky: sum.shaky.map(brief),
      mastered: sum.mastered.map(function (id) { return Object.assign(brief(id), { source: session.status[id].src }); }),
      untested: sum.untested.map(function (id) { return Object.assign(brief(id), { external: !!D.graph.byId[id].external }); }),
      standards: Array.from(stdIds).sort().map(function (k) { return { id: k, text: D.stdById[k] ? D.stdById[k].text : '' }; })
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'diagnosis-' + new Date().toISOString().slice(0, 10) + '.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function printPage() { window.print(); }
  window.addEventListener('beforeprint', function () {
    document.querySelectorAll('details:not([open])').forEach(function (d) { d.setAttribute('open', ''); d.dataset.autoOpen = '1'; });
  });
  window.addEventListener('afterprint', function () {
    document.querySelectorAll('details[data-auto-open]').forEach(function (d) { d.removeAttribute('open'); delete d.dataset.autoOpen; });
  });

  /* ------------------------------------------------------------ 启动 */
  function resolveTargets(params) {
    const t = params.get('target');
    if (t) {
      const raw = t.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      const ids = E.resolveTargets(raw, D.aliases);
      const bad = ids.filter(function (id) { return !D.graph.byId[id] || D.graph.byId[id].external; });
      if (bad.length) throw new Error('URL 参数 target 里有无效知识点：' + bad.join(', '));
      const aliased = raw.filter(function (id) { return D.aliases[id]; });
      let label = ids.map(nameOf).join('、');
      if (aliased.length) {
        label = aliased.map(function (id) { return (D.aliases[id].name || id); }).join('、') + '（旧编号已对应到小学知识点）';
        if (ids.length <= 6) label += '：' + ids.map(nameOf).join('、');
      }
      return { ids: ids, label: label };
    }
    const c = params.get('chapter');
    if (c) {
      const hit = [];
      VOLUMES.forEach(function (vv) {
        ((D.tree[vv[0]] || {}).chapters || []).forEach(function (ch) { if (ch.key === c.trim()) hit.push(ch); });
      });
      if (!hit.length) throw new Error('URL 参数 chapter 没有匹配的章节：' + c + '（格式如 “七上 第一章”）');
      return { ids: hit[0].topics.map(function (x) { return x.t.id; }), label: hit[0].volume + ' ' + hit[0].label + '（整章）' };
    }
    return null;
  }

  async function init() {
    try { await loadData(); } catch (e) {
      clearRoot();
      root.append(h('div', { class: 'card' }, h('h2', { class: 'err', text: '数据加载失败' }),
        h('p', null, String(e.message || e)),
        h('p', null, '请在项目根目录运行 ', h('code', { text: 'python3 -m http.server 8000' }), '，再访问 http://localhost:8000/diagnose/ （不能直接用 file:// 打开）。')));
      return;
    }
    const params = new URLSearchParams(location.search);
    let resolved = null;
    try { resolved = resolveTargets(params); } catch (e) { renderStart(e.message); return; }
    if (params.get('seed')) seedParam = params.get('seed');
    const paramLimit = parseInt(params.get('limit'), 10);
    const limit = paramLimit > 0 ? paramLimit : undefined;
    if (resolved && params.get('demo')) {
      demo = { oracle: makeOracle(resolved.ids) };
      session = E.createSession(D.graph, resolved.ids, { limit: limit || getSettings().limit, seed: seedParam == null ? 'demo' : seedParam });
      sessionMeta = { label: resolved.label };
      const step = parseInt(params.get('step'), 10);
      runDemo(step >= 0 ? step : Infinity);
      render();
      return;
    }
    if (resolved) {
      const saved = lsGet(LS_SESSION);
      const same = saved && JSON.stringify(saved.targets) === JSON.stringify(Array.from(new Set(resolved.ids))) &&
        (seedParam == null || saved.seed === seedParam);
      if (same && restoreSession(saved)) { render(); return; }
      startSession(resolved.ids, resolved.label, limit);
      return;
    }
    renderStart();
  }

  init();
})();
