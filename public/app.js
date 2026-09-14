/* 中科微光 · 工作日志平台 一期 —— 前端应用（按开发文档 §7 页面详规实现，数据全部来自后端 API） */
(function () {
  "use strict";

  /* ---------- 基础工具 ---------- */
  var state = {
    user: null,
    meta: null, // /api/fill/meta
    follows: { projects: [], categories: [] },
    fill: null,
    homeTab: "all",
    projectSource: "unified",
    curProject: 0,
    curDingProject: "",
    dingDate: "",
    projectPageRequestSeq: 0,
    dingProjectRequestSeq: 0,
    curCategory: 0,
    curEmployee: 0,
    projCatFilter: 0,
    catProjFilter: "",
    deptFilter: 0,
    qa: { convos: [], active: 0, examples: [], scope: "" },
    saveTimer: null,
    submittedView: null,
    dwsAuthStarted: false,
    dwsAuthModalOpen: false,
    dwsAuthDismissed: false,
    dwsPollTimer: null,
    assistantContextPollTimer: null,
    assistantContextData: null,
    managerDate: "",
    assistantRefs: []
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var toastTimer = null;
  function toast(msg) {
    var el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }
  function openModal(html, className) {
    $("#modalBox").className = "modal" + (className ? " " + className : "");
    $("#modalBox").innerHTML = '<button class="modal-close" id="mClose" aria-label="关闭">✕</button>' + html;
    $("#mask").classList.add("show");
    $("#mClose").onclick = closeModal;
  }
  function closeModal() {
    $("#mask").classList.remove("show");
    if (state.dwsAuthModalOpen) {
      state.dwsAuthModalOpen = false;
      state.dwsAuthDismissed = true;
    }
  }
  $("#mask") && ($("#mask").onclick = function (e) { if (e.target === $("#mask")) closeModal(); });

  function api(path, opts) {
    opts = opts || {};
    var init = { headers: { Accept: "application/json" }, credentials: "same-origin" };
    if (opts.method) init.method = opts.method;
    if (opts.body !== undefined) {
      init.method = init.method || "POST";
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (r) {
      if (r.status === 401) { location.href = "/login"; throw new Error("未登录"); }
      return r.json();
    });
  }

  function scheduleDwsStatus() {
    clearTimeout(state.dwsPollTimer);
    state.dwsPollTimer = setTimeout(loadDwsStatus, 3000);
  }

  function showDwsAuthorization(auth) {
    if (!auth || !auth.verificationUrl || !auth.userCode || state.dwsAuthDismissed || state.dwsAuthModalOpen || $("#mask").classList.contains("show")) return;
    openModal('<h3>连接你的钉钉工作空间</h3>' +
      '<p>首次使用需要确认一次。授权只绑定你当前登录的钉钉账号，其他人无法使用。</p>' +
      '<div class="dws-auth-code"><span>授权码</span><b>' + esc(auth.userCode) + '</b></div>' +
      '<p style="text-align:center"><a class="btn btn-primary dws-auth-open" href="' + esc(auth.verificationUrl) + '" target="_blank" rel="noopener">去钉钉确认授权</a></p>' +
      '<p class="muted" style="text-align:center">确认后无需返回操作，本页会自动完成连接。</p>');
    state.dwsAuthModalOpen = true;
  }

  function startDwsAuthorization(showModal) {
    if (showModal) state.dwsAuthDismissed = false;
    state.dwsAuthStarted = true;
    api("/api/dws/auth/start", { method: "POST" }).then(function (d) {
      if (d.connected) { loadDwsStatus(); return; }
      if (!d.ok) {
        toast(d.error || "DWS 授权启动失败");
        return;
      }
      showDwsAuthorization(d.authorization);
      scheduleDwsStatus();
    }).catch(function () {
      toast("DWS 授权启动失败");
    });
  }

  function loadDwsStatus() {
    var el = $("#dwsStatus");
    if (!el || !state.user || !state.user.canDwsAssistant) {
      if (el) el.hidden = true;
      return;
    }
    clearTimeout(state.dwsPollTimer);
    el.hidden = false;
    el.className = "dws-status is-checking";
    $(".dws-label", el).textContent = "DWS检查中";
    el.title = "正在核验当前钉钉账号的 DWS 登录态";
    api("/api/dws/status").then(function (d) {
      if (d.connected) {
        el.className = "dws-status is-connected";
        $(".dws-label", el).textContent = "DWS已连接";
        el.title = "钉钉上下文已连接" + (d.identity && d.identity.name ? " · " + d.identity.name : "");
        el.onclick = null;
        if (state.dwsAuthModalOpen) {
          state.dwsAuthModalOpen = false;
          state.dwsAuthDismissed = false;
          $("#mask").classList.remove("show");
          toast("DWS 已连接到你的钉钉账号");
        }
        return;
      }
      el.onclick = function () { startDwsAuthorization(true); };
      if (d.authorization && (d.authorization.state === "starting" || d.authorization.state === "pending")) {
        el.className = "dws-status is-warning";
        $(".dws-label", el).textContent = "DWS待授权";
        el.title = "点击完成当前钉钉账号的首次授权";
        showDwsAuthorization(d.authorization);
        scheduleDwsStatus();
        return;
      }
      if (d.authorization && d.authorization.state === "completed") {
        el.className = "dws-status is-checking";
        $(".dws-label", el).textContent = "DWS连接中";
        el.title = "授权已完成，正在核验身份";
        scheduleDwsStatus();
        return;
      }
      if (d.authorization && (d.authorization.state === "error" || d.authorization.state === "expired")) {
        el.className = "dws-status is-warning";
        $(".dws-label", el).textContent = "DWS授权失败";
        el.title = d.authorization.error || "点击重新授权";
        return;
      }
      el.className = "dws-status is-warning";
      $(".dws-label", el).textContent = d.state === "identity_mismatch" ? "DWS账号不匹配" : "DWS未连接";
      el.title = d.error || "当前钉钉账号尚未连接 DWS";
      if (d.state === "unauthenticated" && !state.dwsAuthStarted) startDwsAuthorization(true);
    }).catch(function () {
      el.className = "dws-status is-warning";
      $(".dws-label", el).textContent = "DWS不可用";
      el.title = "无法检查 DWS 连接状态";
    });
  }

  function qualityBadge(q) {
    if (q === "ex") return '<span class="badge badge-ex">Excellent</span>';
    if (q === "vg") return '<span class="badge badge-vg">Very Good</span>';
    if (q === "good") return '<span class="badge badge-good">Good</span>';
    return '<span class="muted">一般</span>';
  }
  function affName(affId) {
    if (affId === "dept") return "部门日常";
    var p = (state.meta ? state.meta.projects : []).filter(function (x) { return String(x.id) === String(affId); })[0];
    return p ? p.name : "项目" + affId;
  }
  function financeCodesFor(affId) {
    if (!state.meta || affId === "dept") return [];
    return (state.meta.financeCodes || {})[String(affId)] || [];
  }
  function financeCodeName(aff) {
    var code = financeCodesFor(aff.affId).filter(function (x) { return String(x.id) === String(aff.financeCodeId || ""); })[0];
    return code ? code.name : "";
  }
  function catName(id) {
    var c = (state.meta ? state.meta.categories : []).filter(function (x) { return x.id === id; })[0];
    return c ? c.name : "分类" + id;
  }

  /* ---------- 导航 ---------- */
  var PAGES = [
    { id: "fill", name: "日志填写" },
    { id: "assistant", name: "日报助手" },
    { id: "mylogs", name: "我的日志" },
    { id: "home", name: "主管首页" },
    { id: "project", name: "项目" },
    { id: "category", name: "分类" },
    { id: "employee", name: "员工" },
    { id: "dept", name: "部门日常" },
    { id: "qa", name: "问答" }
  ];

  function navDisabled(page) {
    return pageVisible(page) ? null : "当前账号没有该功能权限";
  }

  function pageVisible(page) {
    var caps = state.user && state.user.capabilities ? state.user.capabilities : {};
    if (page === "fill" || page === "mylogs") return Boolean(caps.personalLogs);
    if (page === "assistant") return Boolean(caps.assistant);
    if (page === "home" || page === "category" || page === "employee" || page === "dept") return Boolean(caps.supervisor);
    if (page === "project") return Boolean(caps.projects);
    if (page === "admin") return Boolean(caps.admin);
    return true;
  }

  function renderNav(active) {
    var html = "";
    PAGES.forEach(function (p) {
      if (!pageVisible(p.id)) return;
      var dis = navDisabled(p.id);
      html += '<button data-page="' + p.id + '" class="' + (dis ? "disabled" : "") + (active === p.id ? " active" : "") + '">' + p.name + "</button>";
    });
    var u = state.user;
    if (pageVisible("admin")) {
      html += '<button data-page="admin"' + (active === "admin" ? ' class="active"' : "") + ">管理</button>";
    }
    $("#nav").innerHTML = html;
    $$("#nav button").forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.ext) { location.href = b.dataset.ext; return; }
        var dis = navDisabled(b.dataset.page);
        if (dis) { toast(dis); return; }
        go(b.dataset.page);
      };
    });
  }

  var renderers = {};
  function go(page) {
    if (state.user && !pageVisible(page)) { toast("当前账号没有该功能权限"); return; }
    location.hash = page;
    $$(".page").forEach(function (el) { el.classList.remove("show"); });
    var el = $("#page-" + page);
    if (el) el.classList.add("show");
    renderNav(page);
    window.scrollTo(0, 0);
    if (renderers[page]) renderers[page]();
  }

  /* =====================================================
     对话式日报助手（受约束状态机 + 行内引用）
  ===================================================== */
  function assistantPreviewTime(value) {
    if (!value) return "";
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  function assistantSafeLink(value) {
    var link = String(value || "");
    return /^(https?:\/\/|dingtalk:\/\/)/i.test(link) ? link : "";
  }

  function assistantCandidateTitle(sourceKey, item) {
    var summary = String(item.summary || "");
    if (sourceKey === "reports") {
      var plan = summary.match(/(?:明日计划|明天计划|下一步(?:计划)?)[：:]\s*([^\n]+)/);
      if (plan && plan[1]) return plan[1].trim().slice(0, 120);
    }
    return String(item.title || "未命名工作线索").trim();
  }

  function assistantCandidateKey(title) {
    return String(title || "")
      .toLocaleLowerCase("zh-CN")
      .replace(/[\s，。、“”‘’：:；;！？!?（）()\[\]【】\-—_]/g, "");
  }

  function buildAssistantCandidates(data) {
    var refs = [];
    var candidates = [];
    var byKey = {};
    var specs = [
      { key: "todos", source: data.sources.todos },
      { key: "reports", source: data.sources.reports },
      { key: "minutes", source: data.sources.minutes }
    ];
    specs.forEach(function (spec) {
      (spec.source.items || []).forEach(function (item) {
        var title = assistantCandidateTitle(spec.key, item);
        var key = assistantCandidateKey(title) || spec.key + ":" + String(item.id || "");
        var candidate = byKey[key];
        if (!candidate && candidates.length >= 8) return;
        var ref = {
          number: refs.length + 1,
          sourceKey: spec.key,
          sourceLabel: spec.source.label,
          scope: spec.source.scope,
          item: item
        };
        refs.push(ref);
        if (!candidate) {
          candidate = { title: title, refs: [] };
          byKey[key] = candidate;
          candidates.push(candidate);
        }
        candidate.refs.push(ref);
      });
    });
    state.assistantRefs = refs;
    return candidates;
  }

  function assistantCandidateHint(candidate) {
    var warning = candidate.sourceCompleteness === "partial" ? "上下文未完全读取，需确认。" : "";
    if (candidate.candidateKind === "task_signal") {
      return warning + (candidate.direction === "assigned_to_me"
        ? "发现了交办或协作请求；请确认今天是否实际处理，以及当前结果。"
        : "发现了可能需要处理的任务线索；请确认是否属于今天以及当前进展。");
    }
    if (candidate.origin === "continuation") return warning + "来自前一工作日的计划或未闭环线索，今天是否实际推进？";
    if (candidate.resultHint) return warning + candidate.resultHint;
    var sourceKeys = candidate.refs.map(function (ref) { return ref.sourceKey; }).filter(function (key, index, all) {
      return all.indexOf(key) === index;
    });
    if (candidate.refs.length > 1) return warning + "多条记录指向同一项工作。";
    if (sourceKeys[0] === "todos") return warning + "未完成待办只作为线索，不能判断已经完成。";
    if (sourceKeys[0] === "minutes") return warning + "听记只能说明讨论过，不代表形成了工作成果。";
    return warning + "来自本人临时上下文，只作为待确认的工作线索。";
  }

  function assistantRefsHtml(refs) {
    var visible = (refs || []).slice(0, 3);
    if (!visible.length) return "";
    return '<span class="assistant-references">' + visible.map(function (ref) {
      return '<button type="button" class="assistant-reference" data-assistant-ref="' + (ref.number - 1) + '"><sup>' +
        ref.number + "</sup>" + esc(ref.sourceLabel) + "</button>";
    }).join("") + "</span>";
  }

  function assistantFunnelText(contextData) {
    var data = contextData || state.assistantContextData || {};
    var funnel = data.contextFunnel || {};
    var scanned = Number(funnel.scannedCount);
    if (!Number.isFinite(scanned)) scanned = state.assistantRefs.length;
    var parts = ["扫描 " + scanned + " 条"];
    var taskSignals = Number(funnel.taskSignalCount);
    var taskCandidates = Number(funnel.interactionCandidateCount);
    var analysisInput = Number(funnel.analysisInputCount);
    var covered = Number(funnel.analysisCoveredCount);
    var workEvents = Number(funnel.workEventCount);
    var finalRefs = Number(funnel.finalReferencedCount);
    if (Number.isFinite(taskSignals)) parts.push("任务发现输入 " + taskSignals + " 条");
    if (funnel.interactionStatus === "failed") {
      parts.push("任务发现失败（不能按 0 项判断）");
    } else if (funnel.interactionStatus === "partial") {
      if (Number.isFinite(taskCandidates)) parts.push("待确认任务 " + taskCandidates + " 项（部分发现）");
      else parts.push("任务发现部分成功");
    } else if (Number.isFinite(taskCandidates)) {
      parts.push("待确认任务 " + taskCandidates + " 项");
    }
    if (Number.isFinite(analysisInput)) parts.push("成果分析输入 " + analysisInput + " 条");
    if (Number.isFinite(covered)) parts.push("进入上下文 " + covered + " 条");
    if (funnel.eventStatus === "failed") parts.push("成果分析失败（不能按 0 项判断）");
    else if (Number.isFinite(workEvents)) parts.push("已证实工作 " + workEvents + " 项" + (funnel.eventStatus === "partial" ? "（部分分析）" : ""));
    if (Number.isFinite(finalRefs)) parts.push("最终引用 " + finalRefs + " 条");
    return scanned > 0 ? parts.join(" · ") : "工作线索扫描中";
  }

  function assistantShellHtml(body, statusText, composerEnabled) {
    return '<section class="assistant-chat-shell">' +
      '<header class="assistant-chat-head"><div class="assistant-identity"><span class="assistant-avatar">日</span><div>' +
      '<div class="assistant-name">日报助手</div><div class="assistant-state">每天17:30自动分析 · 昨日17:30至今日17:30（北京时间）</div>' +
      '<div class="assistant-state"><i></i>' + esc(statusText) + "</div></div></div>" +
      '<div class="assistant-head-actions"><button type="button" class="btn" id="assistantRefsButton">查看引用</button>' +
      '<button type="button" class="btn" id="assistantReload">重新整理</button></div></header>' +
      '<div class="assistant-chat-scroll"><div class="assistant-chat-stream">' + body + "</div></div>" +
      '<footer class="assistant-composer-wrap"><div class="assistant-composer"><div class="assistant-composer-box">' +
      '<span class="assistant-attach" aria-hidden="true">＋</span><textarea id="assistantInput" ' + (composerEnabled ? "" : "disabled ") +
      'placeholder="例如：第 1 项已完成，结果是……用了 3 小时；第 3 项今天没有做。"></textarea>' +
      '<button type="button" class="assistant-send" id="assistantSend" aria-label="发送" ' + (composerEnabled ? "" : "disabled") + '>↑</button></div>' +
      '<div class="assistant-composer-foot"><span id="assistantRefCount">' + esc(assistantFunnelText()) +
      '</span><span>只有明确说“确认提交”后才会保存正式日报</span></div></div></footer></section>';
  }

  function assistantOpenReference(index) {
    var ref = state.assistantRefs[index];
    if (!ref) return;
    api("/api/daily-assistant/references/" + encodeURIComponent(ref.referenceId)).then(function (data) {
      if (!data.ok || !data.reference) { toast(data.error || "Reference 已过期"); return; }
      var item = data.reference;
      var meta = [];
      var time = assistantPreviewTime(item.occurredAt);
      if (time) meta.push(time);
      var link = assistantSafeLink(item.url);
      openModal('<h3>引用 ' + ref.number + " · " + esc(ref.sourceLabel) + '</h3>' +
        '<p class="muted">仅你本人可见 · ' + esc(assistantPreviewTime(item.expiresAt)) + " 前有效</p>" +
        '<div class="assistant-reference-detail"><b>' + esc(item.title) + "</b>" +
        (meta.length ? '<div class="context-meta">' + meta.map(esc).join(" · ") + "</div>" : "") +
        '<div class="assistant-reference-copy">' + esc(item.summary || "未返回可展示的摘要") + "</div></div>" +
        (link ? '<p style="text-align:right"><a class="btn" href="' + esc(link) + '" target="_blank" rel="noopener">在钉钉中查看</a></p>' : ""));
    });
  }

  function bindAssistantChrome() {
    var reload = $("#assistantReload");
    if (reload) reload.onclick = function () { loadDwsAssistant(true); };
    var refsButton = $("#assistantRefsButton");
    if (refsButton) refsButton.onclick = function () {
      if (!state.assistantRefs.length) { toast("当前没有可查看的引用"); return; }
      assistantOpenReference(0);
    };
    $$("#page-assistant [data-assistant-ref]").forEach(function (button) {
      button.onclick = function () { assistantOpenReference(+button.dataset.assistantRef); };
    });
  }

  function sendAssistantMessage() {
    var input = $("#assistantInput");
    var text = input ? input.value.trim() : "";
    if (!text) return;
    input.value = "";
    input.disabled = true;
    var send = $("#assistantSend");
    if (send) send.disabled = true;
    api("/api/daily-assistant/conversation/message", {
      body: { message: text, clientMessageId: "web-" + Date.now() + "-" + Math.random().toString(16).slice(2) }
    }).then(function (data) {
      if (!data.ok) { toast(data.error || "没有保存这条修改"); input.disabled = false; if (send) send.disabled = false; return; }
      if (data.submitted) { renderAssistantSubmitted(data); return; }
      var contextData = state.assistantContextData || { job: { workDate: "今天", completeness: data.session.mode }, references: [] };
      if (data.contextFunnel) contextData.contextFunnel = data.contextFunnel;
      renderAssistantConversation(contextData, data);
    }).catch(function () {
      toast("消息发送失败，请重试");
      input.disabled = false;
      if (send) send.disabled = false;
    });
  }

  function bindAssistantConversation() {
    $$("#page-assistant [data-assistant-quick]").forEach(function (button) {
      button.onclick = function () {
        var input = $("#assistantInput");
        input.value = button.dataset.assistantQuick || "";
        input.focus();
      };
    });
    var send = $("#assistantSend");
    if (send) send.onclick = sendAssistantMessage;
    var input = $("#assistantInput");
    if (input) input.onkeydown = function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendAssistantMessage();
      }
    };
  }

  function assistantSourceLabel(source) {
    return ({ chat: "聊天", document: "文档", wiki: "知识库", calendar: "日历", minutes: "AI 听记", todo: "待办", dingtalk_report: "历史钉钉日志", attendance_approval: "考勤审批", work_interactions: "OA 与 DING", platform_log: "我的日志", chat_group: "群聊", chat_private: "私聊", attendance: "考勤", approval: "审批", ding: "DING" })[source] || source;
  }

  function assistantContextCandidates(references, aggregated) {
    state.assistantRefs = references.map(function (item, index) {
      return {
        number: index + 1,
        referenceId: item.referenceId,
        sourceKey: item.sourceType,
        sourceLabel: assistantSourceLabel(item.sourceType),
        item: { title: item.title, summary: item.summary, occurredAt: item.occurredAt, link: item.url, meta: [] }
      };
    });
    if (Array.isArray(aggregated)) {
      var refsById = {};
      state.assistantRefs.forEach(function (ref) { refsById[ref.referenceId] = ref; });
      return aggregated.map(function (item) {
        return {
          title: item.title || item.workSummary || "待确认工作事项",
          resultHint: item.resultHint || "",
          origin: item.origin || "today",
          scopeType: item.scopeType || "department_daily",
          groupKey: item.groupKey || "unconfirmed",
          groupLabel: item.groupLabel || "待确认项目",
          candidateKind: item.candidateKind || ((item.needsConfirmation || []).indexOf("task_signal") >= 0 ? "task_signal" : "work_event"),
          direction: item.direction || "unknown",
          priority: item.priority || "",
          sourceCompleteness: item.sourceCompleteness || "complete",
          refs: (item.referenceIds || []).map(function (id) { return refsById[id]; }).filter(Boolean)
        };
      });
    }
    // 服务端分析失败时不把原始 Reference 容器降格为候选事项。
    return [];
  }

  function assistantSourceStatusHtml(sources) {
    if (!sources || !sources.length) return "";
    var read = [];
    var unavailable = [];
    var reading = [];
    sources.forEach(function (source) {
      var count = Number(source.itemCount);
      var label = assistantSourceLabel(source.source) + (Number.isFinite(count) ? " " + count + " 条" : "");
      if (source.status === "running") reading.push(label);
      else if (source.status === "error") unavailable.push(label);
      else if (source.status === "partial") read.push(label + "（部分）");
      else read.push(label);
    });
    var rows = [];
    if (read.length) rows.push('<div><strong>已读取：</strong>' + esc(read.join("、")) + "</div>");
    if (unavailable.length) rows.push('<div class="is-unavailable"><strong>暂不可用：</strong>' + esc(unavailable.join("、")) + "</div>");
    if (reading.length) rows.push('<div><strong>读取中：</strong>' + esc(reading.join("、")) + "</div>");
    if (unavailable.length) rows.push('<p>这些来源暂未读到；你仍可直接补充其中涉及的工作，不影响继续生成日报。</p>');
    return '<div class="assistant-source-summary">' + rows.join("") + "</div>";
  }

  function renderAssistantContext(data) {
    state.assistantContextData = data;
    var job = data.job;
    if (!job) return false;
    if (job.status === "queued" || job.status === "running" || data.analysisRunning) {
      var analyzing = data.analysisRunning === true;
      var progressBody = '<div class="assistant-date-divider">正在整理</div><article class="assistant-message">' +
        '<span class="assistant-message-avatar">日</span><div><div class="assistant-message-meta">日报助手</div>' +
        '<div class="assistant-bubble assistant-loading"><span class="context-spinner"></span>' +
        (analyzing ? "工作线索已经读取，正在区分已证实工作与待确认任务…" : "正在按来源整理你的工作上下文…") + "</div>" +
        assistantSourceStatusHtml(job.sources) + "</div></article>";
      $("#page-assistant").innerHTML = assistantShellHtml(progressBody, analyzing ? "工作分析中" : "上下文准备中", false);
      bindAssistantChrome();
      return true;
    }
    var references = data.references || [];
    var candidates = assistantContextCandidates(references, data.candidates);
    var groups = [];
    var groupsByKey = {};
    candidates.forEach(function (candidate) {
      var key = candidate.groupKey || "unconfirmed";
      if (!groupsByKey[key]) {
        groupsByKey[key] = { label: candidate.groupLabel || "待确认项目", candidates: [] };
        groups.push(groupsByKey[key]);
      }
      groupsByKey[key].candidates.push(candidate);
    });
    var itemsHtml = groups.map(function (group) {
      var rows = group.candidates.map(function (candidate) {
        var taskSignal = candidate.candidateKind === "task_signal"
          ? '<span class="assistant-flag is-warn">' + esc(candidate.direction === "assigned_to_me" ? "待确认交办" : "任务线索") + "</span>"
          : "";
        return '<li class="assistant-work-guess"><span class="assistant-work-copy">' + esc(candidate.title) + "</span>" + taskSignal +
          assistantRefsHtml(candidate.refs) + '<div class="assistant-work-hint">' + esc(assistantCandidateHint(candidate)) + "</div></li>";
      }).join("");
      return '<div class="assistant-work-group"><div class="assistant-work-group-title">' + esc(group.label) +
        '</div><ol class="assistant-work-list">' + rows + "</ol></div>";
    }).join("");
    var modeText = job.completeness === "complete" ? "完整模式" : job.completeness === "partial" ? "部分模式" : "手工模式";
    var bubble = candidates.length
      ? '<p class="assistant-lead">我根据今天可用的工作线索整理出 ' + candidates.length + ' 项工作。</p>' +
        '<p class="assistant-guidance">这些只是待确认候选。请先确认哪些是今天实际做的；你可以删除、合并、改项目或补充遗漏工作。</p>' + itemsHtml +
        '<p class="assistant-note">未可靠匹配到项目的事项已明确标注，确认前不会视为你的最终归属。</p>'
      : '<p class="assistant-lead">今天暂时没有可用线索。</p><p class="assistant-note">上下文不可用不会阻止写日报，你仍可直接描述今天的工作。</p>';
    if (data.conversationDisabled) bubble += '<p class="assistant-note">对话生成当前未开启，可继续使用原“填写日志”入口；已有正式日志不受影响。</p>';
    var body = '<div class="assistant-date-divider">' + esc(job.workDate) + '</div><article class="assistant-message"><span class="assistant-message-avatar">日</span><div>' +
      '<div class="assistant-message-meta">日报助手 · ' + esc(modeText) + '</div><div class="assistant-bubble">' + bubble + "</div>" +
      assistantSourceStatusHtml(job.sources) + "</div></article>";
    $("#page-assistant").innerHTML = assistantShellHtml(body, modeText + " · Reference 最多保留 12 小时", !data.conversationDisabled);
    bindAssistantChrome();
    if (!data.conversationDisabled) bindAssistantConversation();
    return false;
  }

  function assistantSessionItemsHtml(items) {
    var refsById = {};
    state.assistantRefs.forEach(function (ref) { refsById[ref.referenceId] = ref; });
    var groups = [];
    var byKey = {};
    (items || []).forEach(function (item) {
      var isContinuation = item.origin === "continuation";
      var key = isContinuation ? "continuation" : item.scopeType === "project" ? "project:" + item.projectId : item.scopeType;
      var label = isContinuation
        ? item.employeeConfirmed ? "昨日延续（已确认今天推进）" : "昨日延续待确认"
        : item.scopeType === "project" ? (item.projectName || "项目") : item.scopeType === "unconfirmed" ? "待确认项目" : "部门日常（系统暂未匹配，可修改）";
      if (!byKey[key]) { byKey[key] = { label: label, items: [] }; groups.push(byKey[key]); }
      byKey[key].items.push(item);
    });
    return groups.map(function (group) {
      var rows = group.items.map(function (item) {
        var refs = (item.referenceIds || []).map(function (id) { return refsById[id]; }).filter(Boolean);
        var details = [];
        if (item.origin === "continuation" && !item.resultText) details.push("来自前一工作日的计划或未闭环线索，今天是否实际推进？");
        else if (item.resultText) details.push(item.resultText);
        if (item.sourceCompleteness === "partial") details.push("上下文未完全读取，需确认");
        if (typeof item.confidence === "number") details.push("置信度 " + item.confidence.toFixed(2));
        if ((item.missingFacts || []).length) details.push("缺失事实：" + item.missingFacts.join("、"));
        if (item.employeeConfirmed) details.push(item.hours === null ? "工时待确认" : "投入 " + item.hours + " 小时");
        var taskSignal = (item.candidateKind === "task_signal" || (item.needsConfirmation || []).indexOf("task_signal") >= 0)
          ? '<span class="assistant-flag is-warn">' + esc(item.direction === "assigned_to_me" ? "待确认交办" : "任务线索") + "</span>"
          : "";
        return '<li class="assistant-work-guess assistant-session-work"><span class="assistant-work-number">' + esc(item.displayAlias) +
          '</span><span class="assistant-work-copy">' + esc(item.workSummary) + "</span>" + taskSignal +
          assistantRefsHtml(refs) + '<div class="assistant-work-hint">' + esc(details.join(" · ")) + "</div></li>";
      }).join("");
      return '<div class="assistant-work-group"><div class="assistant-work-group-title">' + esc(group.label) +
        '</div><ol class="assistant-work-list">' + rows + "</ol></div>";
    }).join("");
  }

  function renderAssistantConversation(contextData, data) {
    state.assistantContextData = contextData;
    assistantContextCandidates(contextData.references || [], []);
    var session = data.session;
    var modeText = session.mode === "complete" ? "完整模式" : session.mode === "partial" ? "部分模式" : "手工模式";
    var messages = (session.messages || []).map(function (message) {
      if (message.role === "user") {
        return '<article class="assistant-message is-user"><div class="assistant-user-bubble">' + esc(message.content) + "</div></article>";
      }
      return '<article class="assistant-message"><span class="assistant-message-avatar">日</span><div><div class="assistant-message-meta">日报助手</div>' +
        '<div class="assistant-bubble">' + esc(message.content).replace(/\n/g, "<br>") + "</div></div></article>";
    }).join("");
    var confirmQuick = '<button type="button" class="assistant-quick" data-assistant-quick="这些基本准确">这些基本准确</button>' +
      '<button type="button" class="assistant-quick" data-assistant-quick="第 1 项不是今天做的，请删除。">有几项不对</button>' +
      '<button type="button" class="assistant-quick" data-assistant-quick="补充其他工作：">补充其他工作</button>';
    var candidateIntro = data.promptKind === "confirm_candidates"
      ? '<p class="assistant-lead">我根据今天可用的工作线索整理出 ' + session.items.length + ' 项工作。</p>' +
        '<p class="assistant-guidance">这些只是待确认候选。请先确认哪些是今天实际做的；你可以删除、合并、改项目或补充遗漏工作。</p>' +
        '<div class="assistant-quick-replies assistant-primary-actions">' + confirmQuick + '</div>'
      : data.promptKind === "manual_start"
        ? '<p class="assistant-lead">今天没有从可用线索中整理出可靠候选。</p>' +
          '<p class="assistant-guidance">历史已完成内容不会自动算作今天的结果。你可以直接描述今天实际完成或推进的工作。</p>'
        : "";
    var current = data.draft
      ? '<div class="assistant-draft"><div class="assistant-draft-title">日报草稿 · 总工时 ' + esc(data.draft.totalHours) +
        ' 小时</div><div class="assistant-draft-copy">' + esc(data.draft.text || "暂无可展示事项").replace(/\n/g, "<br>") + "</div>" +
        (data.draft.warnings || []).map(function (warning) { return '<div class="assistant-draft-warning">' + esc(warning) + "</div>"; }).join("") + "</div>"
      : candidateIntro + assistantSessionItemsHtml(session.items);
    if (session.analysisMode === "deterministic" && session.mode !== "manual") {
      current += '<p class="assistant-analysis-fallback">AI 分析当前不可用，本次使用确定性规则整理；请以你的确认和修改为准。</p>';
    }
    if (session.analysisMode === "model_unavailable") {
      current += '<p class="assistant-analysis-fallback">已读取工作线索，但综合分析暂不可用；请直接补充今天的工作。</p>';
    }
    current += assistantSourceStatusHtml((contextData.job || {}).sources || []);
    var quick = data.promptKind === "confirm_candidates"
      ? ""
      : data.promptKind === "outside_work"
        ? '<button type="button" class="assistant-quick" data-assistant-quick="没有其他遗漏工作">没有其他</button>'
        : data.promptKind !== "draft"
          ? '<button type="button" class="assistant-quick" data-assistant-quick="先生成草稿">先生成草稿</button>'
          : data.promptKind === "draft" && data.draft && data.draft.complete
            ? '<button type="button" class="assistant-quick assistant-quick-submit" data-assistant-quick="确认提交">确认提交</button>'
            : "";
    var latest = '<article class="assistant-message"><span class="assistant-message-avatar">日</span><div><div class="assistant-message-meta">日报助手 · ' + esc(modeText) +
      '</div><div class="assistant-bubble">' + current + '<p class="assistant-current-prompt">' + esc(data.prompt) + "</p>" +
      (quick ? '<div class="assistant-quick-replies">' + quick + "</div>" : "") + "</div></div></article>";
    var body = '<div class="assistant-date-divider">' + esc(session.workDate) + "</div>" + messages + latest;
    var stateText = data.promptKind === "confirm_candidates" ? modeText + " · 候选已准备 · 待确认" : modeText + " · 会话已保存";
    $("#page-assistant").innerHTML = assistantShellHtml(body, stateText, true);
    bindAssistantChrome();
    bindAssistantConversation();
    var scroll = $("#page-assistant .assistant-chat-scroll");
    if (scroll) {
      scroll.scrollTop = data.promptKind === "confirm_candidates" && !(session.messages || []).length
        ? 0
        : scroll.scrollHeight;
    }
  }

  function renderAssistantSubmitted(data) {
    var report = data.report;
    var body = '<div class="assistant-date-divider">' + esc(report.workDate) + '</div><article class="assistant-message"><span class="assistant-message-avatar">日</span><div>' +
      '<div class="assistant-message-meta">日报助手</div><div class="assistant-bubble"><div class="assistant-submit-success">✓</div>' +
      '<h3>日报已提交</h3><p>共 ' + report.items.length + " 条事项，总工时 " + report.totalHours + " 小时，版本 " + report.currentVersion + "。</p>" +
      '<p class="assistant-note">当天仍可继续修改；再次明确确认后会更新同一篇日报并新增版本，不会创建第二篇。</p>' +
      '<p><button type="button" class="btn" id="assistantContinueEdit">继续修改</button> <button type="button" class="btn btn-primary" id="assistantGoMylogs">查看我的日志</button></p>' +
      "</div></div></article>";
    $("#page-assistant").innerHTML = assistantShellHtml(body, "已提交 · 版本 " + report.currentVersion, false);
    bindAssistantChrome();
    $("#assistantContinueEdit").onclick = pollAssistantContext;
    $("#assistantGoMylogs").onclick = function () { go("mylogs"); };
  }

  // ---------------------------------------------------------------------------
  // 日报助手 V2：单一消息流 + 常驻权威草稿面板。消息只渲染一次，草稿只有一份，回执来自服务端真实变更。
  // ---------------------------------------------------------------------------
  var V2_STATUS_LABEL = { completed: "已完成", in_progress: "进行中", blocked: "受阻", no_progress: "无进展" };

  function assistantV2ScopeLabel(item, view) {
    if (item.scopeType === "unconfirmed") return "待确认项目";
    if (item.projectId === null || item.projectId === undefined) return "部门日常";
    var project = (view.draft.visibleProjects || []).find(function (p) { return p.id === item.projectId; });
    return item.projectName || (project ? project.name : "项目");
  }

  function assistantV2MessagesHtml(view) {
    var messages = view.messages || [];
    var lastAssistantId = null;
    messages.forEach(function (m) { if (m.role === "assistant") lastAssistantId = m.messageId; });
    return messages.map(function (m) {
      if (m.role === "user") {
        return '<article class="assistant-message is-user" data-message-id="' + m.messageId + '"><div class="assistant-user-bubble">' + esc(m.text) + "</div></article>";
      }
      var isLatest = m.messageId === lastAssistantId;
      var receipts = (m.receipts || []).map(function (r, index) {
        var undo = isLatest && r.undoable && index === 0
          ? ' <button type="button" class="assistant-receipt-undo" data-undo-change="' + esc(r.changeId) + '">撤销</button>' : "";
        return '<li class="assistant-receipt">' + esc(r.text) + undo + "</li>";
      }).join("");
      var options = isLatest && (m.options || []).length
        ? '<div class="assistant-quick-replies">' + m.options.map(function (o) {
            return '<button type="button" data-assistant-say="' + esc(o) + '">' + esc(o) + "</button>";
          }).join("") + "</div>"
        : "";
      var bubbleClass = m.kind === "agent_v2_error" ? "assistant-bubble is-error" : "assistant-bubble";
      return '<article class="assistant-message" data-message-id="' + m.messageId + '"><span class="assistant-message-avatar">日</span><div>' +
        '<div class="assistant-message-meta">日报助手</div><div class="' + bubbleClass + '">' +
        (receipts ? '<ul class="assistant-receipts">' + receipts + "</ul>" : "") +
        '<div class="assistant-reply-text">' + esc(m.text).replace(/\n/g, "<br>") + "</div>" + options + "</div></div></article>";
    }).join("");
  }

  function assistantV2PanelHtml(view) {
    var gapsByItem = {};
    (view.draft.gaps || []).forEach(function (g) { if (g.itemId) (gapsByItem[g.itemId] = gapsByItem[g.itemId] || []).push(g); });
    var groups = [];
    var byKey = {};
    (view.draft.items || []).forEach(function (item) {
      var key = item.scopeType === "unconfirmed" ? "unconfirmed" : item.projectId === null || item.projectId === undefined ? "dept" : "project:" + item.projectId;
      if (!byKey[key]) { byKey[key] = { label: assistantV2ScopeLabel(item, view), items: [] }; groups.push(byKey[key]); }
      byKey[key].items.push(item);
    });
    var itemsHtml = groups.length ? groups.map(function (group) {
      return '<div class="assistant-panel-group"><div class="assistant-panel-group-title">' + esc(group.label) + "</div>" +
        group.items.map(function (item) {
          var flags = [];
          if (item.candidateKind === "task_signal" || (item.needsConfirmation || []).indexOf("task_signal") >= 0) flags.push('<span class="assistant-flag is-warn">' + esc(item.direction === "assigned_to_me" ? "待确认交办" : "任务线索") + "</span>");
          if (!item.confirmed) flags.push('<span class="assistant-flag is-warn">待确认是否今天</span>');
          if (item.status !== "in_progress") flags.push('<span class="assistant-flag">' + esc(V2_STATUS_LABEL[item.status] || item.status) + "</span>");
          (gapsByItem[item.itemId] || []).forEach(function (g) {
            if (g.field === "result") flags.push('<span class="assistant-flag is-gap">缺结果</span>');
            else if (g.field === "hours") flags.push('<span class="assistant-flag is-gap">缺工时</span>');
            else if (g.field === "project") flags.push('<span class="assistant-flag is-gap">项目待定</span>');
            else if (g.field === "finance_code") flags.push('<span class="assistant-flag is-gap">缺财务编码</span>');
            else if (g.field === "next_action") flags.push('<span class="assistant-flag is-gap">缺下一步</span>');
            else if (g.field === "person") flags.push('<span class="assistant-flag is-gap">称呼不明</span>');
          });
          var refs = (item.referenceIds || []).map(function (id) { return state.assistantRefsById && state.assistantRefsById[id]; }).filter(Boolean);
          var financeHtml = "";
          if (item.scopeType === "project" && item.projectId !== null && item.projectId !== undefined) {
            var financeCodes = (view.draft.financeCodes || {})[String(item.projectId)] || [];
            financeHtml = '<div style="margin-top:8px"><label style="font-size:12px;font-weight:600">财务项目编码' + (financeCodes.length ? ' <em style="color:#c0392b">*</em>' : '') + ' ' +
              (financeCodes.length ? '<select data-assistant-finance-code="' + esc(item.itemId) + '" style="max-width:100%;margin-left:6px;padding:4px 6px"><option value="">请选择</option>' +
                financeCodes.map(function (code) { return '<option value="' + code.id + '"' + (String(code.id) === String(item.financeCodeId || '') ? ' selected' : '') + '>' + esc(code.name) + '</option>'; }).join('') + '</select>' :
                '<span class="muted">项目尚未配置，当前不影响提交</span>') + '</label></div>';
          }
          return '<div class="assistant-panel-item" data-item-id="' + esc(item.itemId) + '">' +
            '<div class="assistant-panel-item-head"><span class="assistant-panel-alias">' + esc(item.displayAlias) + "</span>" +
            '<span class="assistant-panel-summary">' + esc(item.summary) + "</span></div>" +
            '<div class="assistant-panel-item-body">' + (item.result ? esc(item.result) : '<span class="muted">结果待补充</span>') + "</div>" +
            financeHtml +
            '<div class="assistant-panel-item-foot"><span>' + (item.hours === null || item.hours === undefined ? '<span class="muted">工时待确认</span>' : "投入 " + esc(item.hours) + " 小时") + "</span>" +
            (item.blocker ? '<span class="assistant-panel-blocker">阻塞：' + esc(item.blocker) + "</span>" : "") +
            (item.tomorrowPlan ? '<span class="assistant-panel-plan">明日：' + esc(item.tomorrowPlan) + "</span>" : "") +
            assistantRefsHtml(refs) + flags.join("") + "</div></div>";
        }).join("") + "</div>";
    }).join("") : '<p class="muted assistant-panel-empty">还没有事项。直接告诉我今天做了什么。</p>';
    var gapsHtml = (view.draft.gaps || []).length
      ? '<div class="assistant-panel-gaps"><div class="assistant-panel-section-title">提交前还差</div><ul>' +
        view.draft.gaps.map(function (g) { return "<li>" + esc(g.text) + "</li>"; }).join("") + "</ul></div>"
      : '<div class="assistant-panel-gaps is-complete">草稿已完整，可以提交。</div>';
    var sourcesHtml = view.sources
      ? '<div class="assistant-panel-sources">' +
        (view.sources.read.length ? "<div><strong>已读取：</strong>" + esc(view.sources.read.join("、")) + "</div>" : "") +
        (view.sources.unavailable.length ? '<div class="is-unavailable"><strong>暂不可用：</strong>' + esc(view.sources.unavailable.join("、")) + "</div>" : "") +
        (view.sources.reading.length ? "<div><strong>读取中：</strong>" + esc(view.sources.reading.join("、")) + "</div>" : "") + "</div>"
      : "";
    var submitLabel = view.submitted ? "再次提交这版" : "确认提交";
    var submitted = view.submitted ? '<span class="assistant-flag is-ok">今天已提交</span>' : "";
    return '<div class="assistant-panel-head"><div><div class="assistant-panel-title">日报草稿 ' + submitted + "</div>" +
      '<div class="assistant-panel-sub">' + esc(view.workDate) + " · 总工时 " + esc(view.draft.totalHours) + " 小时 · 第 " + esc(view.revision) + " 版</div></div>" +
      '<button type="button" class="btn btn-primary assistant-panel-submit" id="assistantV2Submit" ' + (view.draft.canSubmit ? "" : "disabled ") + ">" + submitLabel + "</button></div>" +
      itemsHtml + gapsHtml + sourcesHtml +
      '<p class="assistant-panel-note">草稿随对话实时更新。提交只在你点“确认提交”或在对话里明确确认后发生。</p>';
  }

  function assistantV2ShellHtml(view, thinking) {
    var statusText = (view.mode === "complete" ? "完整模式" : view.mode === "partial" ? "部分模式" : "手工模式") + (view.submitted ? " · 已提交，可继续修改" : " · 会话已保存");
    var thinkingHtml = thinking
      ? '<article class="assistant-message is-thinking"><span class="assistant-message-avatar">日</span><div><div class="assistant-message-meta">日报助手</div><div class="assistant-bubble"><span class="assistant-typing"><i></i><i></i><i></i></span></div></div></article>'
      : "";
    return '<section class="assistant-chat-shell assistant-v2">' +
      '<header class="assistant-chat-head"><div class="assistant-identity"><span class="assistant-avatar">日</span><div>' +
      '<div class="assistant-name">日报助手</div><div class="assistant-state">每天17:30自动分析 · 昨日17:30至今日17:30（北京时间）</div>' +
      '<div class="assistant-state"><i></i>' + esc(statusText) + "</div></div></div>" +
      '<div class="assistant-head-actions"><button type="button" class="btn assistant-panel-toggle" id="assistantPanelToggle">草稿（' + (view.draft.items || []).length + '）</button>' +
      '<button type="button" class="btn" id="assistantRefsButton">查看引用</button>' +
      '<button type="button" class="btn" id="assistantReload">重新整理</button></div></header>' +
      '<div class="assistant-v2-body"><div class="assistant-v2-chat">' +
      '<div class="assistant-chat-scroll"><div class="assistant-chat-stream"><div class="assistant-date-divider">' + esc(view.workDate) + "</div>" +
      assistantV2MessagesHtml(view) + thinkingHtml + "</div></div>" +
      '<footer class="assistant-composer-wrap"><div class="assistant-composer"><div class="assistant-composer-box">' +
      '<span class="assistant-attach" aria-hidden="true">＋</span><textarea id="assistantInput" ' + (thinking ? "disabled " : "") +
      'placeholder="直接说就行，例如：第二个不是今天的；1小时；今天还给客户做了培训"></textarea>' +
      '<button type="button" class="assistant-send" id="assistantSend" aria-label="发送" ' + (thinking ? "disabled" : "") + '>↑</button></div>' +
      '<div class="assistant-composer-foot"><span id="assistantRefCount">' + esc(assistantFunnelText()) + '</span>' +
      "<span>修改会立即出现在草稿里；提交前会再和你确认一次</span></div></div></footer></div>" +
      '<aside class="assistant-v2-panel" id="assistantV2Panel">' + assistantV2PanelHtml(view) + "</aside></div></section>";
  }

  function renderAssistantV2(contextData, view, thinking) {
    state.assistantEngine = "v2";
    state.assistantContextData = contextData;
    state.assistantV2View = view;
    assistantContextCandidates((contextData && contextData.references) || [], []);
    state.assistantRefsById = {};
    state.assistantRefs.forEach(function (ref) { state.assistantRefsById[ref.referenceId] = ref; });
    var panelOpen = state.assistantPanelOpen;
    $("#page-assistant").innerHTML = assistantV2ShellHtml(view, thinking);
    var shell = $("#page-assistant .assistant-chat-shell");
    if (panelOpen) shell.classList.add("is-panel-open");
    bindAssistantChrome();
    bindAssistantV2(view);
    var scroll = $("#page-assistant .assistant-chat-scroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function bindAssistantV2(view) {
    var send = $("#assistantSend");
    if (send) send.onclick = function () { sendAssistantV2Message($("#assistantInput").value); };
    var input = $("#assistantInput");
    if (input) input.onkeydown = function (event) {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendAssistantV2Message(input.value); }
    };
    $$("#page-assistant [data-assistant-say]").forEach(function (button) {
      button.onclick = function () { sendAssistantV2Message(button.dataset.assistantSay || ""); };
    });
    $$("#page-assistant [data-undo-change]").forEach(function (button) {
      button.onclick = function () { assistantV2Undo(button.dataset.undoChange); };
    });
    $$("#page-assistant [data-assistant-finance-code]").forEach(function (select) {
      select.onchange = function () {
        var value = Number(select.value);
        if (!value) return;
        assistantV2SetFinanceCode(select.dataset.assistantFinanceCode, value, view.revision);
      };
    });
    var submit = $("#assistantV2Submit");
    if (submit) submit.onclick = function () { assistantV2Submit(view.revision); };
    var toggle = $("#assistantPanelToggle");
    if (toggle) toggle.onclick = function () {
      var shell = $("#page-assistant .assistant-chat-shell");
      state.assistantPanelOpen = !shell.classList.contains("is-panel-open");
      shell.classList.toggle("is-panel-open", state.assistantPanelOpen);
    };
  }

  function assistantV2Failure(data, fallbackView) {
    toast((data && data.error) || "这次没有处理成功，草稿没有变化");
    var view = fallbackView || state.assistantV2View;
    if (data && data.code && (data.code === "revision_conflict" || data.code === "stale_source_message" || data.code === "duplicate_in_progress")) {
      api("/api/daily-assistant/conversation").then(function (fresh) {
        if (fresh.ok && fresh.engine === "v2") {
          if (fresh.contextFunnel && state.assistantContextData) state.assistantContextData.contextFunnel = fresh.contextFunnel;
          renderAssistantV2(state.assistantContextData, fresh, false);
        }
        else renderAssistantV2(state.assistantContextData, view, false);
      }).catch(function () { renderAssistantV2(state.assistantContextData, view, false); });
      return;
    }
    renderAssistantV2(state.assistantContextData, view, false);
  }

  function sendAssistantV2Message(rawText) {
    var text = String(rawText || "").trim();
    if (!text) return;
    var view = state.assistantV2View;
    if (!view) return;
    // 乐观显示用户消息与“思考中”，服务端返回权威视图后整体替换
    var optimistic = JSON.parse(JSON.stringify(view));
    optimistic.messages = (optimistic.messages || []).concat([{ messageId: "pending", role: "user", kind: "agent_v2_user", text: text, receipts: [], focus: null, options: [] }]);
    renderAssistantV2(state.assistantContextData, optimistic, true);
    api("/api/daily-assistant/conversation/message", {
      body: { message: text, clientMessageId: "web-" + Date.now() + "-" + Math.random().toString(16).slice(2) }
    }).then(function (data) {
      if (!data.ok || data.engine !== "v2") { assistantV2Failure(data, view); return; }
      if (data.contextFunnel && state.assistantContextData) state.assistantContextData.contextFunnel = data.contextFunnel;
      renderAssistantV2(state.assistantContextData, data, false);
      if (data.turn && data.turn.submitted) toast("日报已提交");
    }).catch(function () { assistantV2Failure({ error: "消息发送失败，请重试" }, view); });
  }

  function assistantV2Undo(changeId) {
    var view = state.assistantV2View;
    api("/api/daily-assistant/conversation/undo", { body: { changeId: changeId } }).then(function (data) {
      if (!data.ok || data.engine !== "v2") { assistantV2Failure(data, view); return; }
      if (data.contextFunnel && state.assistantContextData) state.assistantContextData.contextFunnel = data.contextFunnel;
      renderAssistantV2(state.assistantContextData, data, false);
    }).catch(function () { assistantV2Failure({ error: "撤销失败，请重试" }, view); });
  }

  function assistantV2Submit(revision) {
    var view = state.assistantV2View;
    var button = $("#assistantV2Submit");
    if (button) button.disabled = true;
    api("/api/daily-assistant/conversation/submit", { body: { revision: revision } }).then(function (data) {
      if (!data.ok || data.engine !== "v2") { assistantV2Failure(data, view); return; }
      if (data.contextFunnel && state.assistantContextData) state.assistantContextData.contextFunnel = data.contextFunnel;
      renderAssistantV2(state.assistantContextData, data, false);
      if (data.turn && data.turn.submitted) toast("日报已提交");
    }).catch(function () { assistantV2Failure({ error: "提交失败，请重试" }, view); });
  }

  function assistantV2SetFinanceCode(itemId, financeCodeId, revision) {
    api("/api/daily-assistant/conversation/finance-code", {
      body: { itemId: itemId, financeCodeId: financeCodeId, revision: revision }
    }).then(function (data) {
      if (!data.ok || data.engine !== "v2") { assistantV2Failure(data, state.assistantV2View); return; }
      if (data.contextFunnel && state.assistantContextData) state.assistantContextData.contextFunnel = data.contextFunnel;
      renderAssistantV2(state.assistantContextData, data, false);
      toast("财务项目编码已更新");
    }).catch(function () { assistantV2Failure({ error: "财务项目编码更新失败，请重试" }, state.assistantV2View); });
  }

  function pollAssistantConversation(data) {
    clearTimeout(state.assistantContextPollTimer);
    state.assistantContextData = data;
    api("/api/daily-assistant/conversation?analysis_poll=1").then(function (conversationData) {
      if (!conversationData.ok) throw new Error(conversationData.error || "对话草稿读取失败");
      if (conversationData.contextFunnel) data.contextFunnel = conversationData.contextFunnel;
      if (conversationData.ready === false && conversationData.analysisRunning) {
        data.analysisRunning = true;
        renderAssistantContext(data);
        state.assistantContextPollTimer = setTimeout(function () { pollAssistantConversation(data); }, 1000);
        return;
      }
      data.analysisRunning = false;
      if (conversationData.engine === "v2") { renderAssistantV2(data, conversationData, false); return; }
      state.assistantEngine = "v1";
      renderAssistantConversation(data, conversationData);
    }).catch(function () {
      data.analysisRunning = false;
      data.conversationDisabled = true;
      api("/api/daily-assistant/candidates").then(function (candidateData) {
        data.candidates = candidateData.ok && candidateData.ready ? candidateData.candidates : undefined;
        renderAssistantContext(data);
      }).catch(function () { renderAssistantContext(data); });
    });
  }

  function pollAssistantContext() {
    clearTimeout(state.assistantContextPollTimer);
    api("/api/daily-assistant/context/status").then(function (data) {
      if (!data.ok) throw new Error(data.error || "上下文状态读取失败");
      var job = data.job;
      if (job && (job.status === "queued" || job.status === "running")) {
        renderAssistantContext(data);
        state.assistantContextPollTimer = setTimeout(pollAssistantContext, 1000);
        return;
      }
      pollAssistantConversation(data);
    }).catch(function (error) {
      var body = '<div class="assistant-date-divider">今天</div><article class="assistant-message"><span class="assistant-message-avatar">日</span>' +
        '<div><div class="assistant-message-meta">日报助手</div><div class="assistant-bubble"><b>上下文暂不可用。</b><p class="muted">' + esc(error.message || "可继续使用手工填写") + "</p></div></div></article>";
      $("#page-assistant").innerHTML = assistantShellHtml(body, "手工模式", true);
      bindAssistantChrome();
      bindAssistantConversation();
    });
  }

  function loadDwsAssistant(refresh) {
    var page = $("#page-assistant");
    clearTimeout(state.assistantContextPollTimer);
    state.assistantContextData = null;
    state.assistantRefs = [];
    var loadingBody = '<div class="assistant-date-divider">正在整理</div><article class="assistant-message">' +
      '<span class="assistant-message-avatar">日</span><div><div class="assistant-message-meta">日报助手</div>' +
      '<div class="assistant-bubble assistant-loading"><span class="context-spinner"></span>正在从你的待办、近期日志和 AI 听记中整理工作线索…</div></div></article>';
    page.innerHTML = assistantShellHtml(loadingBody, "正在读取你的钉钉上下文", false);
    bindAssistantChrome();
    api(refresh ? "/api/daily-assistant/context/refresh" : "/api/daily-assistant/context/start", { method: "POST" }).then(function (data) {
      if (!data.ok) {
        var errorBody = '<div class="assistant-date-divider">今天</div><article class="assistant-message">' +
          '<span class="assistant-message-avatar">日</span><div><div class="assistant-message-meta">日报助手</div>' +
          '<div class="assistant-bubble"><b>上下文暂不可用。</b><p>' + esc(data.error || "可以继续使用手工模式") +
          '</p><p class="muted">这不会阻止你填写和提交日报。</p></div></div></article>';
        page.innerHTML = assistantShellHtml(errorBody, "手工模式", true);
        bindAssistantChrome();
        bindAssistantConversation();
        return;
      }
      pollAssistantContext();
    }).catch(function () {
      var body = '<div class="assistant-date-divider">今天</div><article class="assistant-message"><span class="assistant-message-avatar">日</span>' +
        '<div><div class="assistant-message-meta">日报助手</div><div class="assistant-bubble"><b>网络连接异常。</b><p class="muted">没有读取或保存任何上下文，请稍后重新整理。</p></div></div></article>';
      page.innerHTML = assistantShellHtml(body, "上下文暂不可用", false);
      bindAssistantChrome();
    });
  }

  renderers.assistant = loadDwsAssistant;

  /* =====================================================
     日志填写页
  ===================================================== */
  function newItem() { return { text: "", hours: 0, cats: [], atts: [] }; }

  function fillInit(mode, date) {
    var f = { mode: mode || "today", date: date || null, affiliations: [], suggestions: null, catSync: "", quality: null };
    state.fill = f;
    return api("/api/fill/meta").then(function (meta) {
      state.meta = meta;
      if (f.mode === "today") {
        if (meta.submittedToday) {
          return api("/api/fill/load?date=" + meta.today).then(function (d) {
            state.submittedView = { date: meta.today, affiliations: d.affiliations };
            renderSubmittedEntry();
          });
        }
        return api("/api/fill/draft").then(function (d) {
          f.date = d.date;
          f.affiliations = d.draft.affiliations && d.draft.affiliations.length ? d.draft.affiliations : [{ affId: "dept", items: [newItem()] }];
          renderFillForm();
        });
      }
      return api("/api/fill/load?date=" + encodeURIComponent(f.date)).then(function (d) {
        if (!d.ok) { toast(d.error || "无法载入"); f.mode = "today"; return fillInit("today"); }
        f.mode = d.mode === "today" ? f.mode : d.mode;
        f.affiliations = d.affiliations;
        renderFillForm();
        if (d.restoredAssistantDraft) toast("已恢复前一工作日自动保存的结构化草稿；过期 Reference 不会恢复");
      });
    });
  }

  function fillHeadHtml() {
    var f = state.fill;
    var meta = state.meta;
    var title, tip;
    if (f.mode === "edit") { title = "修改日志 · " + f.date; tip = "✓ 正在修改已提交日志，提交后以最新内容为准"; }
    else if (f.mode === "retro") { title = "补填日志 · " + f.date; tip = "✓ 补填前一个工作日的日志，提交后该日计为已提交"; }
    else { title = meta.todayLabel; tip = "✓ 草稿自动保存已开启"; }
    return '<div class="fill-head"><div><div class="fill-date">' + esc(title) + '</div><div class="save-tip" id="saveTip">' + esc(tip) + '</div></div>' +
      '<div class="fill-hint">写完统一检查 · AI 不会打断你的填写</div></div>';
  }

  function renderFillForm() {
    var f = state.fill;
    var g = 0;
    var html = fillHeadHtml() + '<div id="aiPanelSlot">' + (f.suggestions ? aiPanelHtml() : "") + "</div>";
    f.affiliations.forEach(function (aff, ai) {
      var isDept = aff.affId === "dept";
      html += '<div class="aff-card" data-ai="' + ai + '">' +
        '<div class="aff-head"><span class="icon' + (isDept ? " dept" : "") + '"></span>' +
        '<span class="aff-name">' + esc(affName(aff.affId)) + "</span>" +
        (isDept ? '<span class="badge badge-gray">非项目工作</span>' : "") +
        '<span class="spring"></span><button class="btn-ghost" data-rm-aff="' + ai + '">移除归属</button></div>';
      if (!isDept) {
        var financeCodes = financeCodesFor(aff.affId);
        html += '<div class="aff-finance-code" style="display:flex;align-items:center;gap:8px;margin:10px 0 4px 34px">' +
          '<span style="white-space:nowrap;font-weight:600">财务项目编码' + (financeCodes.length ? ' <em style="color:#c0392b">*</em>' : '') + '</span>' +
          '<select data-finance-code="' + ai + '" style="min-width:260px;max-width:100%;padding:6px 8px;border:1px solid ' + (aff.financeCodeId || !financeCodes.length ? '#d6dbe3' : '#e5a4a4') + ';border-radius:6px;background:#fff" ' + (financeCodes.length ? '' : 'disabled') + '>' +
          (financeCodes.length ? '<option value="">请选择具体财务项目编码</option>' : '<option value="">未配置（可直接提交）</option>') +
          financeCodes.map(function (code) { return '<option value="' + code.id + '"' + (String(code.id) === String(aff.financeCodeId || '') ? ' selected' : '') + '>' + esc(code.name) + '</option>'; }).join('') +
          '</select>' +
          (financeCodes.length ? '' : '<span class="muted">项目尚未配置，当前不影响提交</span>') +
          '</div>';
      }
      aff.items.forEach(function (it, ii) {
        g += 1;
        html += '<div class="item-block" data-g="' + g + '">' +
          '<div class="item-title"><span>事项 ' + g + '</span><span class="spring"></span>' +
          (aff.items.length > 1 ? '<button class="btn-ghost" data-del-item="' + ai + ":" + ii + '">删除</button>' : "") + "</div>" +
          '<textarea class="item-text" data-it="' + ai + ":" + ii + '" placeholder="用一段自然语言写清楚：做了什么、对象是什么、结果或当前状态如何…">' + esc(it.text) + "</textarea>" +
          '<div class="item-meta"><span>工时 <input type="number" class="hours-input" min="0" max="24" step="0.5" value="' + (it.hours || 0) + '" data-hr="' + ai + ":" + ii + '"> 小时</span>' +
          '<button class="btn btn-sm" data-att="' + ai + ":" + ii + '">📎 上传附件</button><span data-attlist="' + ai + ":" + ii + '">' + attChipsHtml(it) + "</span></div>" +
          '<div class="cats-row"><span>系统归类</span><span data-cats="' + ai + ":" + ii + '">' + catTagsHtml(it, true) + "</span>" +
          '<button class="btn-ghost" data-addcat="' + ai + ":" + ii + '">＋添加</button>' + catsHintHtml(it) + "</div></div>";
      });
      html += '<button class="btn-ghost" data-add-item="' + ai + '">＋ 添加事项</button></div>';
    });
    html += '<button class="btn" id="addAff" style="width:100%">＋ 添加工作归属</button>';
    html += '<div style="height:70px"></div>';
    html += '<div class="fill-sticky"><div class="fill-sticky-inner">' +
      '<span class="total">当天总工时：<span id="totalHours">0</span> 小时</span>' +
      '<span id="hoursWarn"></span><span class="spring"></span>' +
      '<button class="btn" id="btnCheck">AI 检查</button>' +
      '<button class="btn btn-primary" id="btnSubmit">提交</button></div></div>';
    $("#page-fill").innerHTML = html;
    bindFillEvents();
    refreshTotal();
  }

  function catsHintHtml(it) {
    if (!it.cats || it.cats.length === 0) return '<span class="muted">提交或 AI 检查后自动归类</span>';
    var hasUnconfirmed = it.cats.some(function (c) { return !c.confirmed && !c.manual; });
    return hasUnconfirmed ? '<span class="muted">虚线标签为系统归类，点击可确认</span>' : "";
  }
  function catTagsHtml(it, editable) {
    return (it.cats || []).map(function (c, ci) {
      var unc = !c.confirmed && !c.manual;
      return '<span class="tag' + (unc ? " tag-unconfirmed" : "") + '" data-ci="' + ci + '" title="' + (unc ? "系统归类，点击确认" : esc(catName(c.id))) + '">' +
        esc(catName(c.id)) + (editable ? '<span class="x" data-xci="' + ci + '" title="移除该标签">✕</span>' : "") + "</span>";
    }).join("");
  }
  function attChipsHtml(it) {
    return (it.atts || []).map(function (a, i) {
      return '<span class="att-chip">📄 ' + esc(a.name) + '<span class="x" data-xa="' + i + '">✕</span></span>';
    }).join(" ");
  }

  function scheduleSave() {
    var f = state.fill;
    if (f.mode !== "today") return;
    var tip = $("#saveTip");
    if (tip) tip.textContent = "正在输入…";
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      api("/api/fill/draft", { body: { affiliations: f.affiliations } }).then(function () {
        var now = new Date();
        var hh = String(now.getHours()).padStart(2, "0");
        var mm = String(now.getMinutes()).padStart(2, "0");
        if ($("#saveTip")) $("#saveTip").textContent = "✓ 草稿已自动保存 " + hh + ":" + mm;
      }).catch(function () {});
    }, 1000);
  }

  function refreshTotal() {
    var f = state.fill;
    var t = 0;
    f.affiliations.forEach(function (a) { a.items.forEach(function (i) { t += Number(i.hours) || 0; }); });
    t = Math.round(t * 10) / 10;
    if ($("#totalHours")) $("#totalHours").textContent = t;
    var warn = $("#hoursWarn");
    if (warn) {
      if (t > 0 && (t < 8 || t > 10)) warn.innerHTML = '<span class="warn">⚠ 总工时 ' + t + " 小时，请核对（正常区间 8–10 小时，不阻止提交）</span>";
      else warn.innerHTML = '<span class="ok-range">正常区间 8–10 小时</span>';
    }
    return t;
  }

  var fileTarget = null;
  function bindFillEvents() {
    var f = state.fill;
    $$("#page-fill .item-text").forEach(function (ta) {
      ta.oninput = function () {
        var p = ta.dataset.it.split(":");
        f.affiliations[+p[0]].items[+p[1]].text = ta.value;
        scheduleSave();
      };
    });
    $$("#page-fill .hours-input").forEach(function (inp) {
      inp.oninput = function () {
        var p = inp.dataset.hr.split(":");
        var v = parseFloat(inp.value);
        f.affiliations[+p[0]].items[+p[1]].hours = isNaN(v) ? 0 : v;
        refreshTotal();
        scheduleSave();
      };
    });
    $$("#page-fill [data-finance-code]").forEach(function (sel) {
      sel.onchange = function () {
        var ai = +sel.dataset.financeCode;
        var value = Number(sel.value);
        f.affiliations[ai].financeCodeId = value > 0 ? value : undefined;
        scheduleSave();
        renderFillForm();
      };
    });
    $$("#page-fill [data-add-item]").forEach(function (b) {
      b.onclick = function () { f.affiliations[+b.dataset.addItem].items.push(newItem()); scheduleSave(); renderFillForm(); };
    });
    $$("#page-fill [data-del-item]").forEach(function (b) {
      b.onclick = function () {
        var p = b.dataset.delItem.split(":");
        f.affiliations[+p[0]].items.splice(+p[1], 1);
        scheduleSave(); renderFillForm();
      };
    });
    $$("#page-fill [data-rm-aff]").forEach(function (b) {
      b.onclick = function () {
        if (f.affiliations.length <= 1) { toast("至少保留一个工作归属"); return; }
        if (!confirm("移除该工作归属及其下所有事项？")) return;
        f.affiliations.splice(+b.dataset.rmAff, 1);
        scheduleSave(); renderFillForm();
      };
    });
    var addAff = $("#addAff");
    if (addAff) addAff.onclick = openAffPicker;
    $$("#page-fill [data-att]").forEach(function (b) {
      b.onclick = function () { fileTarget = b.dataset.att.split(":"); $("#fileInput").click(); };
    });
    $$("#page-fill [data-attlist]").forEach(function (span) {
      span.onclick = function (e) {
        var x = e.target.closest("[data-xa]");
        if (!x) return;
        var p = span.dataset.attlist.split(":");
        f.affiliations[+p[0]].items[+p[1]].atts.splice(+x.dataset.xa, 1);
        scheduleSave(); renderFillForm();
      };
    });
    $$("#page-fill [data-cats]").forEach(function (span) {
      span.onclick = function (e) {
        var p = span.dataset.cats.split(":");
        var item = f.affiliations[+p[0]].items[+p[1]];
        var x = e.target.closest("[data-xci]");
        if (x) { item.cats.splice(+x.dataset.xci, 1); scheduleSave(); renderFillForm(); return; }
        var tag = e.target.closest("[data-ci]");
        if (tag) {
          var c = item.cats[+tag.dataset.ci];
          if (c && !c.confirmed && !c.manual) {
            c.confirmed = true;
            toast("已确认标签「" + catName(c.id) + "」");
            scheduleSave(); renderFillForm();
          }
        }
      };
    });
    $$("#page-fill [data-addcat]").forEach(function (b) {
      b.onclick = function () { openCatPicker(b.dataset.addcat.split(":")); };
    });
    var btnCheck = $("#btnCheck");
    if (btnCheck) btnCheck.onclick = function () { runAICheck(false); };
    var btnSubmit = $("#btnSubmit");
    if (btnSubmit) btnSubmit.onclick = function () { runAICheck(true); };
  }

  $("#fileInput").onchange = function () {
    var file = $("#fileInput").files[0];
    $("#fileInput").value = "";
    if (!file || !fileTarget) return;
    if (file.size > 20 * 1024 * 1024) { toast("附件过大（上限 20MB）"); return; }
    var p = fileTarget;
    fetch("/api/upload?name=" + encodeURIComponent(file.name), { method: "POST", body: file, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { toast(d.error || "上传失败"); return; }
        state.fill.affiliations[+p[0]].items[+p[1]].atts.push({ id: d.id, name: d.name });
        toast("附件已添加（一期 AI 不读取附件内容）");
        scheduleSave(); renderFillForm();
      })
      .catch(function () { toast("上传失败"); });
  };

  function openAffPicker() {
    var f = state.fill;
    var html = "<h3>选择工作归属</h3><p class='muted'>这里只能选择已经建立并分配给你的项目，或归入部门日常。新项目请由负责人在“项目”功能中建立。</p><div style='margin-top:10px'>";
    state.meta.projects.forEach(function (p) {
      html += '<button class="btn" style="display:flex;width:100%;margin-bottom:8px;justify-content:space-between" data-pick="' + p.id + '">' +
        "<span>" + esc(p.name) + '</span><span class="muted">负责人 ' + esc(p.owner || "—") + "</span></button>";
    });
    html += '<button class="btn" style="display:block;width:100%;margin-bottom:8px" data-pick="dept">部门日常 / 非项目工作</button>';
    html += "</div>";
    openModal(html);
    $$("#modalBox [data-pick]").forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.pick;
        if (id === "dept" && f.affiliations.some(function (a) { return a.affId === "dept"; })) { toast("部门日常归属只能添加一次"); return; }
        f.affiliations.push({ affId: String(id), items: [newItem()] });
        closeModal(); scheduleSave(); renderFillForm();
      };
    });
  }

  function strSimilarJs(a, b) {
    if (!a || !b) return false;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
    for (var i = 0; i + 2 <= a.length; i++) { if (b.indexOf(a.slice(i, i + 2)) >= 0) return true; }
    return false;
  }

  function openCatPicker(p) {
    var f = state.fill;
    var item = f.affiliations[+p[0]].items[+p[1]];
    var g = 0, gIdx = 0;
    f.affiliations.forEach(function (a, ai) { a.items.forEach(function (it, ii) { g += 1; if (ai === +p[0] && ii === +p[1]) gIdx = g; }); });
    var html = "<h3>添加分类（事项 " + gIdx + "）</h3><p class='muted'>从公司统一分类池选择，或输入新分类。新增前系统会检查相似分类。</p><div style='margin:10px 0'>";
    state.meta.categories.forEach(function (c) {
      html += '<button class="filter-chip" data-cid="' + c.id + '">' + esc(c.name) + "</button>";
    });
    html += '</div><div style="display:flex;gap:8px"><input id="ncName" class="hours-input" style="flex:1;width:auto;text-align:left" placeholder="输入新分类名称"><button class="btn" id="ncBtn">新建并添加</button></div><div id="simCatTip" class="muted" style="margin-top:6px"></div>';
    openModal(html);
    $$("#modalBox [data-cid]").forEach(function (b) {
      b.onclick = function () {
        var id = +b.dataset.cid;
        if (item.cats.some(function (c) { return c.id === id; })) { closeModal(); return; }
        item.cats.push({ id: id, confirmed: true, manual: true });
        closeModal(); scheduleSave(); renderFillForm();
      };
    });
    var nc = $("#ncName");
    nc.oninput = function () {
      var v = nc.value.trim();
      if (!v) { $("#simCatTip").textContent = ""; return; }
      var sims = state.meta.categories.map(function (c) { return c.name; }).filter(function (n) { return strSimilarJs(n, v); });
      $("#simCatTip").textContent = sims.length ? "检测到相似分类：" + sims.join("、") + "，建议直接选用已有分类，确认仍要新建吗？" : "";
    };
    $("#ncBtn").onclick = function () {
      var v = nc.value.trim();
      if (!v) { toast("请输入分类名称"); return; }
      api("/api/categories", { body: { name: v, force: true } }).then(function (d) {
        if (!d.ok || !d.created) { toast(d.error || "新建失败"); return; }
        return api("/api/fill/meta").then(function (meta) {
          state.meta = meta;
          if (!item.cats.some(function (c) { return c.id === d.created.id; })) {
            item.cats.push({ id: d.created.id, confirmed: true, manual: true });
          }
          toast("已新建分类「" + v + "」");
          closeModal(); scheduleSave(); renderFillForm();
        });
      });
    };
  }

  function aiPanelHtml() {
    var f = state.fill;
    var n = f.suggestions.length;
    var html = '<div class="ai-panel"><div class="ai-panel-head">AI 检查结果 · ' + n + ' 条建议（仅指出信息缺口，不替你改写，可忽略）<span class="spring"></span><button class="btn-ghost" id="aiFold">收起</button></div>';
    if (f.catSync) html += '<div class="ai-cat-sync">' + esc(f.catSync) + "</div>";
    f.suggestions.forEach(function (s, i) {
      html += '<div class="ai-sugg"><span class="txt">' + esc(s.text) + '</span><button class="btn-ghost" data-goto="' + s.itemIndex + '">去补充</button><button class="btn-ghost" data-ign="' + i + '">忽略</button></div>';
    });
    html += '<div class="ai-panel-foot"><button class="btn" id="aiRecheck">补充后重新检查</button><button class="btn btn-warn" id="aiForce">忽略全部建议，直接提交</button></div></div>';
    return html;
  }

  function bindAiPanel(pendingSubmit) {
    var f = state.fill;
    var slot = $("#aiPanelSlot");
    if (!slot) return;
    slot.innerHTML = f.suggestions ? aiPanelHtml() : "";
    if (!f.suggestions) return;
    var fold = $("#aiFold");
    if (fold) fold.onclick = function () { slot.innerHTML = ""; };
    $$("#aiPanelSlot [data-goto]").forEach(function (b) {
      b.onclick = function () {
        var blk = $('#page-fill [data-g="' + b.dataset.goto + '"]');
        if (!blk) return;
        blk.scrollIntoView({ behavior: "smooth", block: "center" });
        var ta = blk.querySelector(".item-text");
        ta.classList.add("flash");
        setTimeout(function () { ta.classList.remove("flash"); }, 2200);
        ta.focus();
      };
    });
    $$("#aiPanelSlot [data-ign]").forEach(function (b) {
      b.onclick = function () {
        f.suggestions.splice(+b.dataset.ign, 1);
        if (f.suggestions.length === 0) { toast("所有建议已处理，可直接提交"); }
        bindAiPanel(pendingSubmit);
      };
    });
    var re = $("#aiRecheck");
    if (re) re.onclick = function () { runAICheck(pendingSubmit); };
    var force = $("#aiForce");
    if (force) force.onclick = doSubmit;
  }

  function runAICheck(isSubmit) {
    var f = state.fill;
    var hasText = f.affiliations.some(function (a) { return a.items.some(function (i) { return i.text.trim(); }); });
    if (!hasText) { toast("请先填写工作内容"); return; }
    toast("AI 检查中…");
    api("/api/fill/check", { body: { affiliations: f.affiliations } }).then(function (d) {
      if (!d.ok) { toast(d.error || "检查失败"); return; }
      f.affiliations = d.affiliations;
      f.suggestions = d.suggestions;
      var catLines = [];
      var g = 0;
      f.affiliations.forEach(function (a) {
        a.items.forEach(function (it) {
          g += 1;
          if (it.cats && it.cats.length) catLines.push("事项 " + g + " → " + it.cats.map(function (c) { return catName(c.id); }).join("、"));
        });
      });
      f.catSync = catLines.length ? "已同步完成自动归类：" + catLines.join("；") + "（标签已落到各事项，可手动调整）" : "";
      renderFillForm();
      if (d.suggestions.length === 0) {
        if (isSubmit) { doSubmit(); }
        else { toast("AI 检查完成：未发现明显信息缺口；分类标签已自动匹配到各事项"); }
      } else {
        toast("AI 检查完成：" + d.suggestions.length + " 条建议（可补充、可忽略）；分类标签已自动匹配到各事项");
        bindAiPanel(isSubmit);
        var slot = $("#aiPanelSlot");
        if (slot) slot.scrollIntoView({ behavior: "smooth" });
      }
    });
  }

  function doSubmit() {
    var f = state.fill;
    toast("提交中…");
    api("/api/fill/submit", { body: { date: f.mode === "today" ? undefined : f.date, affiliations: f.affiliations } }).then(function (d) {
      if (!d.ok) { toast(d.error || "提交失败"); return; }
      if (f.mode === "retro") toast("补填已提交");
      else if (f.mode === "edit" || d.isEdit) toast("修改已提交，相关汇总与评价已按最新内容重新计算");
      else toast("已提交");
      renderFillSuccess(d);
    });
  }

  function renderFillSuccess(d) {
    var f = state.fill;
    var title = f.mode === "edit" || d.isEdit ? "日志已提交（" + d.date + "，内容已更新）" : f.mode === "retro" ? "补填日志已提交（" + d.date + "）" : "今日日志已提交";
    var html = '<div class="card success-card"><div class="big-check">✓</div><h2>' + esc(title) + "</h2>" +
      '<p class="muted">共 ' + d.affiliations.length + " 个工作归属 · " + d.totalItems + " 条事项 · 总工时 " + d.totalHours + " 小时</p>" +
      '<p style="margin:8px 0">日志质量评价：' + qualityBadge(d.quality) + "</p>" +
      '<p class="muted">自动归类结果已落到各事项；提交后仍可随时修改，修改后分类与质量评价将重新计算。</p>' +
      '<p style="margin-top:14px"><button class="btn" id="reEdit">继续修改</button> <button class="btn btn-primary" id="goMylogs">查看我的日志</button></p></div>';
    html += '<div class="card"><h3 class="sec-title">本次自动归类结果</h3><p class="muted">（虚线 = 系统归类待确认，实心 = 已确认；如需调整请点「继续修改」）</p>';
    d.affiliations.forEach(function (a) {
      var selectedFinanceCode = a.financeCodeName || financeCodeName(a);
      html += '<p style="margin-top:8px"><b>' + esc(affName(a.affId)) + "</b>" + (selectedFinanceCode ? '<span class="muted"> · 财务编码：' + esc(selectedFinanceCode) + '</span>' : '') + "</p>";
      a.items.forEach(function (it) {
        var txt = it.text.length > 26 ? it.text.slice(0, 26) + "…" : it.text;
        var tags = (it.cats || []).map(function (c) {
          var unc = !c.confirmed && !c.manual;
          return '<span class="tag' + (unc ? " tag-unconfirmed" : "") + '" title="' + (unc ? "系统归类，待确认" : "") + '" style="cursor:default">' + esc(catName(c.id)) + "</span>";
        }).join("") || '<span class="muted">未命中分类</span>';
        html += '<div style="margin:4px 0 8px"><span class="muted">' + esc(txt) + "</span><br>" + tags + "</div>";
      });
    });
    html += "</div>";
    $("#page-fill").innerHTML = html;
    $("#reEdit").onclick = function () { fillInit("edit", d.date); };
    $("#goMylogs").onclick = function () { go(state.user.canPersonalLogs ? "mylogs" : "fill"); };
  }

  function renderSubmittedEntry() {
    var v = state.submittedView;
    var html = fillHeadHtml() + '<div class="card success-card"><div class="big-check">✓</div><h2>今日日志已提交</h2>' +
      '<p class="muted">可以继续修改，修改后分类与质量评价将重新计算。</p>' +
      '<p style="margin-top:14px"><button class="btn" id="reEdit2">继续修改</button>' +
      (navDisabled("mylogs") ? "" : ' <button class="btn btn-primary" id="goMylogs2">查看我的日志</button>') + "</p></div>";
    $("#page-fill").innerHTML = html;
    $("#reEdit2").onclick = function () { fillInit("edit", v.date); };
    var g2 = $("#goMylogs2");
    if (g2) g2.onclick = function () { go("mylogs"); };
  }

  renderers.fill = function () { fillInit("today"); };

  /* =====================================================
     我的日志
  ===================================================== */
  renderers.mylogs = function () {
    Promise.all([api("/api/mylogs"), state.meta ? Promise.resolve(state.meta) : api("/api/fill/meta")]).then(function (rs) {
      var d = rs[0];
      state.meta = rs[1];
      if (!d.ok) { $("#page-mylogs").innerHTML = '<p class="empty-tip">' + esc(d.error || "加载失败") + "</p>"; return; }
      var adopt = d.adopt || { auto: 0, confirmed: 0 };
      var pct = adopt.auto > 0 ? Math.round((adopt.confirmed / adopt.auto) * 100) : 0;
      var formalRules = Boolean(state.user.canDwsAssistant);
      var editRule = formalRules ? "当天和前一工作日可修改" : "修改不限次数与时间";
      var html = '<div class="page-head"><div><h1>我的日志</h1><div class="sub">' + esc(state.user.name) + ' — 仅本人可见全部记录；' + editRule + '，普通页面只展示最终版本</div></div>' +
        '<button class="btn btn-primary" id="goFill">填写今日日志</button></div>';
      html += formalRules
        ? '<div class="notice-inline">补填与修改规则：仅可操作当天和「前一个工作日（' + d.retroDate + '）」；更早日报只读。</div>'
        : '<div class="notice-inline">补填规则：仅可对「前一个工作日（' + d.retroDate + '）」补填；更早日期不可补填，但已提交日志仍可修改。</div>';
      html += '<div class="card"><span class="adopt-chip">🏷 本周系统归类 ' + adopt.auto + " 个标签 · 你确认了 " + adopt.confirmed + " 个 · 采纳率 " + pct + "%</span>" +
        '<div class="muted" style="margin-top:6px">虚线标签为系统归类待确认，点击即可确认；采纳率用于持续改进归类准确度。</div></div>';
      html += '<table class="log-table"><thead><tr><th>日期</th><th>事项数</th><th>总工时</th><th>质量评价</th><th>状态</th><th>操作</th></tr></thead><tbody>';
      d.rows.forEach(function (r) {
        if (r.status === "submitted") {
          html += "<tr><td>" + r.date + " " + (r.wd || "") + "</td><td>" + r.items + "</td><td>" + r.hours + "</td><td>" + qualityBadge(r.quality) + '</td><td class="st-ok">已提交</td>' +
            '<td><a data-view="' + r.date + '">查看详情</a> / <button type="button" class="log-export-link" data-export="' + r.date + '">结构化导出</button>' + (r.canEdit ? ' / <a data-edit="' + r.date + '">修改</a>' : ' / <span class="muted">只读</span>') + "</td></tr>";
        } else if (r.status === "missing") {
          html += "<tr><td>" + r.date + " " + r.wd + '</td><td>—</td><td>—</td><td>—</td><td class="st-miss">未提交</td><td>' +
            (r.canRetro ? '<a data-retro="' + r.date + '">补填</a>' : '<span class="muted">不可补填</span>') + "</td></tr>";
        } else {
          html += "<tr><td>" + r.date + '</td><td>—</td><td>—</td><td>—</td><td class="muted">今日填写中</td><td><a data-gofill="1">去填写</a></td></tr>';
        }
      });
      html += "</tbody></table>";
      $("#page-mylogs").innerHTML = html;
      $("#goFill").onclick = function () { go("fill"); };
      $$("#page-mylogs [data-gofill]").forEach(function (a) { a.onclick = function () { go("fill"); }; });
      $$("#page-mylogs [data-view]").forEach(function (a) { a.onclick = function () { viewMyLog(a.dataset.view); }; });
      $$("#page-mylogs [data-export]").forEach(function (button) { button.onclick = function () { exportMyLog(button.dataset.export); }; });
      $$("#page-mylogs [data-edit]").forEach(function (a) {
        a.onclick = function () { go("fill"); fillInit("edit", a.dataset.edit).then(function () { toast("已载入 " + a.dataset.edit + " 日志，修改后重新提交即生效"); }); };
      });
      $$("#page-mylogs [data-retro]").forEach(function (a) {
        a.onclick = function () { go("fill"); fillInit("retro", a.dataset.retro).then(function () { toast("补填 " + a.dataset.retro + "（前一个工作日）"); }); };
      });
    });
  };

  function exportMyLog(date) {
    api("/api/mylogs/export?date=" + encodeURIComponent(date)).then(function (d) {
      if (!d.ok) { toast(d.error || "导出失败，请重试"); return; }
      openModal('<h3>日报结构化导出</h3><p class="muted">保留已提交日报原文，仅按项目分组和排版。</p>' +
        '<label class="log-export-label" for="logExportText">' + esc(date) + ' · 原文预览</label>' +
        '<textarea id="logExportText" class="log-export-text" readonly></textarea>' +
        '<div class="log-export-actions"><span id="logExportStatus" role="status" aria-live="polite"></span>' +
        '<button type="button" class="btn" id="selectLogExport">全选文本</button>' +
        '<button type="button" class="btn btn-primary" id="copyLogExport">一键复制</button></div>', "log-export-modal");
      var field = $("#logExportText");
      var status = $("#logExportStatus");
      field.value = d.text;
      function selectText() { field.focus(); field.select(); field.setSelectionRange(0, field.value.length); }
      function fallbackCopy() {
        selectText();
        var copied = false;
        try { copied = document.execCommand("copy"); } catch (_) { /* Manual selection remains available. */ }
        status.textContent = copied ? "已复制，可直接粘贴" : "已全选，请长按复制或按 Ctrl/Cmd+C";
      }
      $("#selectLogExport").onclick = function () { selectText(); status.textContent = "已全选，请长按复制或按 Ctrl/Cmd+C"; };
      $("#copyLogExport").onclick = function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(field.value).then(function () { status.textContent = "已复制，可直接粘贴"; }, fallbackCopy);
        } else fallbackCopy();
      };
    }).catch(function () { toast("导出失败，请检查网络后重试"); });
  }

  function viewMyLog(date) {
    api("/api/mylogs/detail?date=" + encodeURIComponent(date)).then(function (d) {
      if (!d.ok) { toast(d.error || "无法加载该日志内容"); return; }
      var statusLabels = { completed: "已完成", in_progress: "进行中", blocked: "有阻塞", no_progress: "暂无进展" };
      var html = '<div class="log-detail"><header class="log-detail-head"><div>' +
        '<h3>日志详情</h3><div class="log-detail-date">' + esc(date) + "</div></div>" +
        '<div class="log-detail-summary"><span><b>' + d.items.length + "</b> 项工作</span>" +
        '<span><b>' + esc(d.totalHours) + "</b> 小时</span>" + qualityBadge(d.quality) + "</div></header>";
      var byAff = {};
      d.items.forEach(function (it) { (byAff[it.affName] = byAff[it.affName] || []).push(it); });
      Object.keys(byAff).forEach(function (an) {
        html += '<section class="log-detail-group"><div class="log-detail-group-head"><i></i><h4>' + esc(an) +
          '</h4><span>' + byAff[an].length + " 项</span></div>";
        byAff[an].forEach(function (it) {
          var tags = it.cats.map(function (c) {
            var unc = !c.confirmed && !c.manual;
            return '<span class="tag' + (unc ? " tag-unconfirmed" : "") + '" data-cf="' + it.itemId + ":" + c.id + '" title="' + (unc ? "系统归类，点击确认" : "") + '">' + esc(c.name) + "</span>";
          }).join("") || '<span class="log-detail-empty-meta">无分类</span>';
          var atts = it.atts.length ? '<span class="log-detail-attachments">附件：' + it.atts.map(function (a) {
            return '<a href="/api/attachment/' + a.id + '">' + esc(a.name) + "</a>";
          }).join("、") + "</span>" : "";
          var result = String(it.resultText || it.text || "").trim();
          var summary = String(it.workSummary || it.text || "").trim();
          var resultHtml = result && result !== summary
            ? '<div class="log-detail-result"><span>结果 / 进展</span><p>' + esc(result) + "</p></div>" : "";
          var extraRows = [
            ["阻塞问题", it.blockerText],
            ["下一步", it.nextAction],
            ["明日计划", it.tomorrowPlan],
            ["需要支持", it.supportNeeded]
          ].filter(function (row) { return String(row[1] || "").trim(); });
          var extraHtml = extraRows.length ? '<dl class="log-detail-extra">' + extraRows.map(function (row) {
            return "<div><dt>" + row[0] + "</dt><dd>" + esc(row[1]) + "</dd></div>";
          }).join("") + "</dl>" : "";
          var people = (it.supportPeople || []).length
            ? '<span class="log-detail-people">协作人：' + it.supportPeople.map(esc).join("、") + "</span>" : "";
          var status = statusLabels[it.status] || "进行中";
          var financeHtml = it.financeCodeName || it.financeCode
            ? '<span class="log-detail-finance-code">财务编码：' + esc(it.financeCodeName || it.financeCode) + '</span>' : '';
          html += '<article class="log-detail-item"><div class="log-detail-item-head">' +
            '<span class="log-detail-index">第 ' + esc(it.order) + ' 项</span><div class="log-detail-title-wrap">' +
            '<h5>' + esc(summary) + '</h5></div><span class="log-detail-status is-' + esc(it.status) + '">' + esc(status) + "</span></div>" +
            resultHtml + extraHtml + '<footer class="log-detail-item-foot"><span class="log-detail-hours">投入 <b>' + esc(it.hours) +
            '</b> 小时</span>' + financeHtml + '<span class="log-detail-cats">' + tags + "</span>" + people + atts + "</footer></article>";
        });
        html += "</section>";
      });
      html += d.canEdit
        ? '<footer class="log-detail-actions"><button class="btn" id="exportThisLog">结构化导出</button><button class="btn" id="delLog">删除此日志</button> <button class="btn btn-primary" id="editThis">修改此日志</button></footer></div>'
        : '<footer class="log-detail-actions"><span class="muted">更早日报只读</span><button class="btn" id="exportThisLog">结构化导出</button></footer></div>';
      openModal(html, "log-detail-modal");
      $("#exportThisLog").onclick = function () { exportMyLog(date); };
      $$("#modalBox [data-cf]").forEach(function (t) {
        if (!d.canEdit) { t.style.cursor = "default"; t.classList.remove("tag-unconfirmed"); return; }
        t.onclick = function () {
          if (!t.classList.contains("tag-unconfirmed")) return;
          var p = t.dataset.cf.split(":");
          api("/api/mylogs/confirm-cat", { body: { itemId: +p[0], catId: +p[1] } }).then(function (r) {
            if (r.ok) { toast("已确认标签「" + t.textContent + "」，采纳率已更新"); viewMyLog(date); }
          });
        };
      });
      var editButton = $("#editThis");
      if (editButton) editButton.onclick = function () {
          closeModal(); go("fill");
          fillInit("edit", date).then(function () { toast("已载入 " + date + " 日志，修改后重新提交即生效"); });
        };
      var deleteButton = $("#delLog");
      if (deleteButton) deleteButton.onclick = function () {
          if (!confirm("删除 " + date + " 的日志？删除后该日志不再作为汇总和问答依据，该日将重新视为未提交。")) return;
          api("/api/mylogs/delete", { body: { date: date } }).then(function (r) {
            if (r.ok) { toast("日志已删除"); closeModal(); renderers.mylogs(); }
            else toast(r.error || "删除失败");
          });
        };
    });
  }

  /* =====================================================
     主管首页
  ===================================================== */
  renderers.home = function () {
    Promise.all([api("/api/views/home"), state.meta ? Promise.resolve(state.meta) : api("/api/fill/meta")]).then(function (rs) {
      var d = rs[0];
      state.meta = rs[1];
      if (!d.ok) { $("#page-home").innerHTML = '<p class="empty-tip">' + esc(d.error || "加载失败") + "</p>"; return; }
      state.follows = d.follows;
      var roleLabels = { lead: "项目负责人", mgr: "部门主管", exec: "公司管理者", admin: "管理员" };
      var sub = state.user.name === roleLabels[state.user.role] ? state.user.name : state.user.name + "（" + (roleLabels[state.user.role] || "") + "）";
      var html = '<div class="page-head"><div><h1>主管首页</h1><div class="sub">' + esc(sub) + " · 默认展示最近一个完整工作日：<b>" + d.dateLabel + "</b>（非填写中的当天）</div></div>" +
        '<div class="tab-toggle"><button data-tab="all" class="' + (state.homeTab === "all" ? "on" : "") + '">全部</button><button data-tab="followed" class="' + (state.homeTab === "followed" ? "on" : "") + '">我的关注</button></div></div>';
      var s = d.submission;
      html += '<div class="sub-strip">📋 提交情况：<b>应提交 ' + s.total + " 人</b> · <b class='n-ok'>已提交 " + s.submitted + "</b> · <b class='n-miss'>未提交 " + (s.total - s.submitted) + " 人</b>" +
        (s.missingNames.length ? "（" + s.missingNames.map(esc).join("、") + "）" : "") + "</div>";
      if (state.homeTab === "followed") {
        html += '<div class="notice-inline">仅展示你关注的项目 / 分类相关内容。关注操作在项目、分类详情页右上角进行，只影响你的首页呈现。</div>';
      }
      var isFollowed = function (entry) {
        var f = state.follows;
        var projMatch = state.meta.projects.some(function (p) { return f.projects.indexOf(p.id) >= 0 && String(p.id) === String(entry.aff); });
        var catMatch = (entry.cats || []).some(function (c) { return f.categories.indexOf(c.id) >= 0; });
        return projMatch || catMatch;
      };
      var filterList = function (list) { return state.homeTab === "followed" ? list.filter(isFollowed) : list; };
      /* 信号条 */
      var rw = state.homeTab === "followed" ? d.riskWatch.filter(function (r) { return state.follows.categories.indexOf(r.catId) >= 0; }) : d.riskWatch;
      var hd = state.homeTab === "followed" ? d.hourDist.filter(function (r) { return r.catId === null || state.follows.categories.indexOf(r.catId) >= 0; }) : d.hourDist;
      html += '<div class="sig-card"><div class="sig-half"><div class="sig-title">风险标签监控 <span class="muted" style="font-weight:400">风险类标签默认进入监控区</span></div>';
      if (rw.length === 0) {
        html += '<p class="muted">' + (state.homeTab === "followed" ? "当前关注范围内暂无风险标签信号（可切换到「全部」查看）" : "近 7 个工作日暂无风险标签记录") + "</p>";
      } else {
        rw.forEach(function (r) {
          var mx = Math.max.apply(null, r.trend.concat([1]));
          var bars = r.trend.map(function (v) { return '<span style="height:' + Math.max(3, Math.round((v / mx) * 24)) + 'px" title="' + v + '"></span>'; }).join("");
          html += '<div class="sig-row"><a data-cat="' + r.catId + '">' + esc(r.name) + "</a><span class='muted'>本周 " + r.week + " 次 · 涉及 " + r.projects + " 个项目 · 最长已持续 " + r.maxDays + " 个工作日</span>" +
            (r.up ? '<span class="up" title="较上周次数上升">▲ 环比上升</span>' : "") +
            '<span class="spring" style="flex:1"></span><span class="trend-bars" title="近 5 个工作日出现次数：' + r.trend.join("、") + '">' + bars + "</span></div>";
        });
        html += '<div class="muted" style="text-align:right">迷你柱条 = 近 5 个工作日每日出现次数</div>';
      }
      html += '</div><div class="sig-half"><div class="sig-title">近 7 日工时按标签分布</div>';
      if (hd.length === 0) {
        html += '<p class="muted">' + (state.homeTab === "followed" ? "当前关注范围内暂无工时分布数据（可切换到「全部」查看）" : "暂无工时分布数据") + "</p>";
      } else {
        hd.forEach(function (r) {
          html += '<div class="ratio-row"><span class="r-name">' + (r.catId ? '<a data-cat="' + r.catId + '">' + esc(r.name) + "</a>" : esc(r.name)) + "</span>" +
            '<span class="r-track"><span class="r-fill' + (r.warm ? " warm" : r.gray ? " gray" : "") + '" style="width:' + r.pc + '%"></span></span><span class="r-pc">' + r.pc + "%</span></div>";
        });
        html += '<div class="muted">系统分析 · 基于已提交日志工时汇总；暖色 = 非直接产出类标签</div>';
      }
      html += "</div></div>";
      /* 进展卡 */
      var prog = filterList(d.progress);
      html += '<div class="card"><h3 class="sec-title">重要进展</h3>';
      html += prog.length ? prog.map(statusItemHtml).join("") : '<p class="empty-tip">当前筛选下暂无内容（可切换到「全部」，或在项目 / 分类页添加关注）</p>';
      html += "</div>";
      /* 卡点卡 */
      var blockers = filterList(d.blockers);
      html += '<div class="card"><h3 class="sec-title" style="--c:#B91C1C">需要关注的卡点</h3>';
      if (blockers.length === 0) {
        html += '<p class="empty-tip">当前筛选下暂无内容（可切换到「全部」，或在项目 / 分类页添加关注）</p>';
      } else {
        var news = blockers.filter(function (b) { return b.status === "new"; });
        var ongoing = blockers.filter(function (b) { return b.status !== "new"; });
        if (news.length) html += '<div class="blk-group">今日新增</div>' + news.map(statusItemHtml).join("");
        if (ongoing.length) html += '<div class="blk-group">持续中</div>' + ongoing.map(statusItemHtml).join("");
      }
      html += "</div>";
      if (d.insightsSource === "rules") html += '<p class="muted">（AI 汇总暂不可用，以上为规则聚合结果）</p>';
      $("#page-home").innerHTML = html;
      bindStatusEvents("#page-home");
      $$("#page-home .tab-toggle button").forEach(function (b) {
        b.onclick = function () { state.homeTab = b.dataset.tab; renderers.home(); };
      });
    });
  };

  /* 正式日报结构化主管首页；开关关闭时回退既有首页。 */
  var legacyManagerHomeRenderer = renderers.home;
  renderers.home = function () {
    if (!state.user.canDwsAssistant) { legacyManagerHomeRenderer(); return; }
    var query = state.managerDate ? "?date=" + encodeURIComponent(state.managerDate) : "";
    api("/api/manager/overview" + query).then(function (d) {
      if (!d.ok && d.code === "feature_disabled") { legacyManagerHomeRenderer(); return; }
      if (!d.ok) { $("#page-home").innerHTML = '<p class="empty-tip">' + esc(d.error || "加载失败") + "</p>"; return; }
      state.managerDate = d.workDate;
      var s = d.submission;
      var html = '<div class="page-head"><div><h1>主管首页</h1><div class="sub">只展示员工已提交的正式日报；跨部门项目按项目权限展开</div></div>' +
        '<label class="manager-date-label">日期 <input type="date" id="managerDate" value="' + esc(d.workDate) + '"></label></div>';
      html += '<div class="manager-metrics"><div><span>应提交</span><b>' + s.expected + '</b></div><div><span>已提交</span><b>' + s.submitted +
        '</b></div><div><span>提交率</span><b>' + s.rate + '%</b></div><div><span>项目数</span><b>' + d.totals.projects +
        '</b></div><div><span>成果事项</span><b>' + d.totals.resultItems + '</b></div><div><span>阻塞事项</span><b>' + d.totals.blockedItems + "</b></div></div>";

      if (d.needsAttention.length) {
        html += '<div class="card"><h3 class="sec-title" style="--c:#B91C1C">需要关注</h3><div class="manager-attention-list">';
        d.needsAttention.forEach(function (item) {
          var labels = { missing: "未提交", blocked: "明确阻塞", support: "需要支持", long_no_progress: "持续无进展", abnormal_hours: "工时异常" };
          var detail = item.type === "missing" ? item.department : item.type === "abnormal_hours" ? "总工时 " + item.hours + " 小时" : (item.blockerText || item.supportNeeded || item.resultText || "请查看正式事项");
          html += '<div class="manager-attention"><span class="badge">' + esc(labels[item.type] || item.type) + '</span><b>' + esc(item.name || item.employeeName || "") +
            '</b><span>' + esc(detail) + "</span></div>";
        });
        html += "</div></div>";
      }

      html += '<div class="manager-project-grid">';
      d.projects.forEach(function (project) {
        html += '<section class="card manager-project-card"><div class="manager-project-head"><div><h3>' + esc(project.projectName) +
          '</h3><span class="badge">' + (project.status === "completed" ? "已完成" : "进行中") + '</span></div><div class="muted">负责人 ' + esc(project.ownerName || "未设置") +
          ' · ' + project.participantCount + ' 人 · ' + project.totalHours + ' 小时</div></div>';
        if (project.blockers.length) html += '<div class="manager-project-section"><b>问题与阻塞</b>' + project.blockers.map(function (item) { return '<p>' + esc(item.employeeName) + '：' + esc(item.blockerText || item.resultText) + "</p>"; }).join("") + "</div>";
        if (project.support.length) html += '<div class="manager-project-section"><b>需要支持</b>' + project.support.map(function (item) { return '<p>' + esc(item.employeeName) + '：' + esc(item.supportNeeded) + "</p>"; }).join("") + "</div>";
        if (project.tomorrowPlans.length) html += '<div class="manager-project-section"><b>明日计划</b>' + project.tomorrowPlans.map(function (item) { return '<p>' + esc(item.employeeName) + '：' + esc(item.tomorrowPlan) + "</p>"; }).join("") + "</div>";
        html += '<details class="manager-employee-items" open><summary>员工正式事项（' + project.employeeItems.length + '）</summary>' + project.employeeItems.map(function (item) {
          return '<div class="manager-item"><b>' + esc(item.employeeName) + '</b><span>' + esc(item.resultText || item.workSummary) + '</span><em>' + esc(item.hours) + " 小时</em></div>";
        }).join("") + "</details></section>";
      });
      html += "</div>";
      if (!d.projects.length) html += '<div class="card"><p class="empty-tip">该日期暂无可见项目正式事项</p></div>';

      html += '<div class="card"><h3 class="sec-title">部门日常</h3>';
      if (!d.departmentDaily.length) html += '<p class="empty-tip">该日期暂无可见部门日常</p>';
      d.departmentDaily.forEach(function (employee) {
        html += '<div class="manager-daily"><div><b>' + esc(employee.employeeName) + '</b><span class="muted">' + esc(employee.employeeDepartment) + ' · ' + employee.totalHours + ' 小时</span></div>' +
          employee.items.map(function (item) { return '<p>' + esc(item.resultText || item.workSummary) + '<em>' + esc(item.hours) + " 小时</em></p>"; }).join("") + "</div>";
      });
      html += "</div>";
      $("#page-home").innerHTML = html;
      $("#managerDate").onchange = function () { state.managerDate = this.value; renderers.home(); };
    }).catch(function () { legacyManagerHomeRenderer(); });
  };

  var refSeq = 0;
  var refStore = {};
  function statusItemHtml(e) {
    refSeq += 1;
    var rid = "r" + refSeq;
    refStore[rid] = e.refs || [];
    var top = '<div class="si-top">' +
      (e.aff === "dept" ? '<a data-goto-dept="1">部门日常</a>' : '<a data-proj="' + esc(e.aff) + '">' + esc(e.affName) + "</a>") +
      (e.people || []).map(function (p) { return '<button class="person-chip" data-emp-name="' + esc(p) + '">' + esc(p) + "</button>"; }).join("") +
      (e.concl ? '<span class="badge-concl">💡 含新结论</span>' : "") + "</div>";
    var sourceTags = (e.cats || []).map(function (c) {
      var suggested = c.confirmed !== true && !c.manual;
      return '<a class="tag' + (suggested ? " tag-unconfirmed" : "") + '" data-cat="' + c.id + '" title="' +
        (suggested ? "系统自动匹配，员工尚未确认" : "来源日志事项的标签") + '">' + esc(c.name) + '</a>';
    }).join("");
    var meta = '<div class="si-meta"><span>相关工时 ' + (e.hours || 0) + " 小时</span>" +
      (e.status === "ongoing" && e.days ? "<span>已持续 " + e.days + " 个工作日</span>" : "") +
      (sourceTags ? '<span class="source-tags" title="这些标签继承自引用的完整日志事项，不是对本条摘要重新分类；同一原日志拆成多条进展时会重复。">来源日志标签：' + sourceTags + "</span>" : "") +
      '<button class="btn-ghost" data-refs="' + rid + '">⌗ ' + (e.refs || []).length + " 条引用</button>" +
      '<span class="summary-kind ' + (e.origin === "analysis" ? "is-analysis" : "") + '">' +
      (e.origin === "analysis" ? "系统归纳" : "事实摘要") + "</span></div>";
    var refs = '<div class="refs-box" id="' + rid + '">' + (e.refs || []).map(function (r) {
      return '<div class="ref-item"><b>' + esc(r.emp) + " · " + r.date + '</b> <a class="rlink" data-ref-full="' + r.itemId + '">查看原文</a><br>' + esc(r.excerpt) + "</div>";
    }).join("") + "</div>";
    return '<div class="status-item">' + top + '<div class="si-text">' +
      (e.status === "ongoing" && e.days ? '<span class="muted">已持续 ' + e.days + " 个工作日 · </span>" : "") + esc(e.text) + "</div>" + meta + refs + "</div>";
  }

  function bindStatusEvents(rootSel) {
    $$(rootSel + " [data-refs]").forEach(function (b) {
      b.onclick = function () { var box = $("#" + b.dataset.refs); if (box) box.classList.toggle("open"); };
    });
    $$(rootSel + " [data-ref-full]").forEach(function (a) {
      a.onclick = function () { openRefModal(+a.dataset.refFull); };
    });
    $$(rootSel + " [data-cat]").forEach(function (a) {
      a.onclick = function () { state.curCategory = +a.dataset.cat; go("category"); };
    });
    $$(rootSel + " [data-proj]").forEach(function (a) {
      a.onclick = function () { state.curProject = +a.dataset.proj; go("project"); };
    });
    $$(rootSel + " [data-goto-dept]").forEach(function (a) { a.onclick = function () { go("dept"); }; });
    $$(rootSel + " [data-emp-name]").forEach(function (b) {
      b.onclick = function () {
        api("/api/views/employee").then(function (d) {
          var m = (d.employees || []).filter(function (u) { return u.name === b.dataset.empName; })[0];
          if (m) { state.curEmployee = m.id; go("employee"); }
          else toast("无权查看该员工");
        });
      };
    });
  }

  function openRefModal(itemId) {
    api("/api/views/ref/" + itemId).then(function (d) {
      if (!d.ok) { toast(d.error || "无法查看"); return; }
      var r = d.ref;
      openModal("<h3>原始日志引用</h3><p><b>" + esc(r.emp) + "</b> · " + r.date + ' <span class="badge badge-fact">原始事实（最终提交内容）</span></p>' +
        '<div class="ref-item" style="margin-top:10px"><b>' + esc(r.affName) + "</b> · 工时 " + r.hours + " 小时<br>" + esc(r.text) + "</div>" +
        '<p class="muted" style="margin-top:10px">引用只指向员工最终提交的有效内容；草稿与已删除内容不作为引用依据。</p>');
    });
  }

  /* =====================================================
     项目视角
  ===================================================== */
  function fmtSyncTime(value) {
    if (!value) return "尚无缓存时间";
    try { return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
    catch (_) { return String(value); }
  }

  function projectSidebarHtml(d) {
    var projects = d.projects || [];
    var html = '<aside class="side-list project-rail" aria-label="项目列表">';
    if (projects.length) {
      html += '<div class="side-source-head"><span>全部项目</span><span class="side-count">' + projects.length + "</span></div>";
      projects.forEach(function (p) {
        var followed = state.follows.projects.indexOf(p.id) >= 0;
        var on = state.projectSource === "unified" && d.project && p.id === d.project.id;
        html += '<button class="side-item' + (on ? " on" : "") + '" data-pid="' + p.id + '"><span>' + esc(p.name) + "</span>" + (followed ? '<span class="star">★</span>' : "") + '<span class="spring"></span></button>';
      });
    }
    if (d.canViewDingtalkProjects) {
      html += '<button class="side-item' + (state.projectSource === "unassigned" ? " on" : "") + '" data-unassigned="1"><span>其他（未填写或未识别）</span><span class="spring"></span></button>';
    }
    if (state.user.capabilities && state.user.capabilities.supervisor) {
      html += '<button class="side-foot" id="gotoDept">部门日常（非项目）→</button>';
    }
    html += "</aside>";
    return html;
  }

  function rawTagHtml(c) {
    var suggested = c.confirmed !== true && !c.manual;
    return '<span class="tag' + (suggested ? " tag-unconfirmed" : "") + '" title="' + (suggested ? "系统自动匹配，员工尚未确认" : "员工已确认或手动选择") + '">' + esc(c.name) + "</span>";
  }

  function platformProjectHtml(d) {
    var pj = d.project;
    if (!pj) return '<div class="card empty-workbench"><h2>暂无项目</h2><p>日报中出现成本归属项目，或员工新建项目后，这里会自动形成项目汇总。</p></div>';
    var followedCur = state.follows.projects.indexOf(pj.id) >= 0;
    var html = '<section class="project-hero platform"><div><div class="project-kicker">按成本归属项目统一归集</div><h2>' + esc(pj.name) + '</h2><p>负责人：' + esc(pj.owner || "—") + (pj.descr ? " · " + esc(pj.descr) : "") + '</p></div><div class="project-hero-actions"><div class="project-date-tools"><label>日报日期<input id="projectDate" type="date" value="' + esc(d.date || state.dingDate || "") + '"></label>' + (d.canViewDingtalkProjects ? '<button class="btn" id="projectSync">重新同步</button>' : "") + '</div><button class="follow-btn' + (followedCur ? " on" : "") + '" id="followProj">' + (followedCur ? "★ 已关注" : "☆ 关注") + "</button></div></section>";
    html += '<div class="project-content-tabs" id="projectContentTabs" role="tablist" aria-label="项目内容"><button type="button" id="projectReportsTab" role="tab" aria-selected="true" aria-controls="unifiedProjectSection" data-project-tab="reports">日报汇总</button><button type="button" id="projectTasksTab" role="tab" aria-selected="false" aria-controls="vivoProjectSection" tabindex="-1" data-project-tab="tasks">研发任务 <small>VivoFlow</small></button></div>';
    html += '<div id="unifiedProjectSection" role="tabpanel" aria-labelledby="projectReportsTab">' + (d.canViewDingtalkProjects
      ? '<div class="project-loading"><span class="loading-ring"></span><strong>正在载入项目日报…</strong></div>'
      : unifiedProjectContentHtml({ ok: true, date: d.date, dateLabel: d.dateLabel, activity: { totalHours: 0, participantCount: 0, itemCount: 0, reportCount: 0 } }, pj)) + "</div>";
    html += '<section class="vivo-panel" id="vivoProjectSection" role="tabpanel" aria-labelledby="projectTasksTab" hidden></section>';
    return html;
  }

  function dingMediaHtml(items, kind) {
    if (!items || !items.length) return "";
    return '<div class="ding-media">' + items.map(function (a) {
      var label = esc(a.name || (kind === "image" ? "图片" : "附件"));
      if (a.url) return '<a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + label + " ↗</a>";
      return '<span title="请打开原日报查看">' + label + " · 原日报内查看</span>";
    }).join("") + "</div>";
  }

  function dingReportHtml(report) {
    var rows = (report.contents || []).filter(function (f) { return String(f.value || "").trim() || (f.attachments || []).length; }).map(function (f) {
      return '<div class="ding-field"><div class="ding-field-key">' + esc(f.key || "日报字段") + '</div><div class="ding-field-value">' + (String(f.value || "").trim() ? '<div class="ding-original-text">' + esc(f.value) + "</div>" : "") + dingMediaHtml(f.attachments, "attachment") + "</div></div>";
    }).join("");
    rows += report.images && report.images.length ? '<div class="ding-field"><div class="ding-field-key">图片</div><div class="ding-field-value">' + dingMediaHtml(report.images, "image") + "</div></div>" : "";
    return '<section class="ding-report"><div class="ding-report-head"><span><span class="original-badge">日报原文</span>' + esc(report.templateName || "工作日报") + (report.createTime ? " · " + esc(fmtSyncTime(report.createTime)) : "") + '</span>' + (report.openInDingtalkUrl ? '<a href="' + esc(report.openInDingtalkUrl) + '" target="_blank" rel="noopener noreferrer">打开原日报 ↗</a>' : "") + "</div>" + (rows || '<div class="empty-tip">该日报没有可显示文字，可能仅含附件。</div>') + "</section>";
  }

  function platformReportHtml(items) {
    var suffixes = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
    var rows = items.map(function (it, index) {
      var suffix = items.length > 1 ? (suffixes[index] || String(index + 1)) : "";
      var html = '<div class="ding-field"><div class="ding-field-key">事项-结果' + suffix + '</div><div class="ding-field-value"><div class="ding-original-text">' + esc(it.text) + "</div></div></div>";
      html += '<div class="ding-field"><div class="ding-field-key">工时统计' + suffix + '</div><div class="ding-field-value"><div class="ding-original-text">' + esc(it.hours) + "</div></div></div>";
      if ((it.cats || []).length) html += '<div class="ding-field"><div class="ding-field-key">分类标签' + suffix + '</div><div class="ding-field-value"><div class="raw-log-tags">' + it.cats.map(rawTagHtml).join("") + "</div></div></div>";
      if ((it.atts || []).length) html += '<div class="ding-field"><div class="ding-field-key">附件' + suffix + '</div><div class="ding-field-value"><div class="raw-log-atts">' + it.atts.map(function (a) { return '<a href="/api/attachment/' + a.id + '">' + esc(a.name) + "</a>"; }).join("、") + "</div></div></div>";
      return html;
    }).join("");
    return '<section class="ding-report"><div class="ding-report-head"><span><span class="original-badge">日报原文</span>工作日报 · ' + items.length + " 项</span></div>" + rows + "</section>";
  }

  function unifiedProjectContentHtml(data, project) {
    var people = new Map();
    var errors = [];
    var activity = data.activity || { totalHours: 0, participantCount: 0, itemCount: 0, reportCount: 0 };
    function personOf(name) {
      var key = String(name || "未命名");
      if (!people.has(key)) people.set(key, { name: key, entries: [], search: [key] });
      return people.get(key);
    }

    var platformReports = new Map();
    (project.timeline || []).forEach(function (day) {
      (day.items || []).forEach(function (item) {
        var key = String(item.emp) + ":" + String(item.logId || item.itemId);
        var group = platformReports.get(key) || { name: item.emp, items: [] };
        group.items.push(item);
        platformReports.set(key, group);
      });
    });
    platformReports.forEach(function (group) {
      var person = personOf(group.name);
      person.entries.push(platformReportHtml(group.items));
      group.items.forEach(function (item) { person.search.push(item.text); });
    });

    if (data.customProjectView) {
      (data.customProjectView.orgs || []).forEach(function (org) {
        errors = errors.concat(org.errors || []);
        (org.submitted || []).forEach(function (emp) {
          var person = personOf(emp.name || emp.userid);
          (emp.reports || []).forEach(function (report) {
            person.entries.push(dingReportHtml(report));
            (report.contents || []).forEach(function (field) { person.search.push(field.key, field.value); });
          });
        });
      });
    }

    var platformHours = Number(project.hours7total || 0);
    var totalHours = Math.round((platformHours + Number(activity.totalHours || 0)) * 10) / 10;
    var itemCount = Number(project.itemCount || 0) + Number(activity.itemCount || 0);
    var reportCount = Number(project.reportCount || 0) + Number(activity.reportCount || 0);
    var peopleList = Array.from(people.values());
    var projectName = project.name || "其他（未填写或未识别）";
    var html = '<section class="project-health" aria-label="当日日报概况"><div><strong>' + totalHours + ' h</strong><span>投入工时</span></div><div><strong>' + peopleList.length + ' 人</strong><span>参与人员</span></div><div><strong>' + itemCount + '</strong><span>日报事项</span></div><div><strong>' + reportCount + ' 份</strong><span>日报份数</span></div></section>';
    html += '<section class="ding-list-card unified-report-list"><div class="ding-list-toolbar"><div><h3>日报明细</h3><p>' + esc(data.dateLabel || data.date || state.dingDate || "") + ' · ' + peopleList.length + ' 人 · ' + reportCount + ' 份日报</p></div><div class="ding-list-actions"><input id="reportSearch" type="search" placeholder="搜索姓名或日报内容"><button class="btn-ghost" id="reportExpand">全部展开</button><button class="btn-ghost" id="reportCollapse">全部收起</button></div></div>';
    if (!data.ok) html += '<div class="report-load-warning">部分日报读取失败：' + esc(data.error || "未知错误") + ' <button class="btn-ghost" id="reportRetry">重试</button></div>';
    if (!peopleList.length) html += '<div class="empty-tip compact-empty">该日没有进入「' + esc(projectName) + '」的日报。可切换上方日期' + (data.ok ? "，或重新同步后再查看。" : "。") + "</div>";
    peopleList.forEach(function (person, index) {
      var haystack = person.search.join(" ").toLocaleLowerCase("zh-CN");
      html += '<details class="report-employee" data-report-text="' + esc(haystack) + '"' + (index < 3 ? " open" : "") + '><summary><span class="employee-avatar">' + esc((person.name || "·").slice(0, 1)) + '</span><span><strong>' + esc(person.name) + '</strong><small>' + person.entries.length + ' 份日报</small></span><span class="spring"></span><span class="details-hint">日报原文</span></summary><div class="report-employee-body">' + person.entries.join("") + "</div></details>";
    });
    if (errors.length) html += '<details class="read-errors"><summary>查看 ' + errors.length + ' 条读取失败</summary><ul>' + errors.map(function (e) { return '<li>' + esc(e.name || e.userid) + "：" + esc(e.reason || "未知错误") + "</li>"; }).join("") + "</ul></details>";
    return html + "</section>";
  }

  function bindUnifiedProjectUi(project, targetId) {
    if ($("#projectDate")) $("#projectDate").onchange = function () { state.dingDate = this.value; renderers.project(); };
    if ($("#projectSync")) $("#projectSync").onclick = function () { loadDingProject(project, true, targetId); };
    if ($("#reportRetry")) $("#reportRetry").onclick = function () { loadDingProject(project, false, targetId); };
    if ($("#reportSearch")) $("#reportSearch").oninput = function () {
      var q = this.value.trim().toLocaleLowerCase("zh-CN");
      $$("#projectMain .report-employee").forEach(function (el) { el.hidden = q && el.dataset.reportText.indexOf(q) < 0; });
    };
    if ($("#reportExpand")) $("#reportExpand").onclick = function () { $$("#projectMain .report-employee:not([hidden])").forEach(function (el) { el.open = true; }); };
    if ($("#reportCollapse")) $("#reportCollapse").onclick = function () { $$("#projectMain .report-employee").forEach(function (el) { el.open = false; }); };
  }

  function renderDingProjectData(data, project, targetId) {
    var pane = targetId ? $("#" + targetId) : $("#projectMain");
    if (!pane) return;
    if (data.ok) state.dingDate = data.date || state.dingDate;
    var isOthers = String(project.id) === "others" || project.view === "catalog:others";
    var projectName = isOthers ? "其他（未填写或未识别）" : project.name;
    var platformProject = targetId ? project : { id: project.id, name: projectName, timeline: [], people: [], hours7total: 0, itemCount: 0, reportCount: 0 };
    var html = unifiedProjectContentHtml(data, platformProject);
    if (!targetId) {
      var projectDescription = isOthers ? "成本归属项目为空或无法识别的日报。" : "按成本归属项目统一归集。";
      html = '<section class="project-hero"><div><div class="project-kicker">按成本归属项目统一归集</div><h2>' + esc(projectName) + '</h2><p>' + esc(projectDescription) + '</p></div><div class="project-hero-actions"><div class="project-date-tools"><label>日报日期<input id="projectDate" type="date" value="' + esc(data.date || state.dingDate || "") + '"></label><button class="btn" id="projectSync">重新同步</button></div></div></section>' + html;
    }
    pane.innerHTML = html;
    bindUnifiedProjectUi(project, targetId);
  }

  function loadDingProject(project, refresh, targetId) {
    var requestSeq = ++state.dingProjectRequestSeq;
    var pane = targetId ? $("#" + targetId) : $("#projectMain");
    if (!pane) return;
    pane.innerHTML = '<div class="project-loading"><span class="loading-ring"></span><strong>' + (refresh ? "正在重新同步项目日报…" : "正在载入项目日报…") + '</strong><p>首次全量读取可能需要一些时间，请留在当前页面。</p></div>';
    var params = new URLSearchParams({ view: project.view || ("custom:" + project.id) });
    if (state.dingDate) params.set("date", state.dingDate);
    if (refresh) params.set("refresh", "1");
    api("/api/workbench/daily-reports?" + params.toString()).then(function (data) {
      if (requestSeq !== state.dingProjectRequestSeq) return;
      renderDingProjectData(data, project, targetId);
    }).catch(function (err) {
      if (requestSeq !== state.dingProjectRequestSeq) return;
      renderDingProjectData({ ok: false, error: err && err.message ? err.message : "网络异常" }, project, targetId);
    });
  }

  function projectManagementBarHtml(catalog) {
    var projects = catalog.projects || [];
    var activeCount = projects.filter(function (project) { return project.status === "in_progress"; }).length;
    var manageableCount = projects.filter(function (project) { return project.canManage; }).length;
    return '<section class="project-management-bar"><div><strong>项目管理</strong><span>集中维护项目、负责人、成员和状态；日报填写处只负责选择项目。</span></div>' +
      '<div class="project-management-actions"><span class="muted">进行中 ' + activeCount + ' · 可管理 ' + manageableCount + '</span><button class="btn" id="projectManage">查看与设置</button>' +
      (catalog.canCreate ? '<button class="btn btn-primary" id="projectCreate">新建项目</button>' : "") + "</div></section>";
  }

  function projectPeopleOptions(people, selectedId, allowedIds) {
    var allowed = allowedIds ? new Set(allowedIds.map(Number)) : null;
    return people.filter(function (person) { return !allowed || allowed.has(Number(person.id)); }).map(function (person) {
      return '<option value="' + person.id + '"' + (Number(person.id) === Number(selectedId) ? " selected" : "") + '>' +
        esc(person.name) + (person.dept ? " · " + esc(person.dept) : "") + "</option>";
    }).join("");
  }

  function openProjectEditor(project, meta) {
    var isNew = !project;
    var people = meta.people || [];
    var financeCodes = isNew ? [] : (project.financeCodes || []);
    var allowedOwnerIds = isNew
      ? (meta.createOwnerUserIds || [])
      : project.owner.id === state.user.id ? null : Array.from(new Set((meta.assignableOwnerUserIds || []).map(Number).concat([Number(project.owner.id)])));
    var ownerId = isNew
      ? (allowedOwnerIds.indexOf(state.user.id) >= 0 ? state.user.id : Number(allowedOwnerIds[0] || 0))
      : project.owner.id;
    var memberIds = new Set(isNew ? [ownerId] : (project.members || []).map(function (member) { return Number(member.id); }));
    memberIds.add(Number(ownerId));
    var memberRows = people.map(function (person) {
      return '<label class="project-member-option"><input type="checkbox" data-project-member="' + person.id + '"' +
        (memberIds.has(Number(person.id)) ? " checked" : "") + '><span><b>' + esc(person.name) + '</b><small>' + esc(person.isExternal ? "外部账号" : (person.dept || "未分组")) +
        (person.title ? " · " + esc(person.title) : "") + "</small></span></label>";
    }).join("");
    var html = '<div class="project-editor"><div class="project-editor-heading"><div><h3>' + (isNew ? "新建项目" : "设置项目") +
      '</h3><p>项目建立后，成员才能在日报中选择它；日报助手不会自动新建项目。</p></div>' +
      (!isNew ? '<span class="project-status ' + (project.status === "completed" ? "is-completed" : "") + '">' + (project.status === "completed" ? "已完成" : "进行中") + "</span>" : "") +
      '</div><label class="project-field"><span>项目名称</span><input id="projectName" maxlength="120" value="' + esc(project ? project.name : "") + '" placeholder="输入清晰、唯一的项目名称"></label>' +
      '<label class="project-field"><span>项目负责人</span><select id="projectOwner">' + projectPeopleOptions(people, ownerId, allowedOwnerIds) + "</select></label>" +
      '<div class="project-field"><span>项目成员</span><p class="field-help">负责人会自动加入成员；成员可在日报中选择该项目。</p><div class="project-member-list">' + memberRows + "</div></div>" +
      '<label class="project-field"><span>财务项目编码</span><p class="field-help">每行填写一个编码。未配置时不会阻止成员提交日报；配置后，成员可在日报中选择对应编码。</p><textarea id="projectFinanceCodes" rows="5" maxlength="20100" placeholder="例如：Y029-阿凡达AFD技术">' + esc(financeCodes.map(function (code) { return code.name || code.code; }).join("\n")) + "</textarea></label>" +
      (!isNew ? '<label class="project-field"><span>项目状态</span><select id="projectStatus"><option value="in_progress"' + (project.status === "in_progress" ? " selected" : "") + '>进行中</option><option value="completed"' + (project.status === "completed" ? " selected" : "") + ">已完成</option></select></label>" : "") +
      '<div class="project-editor-actions"><button class="btn" id="projectEditorCancel">取消</button><button class="btn btn-primary" id="projectEditorSave">' + (isNew ? "建立项目" : "保存设置") + "</button></div></div>";
    openModal(html, "project-manage-modal");
    $("#projectEditorCancel").onclick = closeModal;
    function ensureOwnerMember() {
      var selectedOwner = Number($("#projectOwner").value || 0);
      var checkbox = $('[data-project-member="' + selectedOwner + '"]');
      if (checkbox) checkbox.checked = true;
    }
    $("#projectOwner").onchange = ensureOwnerMember;
    $("#projectEditorSave").onclick = function () {
      var saveButton = this;
      var name = $("#projectName").value.trim();
      var nextOwnerId = Number($("#projectOwner").value || 0);
      ensureOwnerMember();
      var members = $$("[data-project-member]").filter(function (input) { return input.checked; }).map(function (input) { return Number(input.dataset.projectMember); });
      if (!name) { toast("请输入项目名称"); return; }
      if (!nextOwnerId) { toast("请选择项目负责人"); return; }
      saveButton.disabled = true;
      saveButton.textContent = "正在保存…";
      var request;
      if (isNew) {
        request = api("/api/projects", { body: { name: name, ownerUserId: nextOwnerId, memberUserIds: members } }).then(function (result) {
          if (!result.ok) throw new Error(result.error || "项目建立失败");
          return result.project;
        });
      } else {
        request = api("/api/projects/" + project.id, { method: "PUT", body: { name: name, memberUserIds: members } }).then(function (result) {
          if (!result.ok) throw new Error(result.error || "项目设置保存失败");
          return result.project;
        });
        if (nextOwnerId !== Number(project.owner.id)) {
          request = request.then(function () {
            return api("/api/projects/" + project.id + "/transfer", { body: { newOwnerUserId: nextOwnerId } });
          }).then(function (result) {
            if (!result.ok) throw new Error(result.error || "负责人转交失败");
            return result.project;
          });
        }
        var nextStatus = $("#projectStatus").value;
        if (nextStatus !== project.status) {
          request = request.then(function () {
            return api("/api/projects/" + project.id + "/status", { body: { status: nextStatus } });
          }).then(function (result) {
            if (!result.ok) throw new Error(result.error || "项目状态保存失败");
            return result.project;
          });
        }
      }
      request = request.then(function (savedProject) {
        var input = $("#projectFinanceCodes");
        var codes = input ? input.value.split(/\r?\n/).map(function (value) { return value.trim(); }).filter(Boolean) : [];
        return api("/api/projects/" + savedProject.id + "/finance-codes", { method: "PUT", body: { codes: codes } }).then(function (result) {
          if (!result.ok) throw new Error(result.error || "财务项目编码保存失败");
          return savedProject;
        });
      });
      request.then(function (savedProject) {
        state.curProject = savedProject.id;
        state.projectSource = "unified";
        closeModal();
        toast(isNew ? "项目已建立并开放给所选成员" : "项目设置已保存");
        renderers.project();
      }).catch(function (error) {
        saveButton.disabled = false;
        saveButton.textContent = isNew ? "建立项目" : "保存设置";
        toast(error && error.message ? error.message : "保存失败");
      });
    };
  }

  function openProjectDirectory(catalog, meta) {
    var projects = catalog.projects || [];
    var html = '<div class="project-directory"><div class="project-editor-heading"><div><h3>项目管理</h3><p>项目创建与维护集中在这里，不会出现在日报填写流程里。</p></div>' +
      (catalog.canCreate ? '<button class="btn btn-primary" id="directoryCreate">新建项目</button>' : "") + "</div><div class=\"project-directory-list\">";
    if (!projects.length) html += '<div class="empty-tip">暂无可管理或可查看的项目。</div>';
    projects.forEach(function (project) {
      html += '<article class="project-directory-item"><div><div><strong>' + esc(project.name) + '</strong><span class="project-status ' + (project.status === "completed" ? "is-completed" : "") + '">' +
        (project.status === "completed" ? "已完成" : "进行中") + '</span></div><p>负责人 ' + esc(project.owner.name) + ' · ' + project.members.length + " 名成员</p></div>" +
        (project.canManage ? '<button class="btn" data-edit-project="' + project.id + '">设置</button>' : '<span class="muted">只读</span>') + "</article>";
    });
    html += "</div></div>";
    openModal(html, "project-manage-modal");
    if ($("#directoryCreate")) $("#directoryCreate").onclick = function () { openProjectEditor(null, meta); };
    $$("[data-edit-project]").forEach(function (button) {
      button.onclick = function () {
        var selected = projects.filter(function (project) { return project.id === Number(button.dataset.editProject); })[0];
        if (selected) openProjectEditor(selected, meta);
      };
    });
  }

  function bindProjectManagement(catalog, meta) {
    if ($("#projectManage")) $("#projectManage").onclick = function () { openProjectDirectory(catalog, meta); };
    if ($("#projectCreate")) $("#projectCreate").onclick = function () { openProjectEditor(null, meta); };
  }

  function bindPlatformProject(pj) {
    bindStatusEvents("#page-project");
    bindUnifiedProjectUi(pj, "unifiedProjectSection");
    if (window.VivoFlowPanel) window.VivoFlowPanel.mount({ projectId: pj.id, projectName: pj.name, date: state.dingDate, toast: toast });
    if ($("#followProj")) $("#followProj").onclick = function () {
      api("/api/follows/toggle", { body: { kind: "p", targetId: pj.id } }).then(function (r) { if (r.ok) { state.follows = r.follows; toast(r.followed ? "已关注，将影响主管首页「我的关注」" : "已取消关注"); renderers.project(); } });
    };
  }

  renderers.project = function () {
    var requestSeq = ++state.projectPageRequestSeq;
    ++state.dingProjectRequestSeq;
    var projectParams = new URLSearchParams();
    if (state.curProject) projectParams.set("id", state.curProject);
    if (state.dingDate) projectParams.set("date", state.dingDate);
    var url = "/api/views/project" + (projectParams.toString() ? "?" + projectParams.toString() : "");
    Promise.all([
      api(url),
      state.meta ? Promise.resolve(state.meta) : api("/api/fill/meta"),
      api("/api/projects?includeCompleted=1"),
      api("/api/projects/manage-meta")
    ]).then(function (rs) {
      if (requestSeq !== state.projectPageRequestSeq) return;
      var d = rs[0];
      state.meta = rs[1];
      var projectCatalog = rs[2];
      var projectMeta = rs[3];
      if (!d.ok) { $("#page-project").innerHTML = '<p class="empty-tip">' + esc(d.error || "加载失败") + "</p>"; return; }
      if (!projectCatalog.ok || !projectMeta.ok) { $("#page-project").innerHTML = '<p class="empty-tip">' + esc(projectCatalog.error || projectMeta.error || "项目管理加载失败") + "</p>"; return; }
      state.dingDate = d.date || state.dingDate;
      state.follows = d.follows || { projects: [], categories: [] };
      var reportProjects = d.dailyReportProjects || [];
      if (state.projectSource === "dingtalk") {
        if (state.curDingProject === "others") {
          state.projectSource = "unassigned";
        } else {
          var legacy = reportProjects.filter(function (p) { return p.id === state.curDingProject; })[0];
          var migrated = legacy && (d.projects || []).filter(function (p) { return p.name === legacy.name; })[0];
          if (migrated) {
            state.projectSource = "unified";
            state.curProject = migrated.id;
            if (!d.project || d.project.id !== migrated.id) { renderers.project(); return; }
          } else if (!legacy) {
            state.projectSource = "unified";
          }
        }
      }
      if (d.project) state.curProject = d.project.id;
      var html = '<div class="page-head project-page-head"><div><h1>项目工作台</h1><div class="sub">管理项目与成员，按项目查看日报原文和研发任务进展</div></div></div>';
      html += projectManagementBarHtml(projectCatalog);
      html += '<div class="split project-workbench">' + projectSidebarHtml(d) + '<main class="main-pane" id="projectMain"></main></div>';
      $("#page-project").innerHTML = html;
      bindProjectManagement(projectCatalog, projectMeta);
      $$("#page-project [data-pid]").forEach(function (b) { b.onclick = function () { state.projectSource = "unified"; state.curProject = +b.dataset.pid; state.projCatFilter = 0; renderers.project(); }; });
      $$("#page-project [data-unassigned]").forEach(function (b) { b.onclick = function () { state.projectSource = "unassigned"; state.projCatFilter = 0; renderers.project(); }; });
      if ($("#gotoDept")) $("#gotoDept").onclick = function () { go("dept"); };
      if (state.projectSource === "dingtalk") {
        var selected = reportProjects.filter(function (p) { return p.id === state.curDingProject; })[0];
        loadDingProject(selected, false);
      } else if (state.projectSource === "unassigned") {
        loadDingProject({ id: "others", name: "其他（未填写或未识别）", view: "catalog:others" }, false);
      } else {
        $("#projectMain").innerHTML = platformProjectHtml(d);
        if (d.project) {
          bindPlatformProject(d.project);
          if (d.canViewDingtalkProjects) {
            d.project.view = "catalog:" + d.project.id;
            loadDingProject(d.project, false, "unifiedProjectSection");
          }
        }
      }
    });
  };

  /* =====================================================
     分类视角
  ===================================================== */
  renderers.category = function () {
    var url = "/api/views/category" + (state.curCategory ? "?id=" + state.curCategory : "");
    Promise.all([api(url), state.meta ? Promise.resolve(state.meta) : api("/api/fill/meta")]).then(function (rs) {
      var d = rs[0];
      state.meta = rs[1];
      if (!d.ok) { $("#page-category").innerHTML = '<p class="empty-tip">' + esc(d.error || "加载失败") + "</p>"; return; }
      state.follows = d.follows || state.follows;
      var html = '<div class="page-head"><div><h1>分类视角</h1><div class="sub">分类表达事项的多维属性，用于跨项目、跨人员、跨日期聚合 · 默认汇总最近 7 个工作日</div></div></div>';
      if (!d.category) {
        html += '<div class="cat-grid">' + d.categories.map(function (c) {
          return '<div class="cat-card" data-cid="' + c.id + '">' + esc(c.name) + "</div>";
        }).join("") + "</div>";
        $("#page-category").innerHTML = html;
        $$("#page-category [data-cid]").forEach(function (el) {
          el.onclick = function () { state.curCategory = +el.dataset.cid; state.catProjFilter = ""; renderers.category(); };
        });
        return;
      }
      var cat = d.category;
      html += '<p style="margin-bottom:10px"><a id="backCats">← 返回分类列表</a></p><div class="split"><div class="side-list">';
      d.categories.forEach(function (c) {
        var followed = state.follows.categories.indexOf(c.id) >= 0;
        html += '<button class="side-item' + (c.id === cat.id ? " on" : "") + '" data-cid="' + c.id + '"><span>' + esc(c.name) + "</span>" + (followed ? '<span class="star">★</span>' : "") + '<span class="spring"></span><span class="own">使用 ' + c.count + " 次</span></button>";
      });
      html += '</div><div class="main-pane">';
      var followedCur = state.follows.categories.indexOf(cat.id) >= 0;
      html += '<div class="card"><div style="display:flex;align-items:flex-start;gap:10px"><div style="flex:1"><div style="font-size:17px;font-weight:700">分类：' + esc(cat.name) + '</div><div class="muted">近 7 个工作日汇总 · 全池累计使用 ' + cat.count + ' 次</div></div><button class="follow-btn' + (followedCur ? " on" : "") + '" id="followCat">' + (followedCur ? "★ 已关注" : "☆ 关注") + "</button></div>";
      html += '<div class="filter-strip">按项目筛选：<button class="filter-chip' + (!state.catProjFilter ? " on" : "") + '" data-cpf="">全部</button>';
      cat.projects.forEach(function (p) {
        html += '<button class="filter-chip' + (state.catProjFilter === p.aff ? " on" : "") + '" data-cpf="' + esc(p.aff) + '">' + esc(p.name) + "</button>";
      });
      if (state.catProjFilter) html += '<span class="muted">已按「' + esc(affName(state.catProjFilter)) + "」筛选，再点一次或点「全部」恢复</span>";
      html += "</div></div>";
      var matches = function (e) { return !state.catProjFilter || String(e.aff) === String(state.catProjFilter); };
      html += '<div class="stat-grid three">' +
        '<div class="stat-card"><div class="v">' + cat.projects.length + '</div><div class="k">涉及项目 / 归属</div></div>' +
        '<div class="stat-card"><div class="v">' + cat.people.length + ' 人</div><div class="k">相关人员</div></div>' +
        '<div class="stat-card"><div class="v">' + cat.hours + ' h</div><div class="k">投入工时（7 日' + (state.catProjFilter ? " · 筛选下总量不变" : "") + ")</div></div></div>";
      html += '<div class="card"><h3 class="sec-title">涉及项目 / 归属</h3><p>' + cat.projects.map(function (p) {
        return p.aff === "dept" ? '<a data-goto-dept="1">部门日常</a>' : '<a data-proj="' + esc(p.aff) + '" style="margin-right:12px">' + esc(p.name) + "</a>";
      }).join(" ") + '</p><p style="margin-top:8px" class="muted">相关人员：</p><p>' + cat.people.map(function (n) { return '<button class="person-chip" data-emp-name="' + esc(n) + '">' + esc(n) + "</button>"; }).join("") + "</p></div>";
      var prog = cat.progress.filter(matches);
      html += '<div class="card"><h3 class="sec-title">重要进展</h3>' + (prog.length ? prog.map(statusItemHtml).join("") : '<p class="empty-tip">该项目下暂无记录</p>') + "</div>";
      var blk = cat.blockers.filter(matches);
      html += '<div class="card"><h3 class="sec-title">卡点（新增 / 持续）</h3>';
      if (!blk.length) html += '<p class="empty-tip">该项目下暂无记录</p>';
      else {
        var news = blk.filter(function (b) { return b.status === "new"; });
        var ong = blk.filter(function (b) { return b.status !== "new"; });
        if (news.length) html += '<div class="blk-group">今日新增</div>' + news.map(statusItemHtml).join("");
        if (ong.length) html += '<div class="blk-group">持续中</div>' + ong.map(statusItemHtml).join("");
      }
      html += "</div>";
      var refs = cat.refs.filter(matches);
      html += '<div class="card"><h3 class="sec-title">原始日志引用</h3>' + (refs.length ? refs.map(function (r) {
        return '<div class="ref-item"><b>' + esc(r.emp) + " · " + r.date + '</b>（' + esc(r.affName) + '） <a class="rlink" data-ref-full="' + r.itemId + '">查看原文</a><br>' + esc(r.excerpt) + "</div>";
      }).join("") : '<p class="empty-tip">该项目下暂无记录</p>') + "</div></div></div>";
      $("#page-category").innerHTML = html;
      bindStatusEvents("#page-category");
      $("#backCats").onclick = function () { state.curCategory = 0; renderers.category(); };
      $$("#page-category [data-cid]").forEach(function (b) {
        b.onclick = function () { state.curCategory = +b.dataset.cid; state.catProjFilter = ""; renderers.category(); };
      });
      $$("#page-category [data-cpf]").forEach(function (b) {
        b.onclick = function () {
          var v = b.dataset.cpf;
          state.catProjFilter = state.catProjFilter === v ? "" : v;
          renderers.category();
        };
      });
      $("#followCat").onclick = function () {
        api("/api/follows/toggle", { body: { kind: "c", targetId: cat.id } }).then(function (r) {
          if (r.ok) { state.follows = r.follows; toast(r.followed ? "已关注，将影响主管首页「我的关注」" : "已取消关注"); renderers.category(); }
        });
      };
    });
  };

  /* =====================================================
     员工视角
  ===================================================== */
  renderers.employee = function () {
    var url = "/api/views/employee" + (state.curEmployee ? "?id=" + state.curEmployee : "");
    Promise.all([api(url), state.meta ? Promise.resolve(state.meta) : api("/api/fill/meta")]).then(function (rs) {
      var d = rs[0];
      state.meta = rs[1];
      if (!d.ok) { $("#page-employee").innerHTML = '<p class="empty-tip">' + esc(d.error || "加载失败") + "</p>"; return; }
      var html = '<div class="page-head"><div><h1>员工日报</h1><div class="sub">直接查看最近 7 个工作日的最终提交原文 · 可见范围遵循当前权限</div></div></div>';
      if (d.selfOnly) {
        html += '<div class="notice-inline">当前角色仅可查看本人汇总与日志；查看其他成员需管理角色权限。</div>';
      }
      if (!d.employee) { html += '<p class="empty-tip">暂无可见员工</p>'; $("#page-employee").innerHTML = html; return; }
      state.curEmployee = d.employee.id;
      html += '<div class="split"><div class="side-list">';
      d.employees.forEach(function (u) {
        html += '<button class="side-item' + (u.id === d.employee.id ? " on" : "") + '" data-uid="' + u.id + '"><span>' + esc(u.name) + '</span><span class="spring"></span><span class="own">' + esc(u.title || "") + "</span></button>";
      });
      html += '</div><div class="main-pane">';
      var e = d.employee;
      html += '<div class="card"><div style="font-size:17px;font-weight:700">' + esc(e.name) + '</div><div class="muted">' + esc(e.title || "") + " · 近 7 个工作日</div></div>";
      html += '<div class="card direct-originals"><div class="section-heading"><div><h3>日报原文</h3><p>员工最终提交内容，不经过 AI 总结或改写</p></div><span class="original-badge">最终提交</span></div>';
      if (e.logs.length === 0) html += '<p class="empty-tip">近 7 个工作日暂无已提交日报</p>';
      e.logs.forEach(function (l) {
        html += '<div class="timeline-day"><div class="timeline-head timeline-head-static"><span><b>' + l.date + '</b> · ' + l.items + ' 条原始事项</span><span class="spring"></span><span>' + qualityBadge(l.quality) + '</span></div><div class="timeline-body open">';
        (l.entries || []).forEach(function (it) {
          html += '<article class="raw-log"><div class="raw-log-head"><strong>' + esc(it.affName) + '</strong><span>工时 ' + it.hours + ' 小时</span></div><div class="raw-log-tags">' + (it.cats || []).map(rawTagHtml).join("") + '</div><div class="raw-log-text">' + esc(it.text) + "</div>" + (it.atts.length ? '<div class="raw-log-atts">附件：' + it.atts.map(function (a) { return '<a href="/api/attachment/' + a.id + '">' + esc(a.name) + "</a>"; }).join("、") + "</div>" : "") + "</article>";
        });
        html += "</div></div>";
      });
      html += "</div>";
      html += '<div class="card"><h3 class="sec-title">近 7 日参与项目与部门日常 · 工时分布（共 ' + e.totalHours + " 小时）</h3>";
      if (e.workload.length === 0) html += '<p class="empty-tip">近 7 个工作日暂无已提交日志</p>';
      e.workload.forEach(function (w) {
        html += '<div class="ratio-row"><span class="r-name">' + esc(w.name) + '</span><span class="r-track"><span class="r-fill" style="width:' + w.pc + '%"></span></span><span class="r-pc">' + w.hours + " h · " + w.pc + "%</span></div>";
      });
      html += "</div>";
      html += '<div class="card"><h3 class="sec-title">日志质量标记（近 7 个工作日）</h3><div class="quality-count">';
      if (e.qualities.ex) html += '<span class="badge badge-ex">Excellent</span> × ' + e.qualities.ex;
      if (e.qualities.vg) html += '<span class="badge badge-vg">Very Good</span> × ' + e.qualities.vg;
      if (e.qualities.good) html += '<span class="badge badge-good">Good</span> × ' + e.qualities.good;
      html += '<span class="muted">其余为「一般」（不显示标记）</span></div></div>';
      html += "</div></div>";
      $("#page-employee").innerHTML = html;
      $$("#page-employee [data-uid]").forEach(function (b) {
        b.onclick = function () { state.curEmployee = +b.dataset.uid; renderers.employee(); };
      });
    });
  };

  /* =====================================================
     部门日常
  ===================================================== */
  renderers.dept = function () {
    api("/api/views/dept").then(function (d) {
      if (!d.ok) { $("#page-dept").innerHTML = '<p class="empty-tip">' + esc(d.error || "加载失败") + "</p>"; return; }
      var entries = state.deptFilter ? d.entries.filter(function (e) { return e.cats.some(function (c) { return c.id === state.deptFilter; }); }) : d.entries;
      var hours = Math.round(entries.reduce(function (s, e) { return s + e.hours; }, 0) * 10) / 10;
      var people = {};
      entries.forEach(function (e) { people[e.emp] = 1; });
      var html = '<div class="page-head"><div><h1>部门日常视角</h1><div class="sub">近 7 个工作日非项目工作汇总</div></div></div>';
      html += '<div class="notice-inline">「部门日常」是没有具体项目、但属于部门职责范围的工作，<b>不是一个项目</b>；它按部门聚合，可通过分类继续区分工作内容，工时与分析价值不丢失。</div>';
      html += '<div class="card"><div class="filter-strip" style="border-top:0;margin-top:0;padding-top:0">按分类筛选：<button class="filter-chip' + (!state.deptFilter ? " on" : "") + '" data-df="0">全部</button>' +
        d.cats.map(function (c) { return '<button class="filter-chip' + (state.deptFilter === c.id ? " on" : "") + '" data-df="' + c.id + '">' + esc(c.name) + "</button>"; }).join("") + "</div></div>";
      html += '<div class="stat-grid three">' +
        '<div class="stat-card"><div class="v">' + hours + ' h</div><div class="k">非项目工时（7 日' + (state.deptFilter ? " · 已筛选" : "") + ')</div></div>' +
        '<div class="stat-card"><div class="v">' + Object.keys(people).length + ' 人</div><div class="k">涉及人员</div></div>' +
        '<div class="stat-card"><div class="v">' + entries.length + '</div><div class="k">工作记录条数</div></div></div>';
      html += '<div class="card"><h3 class="sec-title">工作明细</h3>';
      if (entries.length === 0) html += '<p class="empty-tip">该分类下暂无记录</p>';
      entries.forEach(function (e) {
        html += '<div class="ref-item"><b>' + esc(e.emp) + " · " + e.date + "</b> " + e.cats.map(function (c) { return '<span class="tag" style="cursor:default">' + esc(c.name) + "</span>"; }).join("") +
          ' <span class="muted">⏱ ' + e.hours + " h</span><br>" + esc(e.text) +
          (e.atts.length ? '<div class="muted">附件：' + e.atts.map(function (a) { return '<a href="/api/attachment/' + a.id + '">' + esc(a.name) + "</a>"; }).join("、") + "</div>" : "") + "</div>";
      });
      html += "</div>";
      $("#page-dept").innerHTML = html;
      $$("#page-dept [data-df]").forEach(function (b) {
        b.onclick = function () { state.deptFilter = +b.dataset.df; renderers.dept(); };
      });
    });
  };

  /* =====================================================
     问答
  ===================================================== */
  renderers.qa = function () {
    api("/api/qa/meta").then(function (d) {
      if (!d.ok) { $("#page-qa").innerHTML = '<p class="empty-tip">' + esc(d.error || "加载失败") + "</p>"; return; }
      state.qa.scope = d.scope;
      state.qa.examples = d.examples;
      state.qa.convos = d.convos;
      if (!state.qa.active && d.convos.length) state.qa.active = d.convos[0].id;
      renderQaLayout();
    });
  };

  function renderQaLayout() {
    var q = state.qa;
    var html = '<div class="page-head"><div><h1>日志问答</h1><div class="sub">仅基于已提交工作日志作答 · 区分原始事实与系统分析 · 关键结论附原始引用</div></div>' +
      '<button class="btn" id="newConvo">＋ 新建对话</button></div>';
    html += '<div class="qa-scope">🔒 ' + esc(q.scope) + "（数据检索、分析与引用使用同一权限边界）</div>";
    html += '<div class="qa-layout"><div class="convo-list">';
    q.convos.forEach(function (c) {
      html += '<button class="convo-item' + (c.id === q.active ? " on" : "") + '" data-cv="' + c.id + '">' + esc(c.title) + ' <span class="muted">(' + c.rounds + " 轮)</span></button>";
    });
    html += '</div><div class="qa-main"><div class="qa-msgs" id="qaMsgs"></div>' +
      '<div class="example-qs" id="qaExamples"></div>' +
      '<div class="qa-input-row"><textarea id="qaInput" placeholder="输入问题，回车发送…"></textarea><button class="btn btn-primary" id="qaSend">发送</button></div></div></div>';
    $("#page-qa").innerHTML = html;
    $("#newConvo").onclick = function () {
      api("/api/qa/convos", { method: "POST" }).then(function (r) {
        if (r.ok) { state.qa.active = r.convo.id; renderers.qa(); }
      });
    };
    $$("#page-qa [data-cv]").forEach(function (b) {
      b.onclick = function () { state.qa.active = +b.dataset.cv; renderQaLayout(); };
    });
    $("#qaExamples").innerHTML = q.examples.map(function (x) { return '<button data-exq="' + esc(x) + '">' + esc(x) + "</button>"; }).join("");
    $$("#qaExamples button").forEach(function (b) {
      b.onclick = function () { $("#qaInput").value = b.dataset.exq; $("#qaInput").focus(); };
    });
    var input = $("#qaInput");
    input.onkeydown = function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendQa(); } };
    $("#qaSend").onclick = sendQa;
    loadConvoMsgs();
  }

  function qaAnswerHtml(a) {
    var html = "";
    if (a.kind === "permission" || a.kind === "nodata") {
      html += '<div class="blk"><span class="badge badge-analysis">' + esc(a.badge || "系统说明") + "</span><p style='margin-top:6px'>" + esc(a.intro || "") + "</p>" +
        (a.note ? '<p class="muted">' + esc(a.note) + "</p>" : "") + "</div>";
      return html;
    }
    if (a.intro) html += "<p>" + esc(a.intro) + "</p>";
    if (a.facts && a.facts.length) {
      html += '<div class="blk"><span class="badge badge-fact">原始事实</span> <span class="muted">来自员工最终提交的日志</span><ul class="blk-list">' +
        a.facts.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul></div>";
    }
    if (a.analysis && a.analysis.length) {
      html += '<div class="blk"><span class="badge badge-analysis">系统分析</span> <span class="muted">基于多条日志的判断，供参考</span><ul class="blk-list">' +
        a.analysis.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul></div>";
    }
    if (a.refs && a.refs.length) {
      html += '<div class="blk"><span class="muted">来源引用（点击展开原文）</span>' +
        a.refs.map(function (r) {
          return '<button class="ref-card" data-ref-full="' + r.itemId + '">⌗ ' + esc(r.emp) + " · " + r.date + " · " + esc(r.excerpt.slice(0, 18)) + "…</button>";
        }).join("") + "</div>";
    }
    if (a.followupTip) html += '<p class="muted">' + esc(a.followupTip) + "</p>";
    return html;
  }

  function loadConvoMsgs() {
    var box = $("#qaMsgs");
    if (!state.qa.active) {
      box.innerHTML = '<p class="empty-tip">从一个示例问题开始，或直接输入你的问题。<br>系统只基于工作日志回答；信息不足时会明确说明，不会编造。</p>';
      return;
    }
    api("/api/qa/convos/" + state.qa.active).then(function (d) {
      if (!d.ok) { box.innerHTML = '<p class="empty-tip">' + esc(d.error) + "</p>"; return; }
      if (d.messages.length === 0) {
        box.innerHTML = '<p class="empty-tip">从一个示例问题开始，或直接输入你的问题。<br>系统只基于工作日志回答；信息不足时会明确说明，不会编造。</p>';
        return;
      }
      box.innerHTML = d.messages.map(function (m) {
        if (m.role === "user") return '<div class="qa-bubble qa-user">' + esc(m.content.text || "") + "</div>";
        return '<div class="qa-bubble qa-ai">' + qaAnswerHtml(m.content) + "</div>";
      }).join("");
      $$("#qaMsgs [data-ref-full]").forEach(function (b) { b.onclick = function () { openRefModal(+b.dataset.refFull); }; });
      box.scrollTop = box.scrollHeight;
    });
  }

  function sendQa() {
    var input = $("#qaInput");
    var qtext = input.value.trim();
    if (!qtext) return;
    input.value = "";
    var box = $("#qaMsgs");
    if (box.querySelector(".empty-tip")) box.innerHTML = "";
    box.insertAdjacentHTML("beforeend", '<div class="qa-bubble qa-user">' + esc(qtext) + "</div>");
    box.insertAdjacentHTML("beforeend", '<div class="qa-bubble qa-ai" id="qaPending"><span class="muted">正在检索权限内的有效日志并整理引用…</span></div>');
    box.scrollTop = box.scrollHeight;
    api("/api/qa/ask", { body: { convoId: state.qa.active, question: qtext } }).then(function (d) {
      var pending = $("#qaPending");
      if (!d.ok) { if (pending) pending.innerHTML = '<span class="muted">' + esc(d.error || "回答失败") + "</span>"; return; }
      state.qa.active = d.convoId;
      state.qa.convos = d.convos;
      if (pending) {
        pending.removeAttribute("id");
        pending.innerHTML = qaAnswerHtml(d.answer);
        $$("[data-ref-full]", pending).forEach(function (b) { b.onclick = function () { openRefModal(+b.dataset.refFull); }; });
      }
      box.scrollTop = box.scrollHeight;
    }).catch(function () {
      var pending = $("#qaPending");
      if (pending) pending.innerHTML = '<span class="muted">网络异常，请重试</span>';
    });
  }

  /* =====================================================
     管理（admin）
  ===================================================== */
  renderers.admin = function () {
    api("/api/admin/users").then(function (d) {
      if (!d.ok) { $("#page-admin").innerHTML = '<p class="empty-tip">' + esc(d.error || "加载失败") + "</p>"; return; }
      var html = '<div class="page-head"><div><h1>管理</h1><div class="sub">外部账号 · 人员口径 · 工作日历</div></div></div>';
      html += '<div class="card"><h3 class="sec-title">新建外部账号</h3><div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<input id="exLogin" class="hours-input" style="width:170px;text-align:left" placeholder="登录名（如 pinghu01）">' +
        '<input id="exName" class="hours-input" style="width:170px;text-align:left" placeholder="姓名（可后改）">' +
        '<button class="btn btn-primary" id="exCreate">创建（自动生成初始密码）</button></div><div id="exResult" style="margin-top:8px"></div></div>';
      html += '<div class="card"><h3 class="sec-title">账号列表</h3><table class="admin-table"><thead><tr><th>ID</th><th>姓名</th><th>类型</th><th>登录名/钉钉ID</th><th>角色</th><th>应提交</th><th>状态</th><th>操作</th></tr></thead><tbody>';
      d.users.forEach(function (u) {
        html += "<tr><td>" + u.id + "</td><td>" + esc(u.name) + "</td><td>" + (u.is_external ? "外部" : u.kind === "dingtalk" ? "钉钉" : "本地") + "</td><td>" + esc(u.login_name || u.dd_userid || "") + "</td>" +
          "<td>" + u.role + "</td><td>" + (u.should_submit ? "是" : "否") + "</td><td>" + (u.active ? "启用" : "停用") + "</td>" +
          "<td>" + (u.kind === "local" ? '<a data-rp="' + u.id + '">重置密码</a> · ' : "") +
          '<a data-tg="' + u.id + ":" + (u.active ? 0 : 1) + '">' + (u.active ? "停用" : "启用") + "</a> · " +
          '<a data-ts="' + u.id + ":" + (u.should_submit ? 0 : 1) + '">' + (u.should_submit ? "免提交" : "计提交") + "</a></td></tr>";
      });
      html += "</tbody></table></div>";
      html += '<div class="card"><h3 class="sec-title">工作日历</h3><div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<input id="calDate" class="hours-input" style="width:150px" type="date"><select id="calKind" class="hours-input" style="width:130px"><option value="holiday">节假日</option><option value="workday">调休补班</option></select>' +
        '<button class="btn" id="calAdd">添加</button><button class="btn" id="calDel">移除</button></div><div class="muted" style="margin-top:6px">法定节假日需在此维护，影响补填日、主管首页默认日与 9:00 提醒。</div></div>';
      $("#page-admin").innerHTML = html;
      $("#exCreate").onclick = function () {
        api("/api/admin/external-users", { body: { loginName: $("#exLogin").value, name: $("#exName").value } }).then(function (r) {
          if (!r.ok) { toast(r.error || "创建失败"); return; }
          $("#exResult").innerHTML = '<div class="notice-inline">已创建 <b>' + esc(r.user.loginName) + "</b>，初始密码：<b>" + esc(r.initialPassword) + "</b>（仅显示这一次，请立即转发给使用人；首次登录会要求改密）</div>";
          renderers.admin();
        });
      };
      $$("#page-admin [data-rp]").forEach(function (a) {
        a.onclick = function () {
          if (!confirm("重置该账号密码？旧密码将立即失效。")) return;
          api("/api/admin/users/" + a.dataset.rp + "/reset-password", { method: "POST" }).then(function (r) {
            if (r.ok) openModal("<h3>新初始密码</h3><p>仅显示这一次：<b>" + esc(r.initialPassword) + "</b></p>");
            else toast(r.error || "失败");
          });
        };
      });
      $$("#page-admin [data-tg]").forEach(function (a) {
        a.onclick = function () {
          var p = a.dataset.tg.split(":");
          api("/api/admin/users/" + p[0] + "/update", { body: { active: p[1] === "1" } }).then(function () { renderers.admin(); });
        };
      });
      $$("#page-admin [data-ts]").forEach(function (a) {
        a.onclick = function () {
          var p = a.dataset.ts.split(":");
          api("/api/admin/users/" + p[0] + "/update", { body: { shouldSubmit: p[1] === "1" } }).then(function () { renderers.admin(); });
        };
      });
      $("#calAdd").onclick = function () {
        api("/api/admin/calendar", { body: { action: "add", kind: $("#calKind").value, date: $("#calDate").value } }).then(function (r) { toast(r.ok ? "已添加" : r.error || "失败"); });
      };
      $("#calDel").onclick = function () {
        api("/api/admin/calendar", { body: { action: "remove", kind: $("#calKind").value, date: $("#calDate").value } }).then(function (r) { toast(r.ok ? "已移除" : r.error || "失败"); });
      };
    });
  };

  /* ---------- 启动 ---------- */
  api("/api/me").then(function (d) {
    if (!d.ok) { location.href = "/login"; return; }
    state.user = d.user;
    $("#uName").textContent = d.user.name;
    var roleNames = { emp: d.user.isExternal ? "外部工程师" : "员工", lead: "项目负责人", mgr: "部门主管", exec: "公司管理者", admin: "管理员" };
    $("#uRole").textContent = roleNames[d.user.role] || "";
    loadDwsStatus();
    $("#btnLogout").onclick = function () {
      api("/api/auth/logout", { method: "POST" }).then(function (r) { location.href = (r && r.redirectTo) || "/login"; });
    };
    if (d.user.mustChangePw) {
      openModal('<h3>首次登录请修改密码</h3><p class="muted">为了账号安全，请设置你自己的密码（至少 8 位，含字母和数字）。</p>' +
        '<div style="margin-top:10px"><input id="pwOld" class="hours-input" style="width:100%;text-align:left" type="password" placeholder="初始密码"></div>' +
        '<div style="margin-top:8px"><input id="pwNew" class="hours-input" style="width:100%;text-align:left" type="password" placeholder="新密码"></div>' +
        '<p style="margin-top:12px;text-align:right"><button class="btn btn-primary" id="pwGo">确认修改</button></p>');
      $("#pwGo").onclick = function () {
        api("/api/auth/change-password", { body: { oldPassword: $("#pwOld").value, newPassword: $("#pwNew").value } }).then(function (r) {
          if (r.ok) { toast("密码已修改"); closeModal(); }
          else toast(r.error || "修改失败");
        });
      };
    }
    var entryParams = new URLSearchParams(location.search);
    var entryProjectSource = entryParams.get("projectSource");
    if (entryProjectSource === "dingtalk") {
      state.projectSource = "dingtalk";
      state.curDingProject = entryParams.get("projectId") || "";
      state.dingDate = entryParams.get("date") || "";
    } else if (entryProjectSource === "unassigned") {
      state.projectSource = "unassigned";
      state.dingDate = entryParams.get("date") || "";
    } else if (entryProjectSource === "unified") {
      state.projectSource = "unified";
      state.curProject = +(entryParams.get("projectId") || 0);
      state.dingDate = entryParams.get("date") || "";
    }
    var hash = location.hash.replace("#", "");
    var valid = PAGES.some(function (p) { return p.id === hash; }) || hash === "admin";
    var fallback = pageVisible("fill") ? "fill" : pageVisible("home") ? "home" : pageVisible("project") ? "project" : pageVisible("assistant") ? "assistant" : "qa";
    var target = valid && pageVisible(hash) ? hash : fallback;
    go(target);
  }).catch(function () { /* 跳登录已处理 */ });
})();
