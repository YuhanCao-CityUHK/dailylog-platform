/* 主管项目页的 VivoFlow 只读任务视图。 */
(function () {
  "use strict";
  var activeMount = 0;
  var selectedTab = "reports";
  var labels = { NOT_STARTED: "未开始", IN_PROGRESS: "进行中", PAUSED: "已暂停", CANCELLED: "已取消", DONE: "已完成" };
  var riskLabels = { HIGH: "高风险", MEDIUM: "中风险", LOW: "低风险" };
  function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function stamp(value) { return value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "尚未同步"; }
  function shortDate(value) { return value ? String(value).slice(0, 10) : "未排期"; }
  function request(url, body, method) {
    var init = { credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body !== undefined) { init.method = method || "POST"; init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    return fetch(url, init).then(function (response) { return response.json(); }).catch(function () { return { ok: false, error: "网络连接失败，请稍后重试" }; });
  }
  function empty(title, text, action) { return '<div class="vivo-empty"><strong>' + esc(title) + '</strong><p>' + esc(text) + '</p>' + (action || "") + '</div>'; }
  function connectButton() { return '<button type="button" class="btn btn-primary" data-vivo-connect>连接我的 VivoFlow</button>'; }
  function taskPriority(task) { return (task.progress.length ? 100 : 0) + (task.overdue ? 80 : 0) + (task.riskFlag ? 60 : 0) + (task.status === "IN_PROGRESS" ? 40 : 0) + (task.assignee ? 10 : 0); }
  function taskHtml(task) {
    var progress = task.progress || [];
    return '<details class="vivo-task"' + (progress.length ? " open" : "") + '><summary><span class="vivo-task-name"><strong>' + esc(task.name) + '</strong><small>' + (task.parentTaskId ? "子任务 · " : "") + esc(task.sourceProjectName) + '</small></span>' +
      '<span class="vivo-task-owner">' + esc(task.assignee && task.assignee.name || "未分配") + '</span><span class="vivo-task-status"><span class="vivo-badge status-' + esc(task.status) + '">' + esc(labels[task.status] || task.status) + '</span>' +
      (task.overdue ? '<span class="vivo-badge overdue">逾期</span>' : "") + (task.riskFlag ? '<span class="vivo-badge risk">' + esc(riskLabels[task.riskFlag] || task.riskFlag) + '</span>' : "") + '</span>' +
      '<span class="vivo-task-date">' + esc(shortDate(task.endDate)) + '</span><span class="vivo-task-updates">' + (progress.length ? progress.length + " 条进展" : "查看详情") + '</span></summary>' +
      '<div class="vivo-task-body"><div class="vivo-task-meta"><span>计划：' + esc(shortDate(task.startDate)) + ' → ' + esc(shortDate(task.endDate)) + '</span><a href="' + esc(task.url) + '" target="_blank" rel="noopener noreferrer">打开原任务 ↗</a></div>' +
      (progress.length ? progress.map(function (p) { return '<article class="vivo-progress"><div><b>' + esc(p.author) + '</b><time>' + esc(stamp(p.createdAt)) + '</time></div><p>' + esc(p.text || "本条进展无文字正文") + '</p>' + (p.attachmentCount ? '<small>含 ' + p.attachmentCount + ' 个附件，可在原任务中查看</small>' : "") + '</article>'; }).join("") : '<p class="vivo-no-progress">' + (task.progressComplete ? '所选日期暂无填报进展' : '暂无法确认所选日期的填报进展') + '</p>') +
      (!task.progressComplete ? '<p class="vivo-warning">该任务的进展未读取完整，请重新同步或打开原任务核对。</p>' : "") + '</div></details>';
  }
  window.VivoFlowPanel = {
    mount: function (options) {
      var mount = ++activeMount;
      var panel = document.getElementById("vivoProjectSection");
      var reports = document.getElementById("unifiedProjectSection");
      if (!panel || !reports) return;
      var tabbar = document.getElementById("projectContentTabs");
      var base = "/api/vivoflow/projects/" + options.projectId;
      var data = null, filter = "all", query = "", shown = 50, timer = null;
      var alive = function () { var page = panel.closest(".page"); return mount === activeMount && panel.isConnected && (!page || page.classList.contains("show")); };
      var date = options.date;
      var callbackUrl = new URL(location.href);
      if (callbackUrl.searchParams.has("vivoflow")) {
        selectedTab = "tasks";
        callbackUrl.searchParams.delete("vivoflow");
        history.replaceState(null, "", callbackUrl.pathname + callbackUrl.search + callbackUrl.hash);
      }
      function select(tab) {
        selectedTab = tab;
        tabbar.querySelectorAll("[data-project-tab]").forEach(function (button) { var on = button.dataset.projectTab === tab; button.setAttribute("aria-selected", String(on)); button.tabIndex = on ? 0 : -1; });
        reports.hidden = tab !== "reports"; panel.hidden = tab !== "tasks";
        var reportSync = document.getElementById("projectSync"); if (reportSync) reportSync.hidden = tab !== "reports";
        var dateInput = document.getElementById("projectDate");
        if (dateInput && dateInput.parentNode.firstChild.nodeType === 3) dateInput.parentNode.firstChild.textContent = tab === "tasks" ? "进展日期" : "日报日期";
        clearTimeout(timer);
        if (tab === "tasks") { if (!data) load(false); else { render(); if (data.syncing) schedule(); } }
      }
      tabbar.querySelectorAll("[data-project-tab]").forEach(function (button) {
        button.onclick = function () { select(button.dataset.projectTab); };
        button.onkeydown = function (event) { if (["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(event.key) < 0) return; event.preventDefault(); var next = event.key === "Home" ? "reports" : event.key === "End" ? "tasks" : selectedTab === "reports" ? "tasks" : "reports"; select(next); tabbar.querySelector('[data-project-tab="' + next + '"]').focus(); };
      });
      function schedule() { clearTimeout(timer); if (alive() && selectedTab === "tasks") timer = setTimeout(function () { load(false, true); }, 2500); }
      function load(refresh, polling) {
        clearTimeout(timer);
        if (!polling && !data) panel.innerHTML = '<div class="project-loading" role="status"><span class="loading-ring"></span><strong>正在读取研发任务…</strong><p>只读取当前账号有权查看的内容</p></div>';
        var button = panel.querySelector("[data-vivo-refresh]"); if (button) button.disabled = true;
        request(refresh ? base + "/refresh" : base + "?date=" + encodeURIComponent(date), refresh ? { date: date } : undefined).then(function (result) {
          if (!alive()) return; data = result; render(); if (result.syncing) schedule(); else if (result.ok && result.shared && selectedTab === "tasks") timer = setTimeout(function () { load(false); }, 60000);
        });
      }
      function bindActions() {
        panel.querySelectorAll("[data-vivo-connect]").forEach(function (button) { button.onclick = function () {
          var popup = window.open("/api/vivoflow/launch", "_blank");
          if (!popup) { options.toast("请允许此站点打开授权窗口，再重新连接"); return; }
          popup.opener = null;
          button.disabled = true; button.textContent = "正在打开授权…";
          request("/api/vivoflow/connect", {}).then(function (result) {
            function failed(message) { options.toast(message); button.disabled = false; button.textContent = "连接我的 VivoFlow"; }
            if (!result.ok || !result.url) { popup.close(); failed(result.error || "连接失败"); return; }
            popup.location.replace(result.url); button.textContent = "等待 VivoFlow 授权…";
            var deadline = Date.now() + 10 * 60 * 1000;
            function poll() {
              request("/api/vivoflow/complete", {}).then(function (state) {
                if (!state.ok) { failed(state.error || "连接失败"); return; }
                if (state.connected) { options.toast("VivoFlow 已连接"); if (alive()) load(false); return; }
                if (Date.now() >= deadline) { failed("授权等待超时，请重新连接"); return; }
                setTimeout(poll, 2000);
              });
            }
            setTimeout(poll, 1500);
          });
        }; });
        var refresh = panel.querySelector("[data-vivo-refresh]"); if (refresh) refresh.onclick = function () { load(true); };
        var link = panel.querySelector("[data-vivo-links]"); if (link) link.onclick = editLinks;
        var disconnect = panel.querySelector("[data-vivo-disconnect]"); if (disconnect) disconnect.onclick = function () {
          disconnect.disabled = true; request("/api/vivoflow/disconnect", {}).then(function (result) { if (result.ok) { data = null; load(false); } else { options.toast(result.error); disconnect.disabled = false; } });
        };
      }
      function renderTasks() {
        var target = panel.querySelector(".vivo-task-list"); if (!target || !data.snapshot) return;
        var tasks = data.snapshot.tasks.filter(function (task) {
          var text = [task.name, task.sourceProjectName, task.assignee && task.assignee.name].join(" ").toLowerCase();
          return (!query || text.indexOf(query.toLowerCase()) >= 0) && (filter === "all" || filter === "overdue" && task.overdue || filter === "risk" && task.riskFlag || filter === "updated" && task.progress.length || filter === task.status);
        });
        tasks.sort(function (a, b) { return taskPriority(b) - taskPriority(a); });
        target.innerHTML = tasks.length ? tasks.slice(0, shown).map(taskHtml).join("") : empty("暂无符合条件的任务", data.snapshot.tasks.length ? "可调整搜索内容或筛选条件。" : "关联项目当前没有可见任务。");
        var count = panel.querySelector(".vivo-filter-count"); if (count) count.textContent = "显示 " + Math.min(shown, tasks.length) + " / " + tasks.length + " 项";
        if (tasks.length > shown) { var more = document.createElement("button"); more.className = "btn vivo-more"; more.textContent = "再显示 50 项"; more.onclick = function () { shown += 50; renderTasks(); }; target.appendChild(more); }
      }
      function render() {
        if (!alive()) return;
        if (!data.ok) {
          panel.innerHTML = empty("研发任务暂不可用", data.error || "请稍后重试", '<button class="btn" data-vivo-refresh>重新读取</button>' + (!data.shared && ["not_connected", "authorization_expired"].indexOf(data.code) >= 0 ? connectButton() : "")); bindActions(); return;
        }
        if (!data.connected && data.shared) { panel.innerHTML = empty("研发任务正在配置", "后台统一数据源尚未就绪，请联系平台管理员，无需个人授权。"); return; }
        if (!data.connected) { panel.innerHTML = empty("连接 VivoFlow，查看项目研发进展", "使用自己的 VivoFlow 账号授权后，可查看项目任务、排期和人员填报的进展。", connectButton()); bindActions(); return; }
        var snapshot = data.snapshot;
        var html = '<div class="vivo-toolbar"><div><strong>研发任务</strong><p>当前任务状态 · ' + esc(date) + ' 的填报进展</p></div><div class="vivo-actions">' + (data.canManage ? '<button class="btn" data-vivo-links>关联项目</button>' : "") + '<button class="btn" data-vivo-refresh' + (data.syncing ? " disabled" : "") + '>刷新任务</button>' + (data.shared ? '' : '<button class="btn-ghost" data-vivo-disconnect>断开连接</button>') + '</div></div>';
        if (data.links.length) html += '<div class="vivo-sources">' + data.links.map(function (link) { return '<span>' + esc(link.name) + '<small>' + esc(labels[link.status] || link.status) + (link.method === "auto" ? " · 自动关联" : "") + '</small></span>'; }).join("") + '</div>';
        if (data.unavailableCount) html += '<p class="vivo-warning">有 ' + data.unavailableCount + ' 个既有关联在当前 VivoFlow 账号下不可见，未展示其任务。</p>';
        if (data.error) html += '<p class="vivo-warning" role="alert">' + esc(data.error) + (snapshot ? "。下方保留上次同步结果。" : "") + '</p>';
        if (data.syncing) html += '<p class="vivo-sync-status" role="status"><span class="loading-ring"></span>正在同步' + (data.syncProgress && data.syncProgress.total ? '：已读取 ' + data.syncProgress.completed + ' / ' + data.syncProgress.total + ' 项任务进展' : "任务列表…") + '</p>';
        if (!data.links.length) html += empty("尚无可查看的项目关联", data.canManage ? "可以点击“关联项目”，选择本平台项目对应的 VivoFlow 研发项目。" : "请项目负责人设置关联，或核对 VivoFlow 中的项目查看权限。");
        else if (!snapshot && !data.syncing && !data.error) html += empty("等待首次同步", "点击“同步任务”读取研发进展。");
        if (snapshot) {
          var tasks = snapshot.tasks;
          html += '<div class="vivo-metrics">' + [[tasks.length, "任务总数"], [tasks.filter(function (t) { return t.status === "DONE"; }).length, "已完成"], [tasks.filter(function (t) { return t.status === "IN_PROGRESS"; }).length, "进行中"], [tasks.filter(function (t) { return t.overdue; }).length, "逾期"]].map(function (pair, index) { return '<div' + (index === 3 && pair[0] ? ' class="has-risk"' : "") + '><b>' + pair[0] + '</b><span>' + pair[1] + '</span></div>'; }).join("") + '</div>';
          html += '<p class="vivo-caption">任务统计含父子任务，不代表项目完成率 · 截至北京时间 ' + esc(stamp(snapshot.syncedAt)) + (data.stale ? " · 待更新" : "") + '</p>';
          (snapshot.warnings || []).forEach(function (warning) { html += '<p class="vivo-warning">' + esc(warning) + '</p>'; });
          html += '<div class="vivo-filters"><label class="vivo-search"><span class="sr-only">搜索任务、项目或负责人</span><input type="search" placeholder="搜索任务、项目或负责人" value="' + esc(query) + '"></label><div class="vivo-filter-buttons" aria-label="任务筛选">' + [["all", "全部"], ["overdue", "逾期"], ["risk", "有风险"], ["updated", "当日有进展"], ["IN_PROGRESS", "进行中"], ["DONE", "已完成"]].map(function (item) { return '<button type="button" data-vivo-filter="' + item[0] + '" aria-pressed="' + (filter === item[0]) + '">' + item[1] + '</button>'; }).join("") + '</div><span class="vivo-filter-count"></span></div><div class="vivo-table-head"><span>任务 / 所属研发项目</span><span>负责人</span><span>状态 / 风险</span><span>计划截止</span><span>所选日期进展</span></div><div class="vivo-task-list"></div>';
        }
        panel.innerHTML = html; bindActions(); renderTasks();
        var search = panel.querySelector('input[type="search"]'); if (search) search.oninput = function () { query = search.value.trim(); shown = 50; renderTasks(); };
        panel.querySelectorAll("[data-vivo-filter]").forEach(function (button) { button.onclick = function () { filter = button.dataset.vivoFilter; shown = 50; panel.querySelectorAll("[data-vivo-filter]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.vivoFilter === filter)); }); renderTasks(); }; });
      }
      function editLinks() {
        var trigger = panel.querySelector("[data-vivo-links]"); trigger.disabled = true;
        request(base + "/links").then(function (result) {
          trigger.disabled = false; if (!alive()) return;
          if (!result.ok) { options.toast(result.error); return; }
          var selected = new Set(result.links.map(function (link) { return link.sourceId; }));
          var known = new Set(result.projects.map(function (p) { return p.id; }));
          var assigned = new Map((result.assignments || []).map(function (a) { return [a.sourceId, a]; }));
          var rows = result.projects.concat(result.links.filter(function (l) { return !known.has(l.sourceId); }).map(function (l) { return { id: l.sourceId, name: "当前账号不可查看的既有关联（" + l.sourceId + "）", status: "" }; }));
          var dialog = document.createElement("dialog"); dialog.className = "modal vivo-link-modal"; dialog.setAttribute("aria-label", "关联 VivoFlow 项目");
          dialog.innerHTML = '<h3>关联 VivoFlow 项目</h3><p class="vivo-link-intro">将研发任务归到「' + esc(options.projectName) + '」。可选择多个项目，调整关联不会修改历史日报或工时。</p><label class="vivo-search"><span class="sr-only">搜索研发项目</span><input id="vivoLinkSearch" type="search" placeholder="搜索研发项目"></label><div class="vivo-link-list">' + rows.map(function (p) { var assignment = assigned.get(p.id); var elsewhere = assignment && assignment.projectId !== options.projectId; return '<label class="vivo-link-row" data-vivo-link-name="' + esc(p.name.toLowerCase()) + '"><input type="checkbox" value="' + esc(p.id) + '"' + (selected.has(p.id) ? " checked" : "") + (elsewhere ? " disabled" : "") + '><span><strong>' + esc(p.name) + '</strong><small>' + esc([p.productLine, labels[p.status] || p.status, elsewhere ? '已关联：' + assignment.projectName + '（请先在该项目解除）' : ''].filter(Boolean).join(' · ')) + '</small></span></label>'; }).join("") + (!rows.length ? '<p>当前 VivoFlow 账号没有可见项目。</p>' : "") + '</div><p class="vivo-link-error" role="alert"></p><div class="vivo-dialog-actions"><button class="btn" id="vivoLinkCancel">取消</button><button class="btn btn-primary" id="vivoLinkSave">保存关联</button></div>';
          document.body.appendChild(dialog); dialog.addEventListener("close", function () { dialog.remove(); if (trigger.isConnected) trigger.focus(); }); dialog.showModal();
          var closeEditor = function () { dialog.close(); };
          dialog.querySelector("#vivoLinkSearch").oninput = function () { var text = this.value.trim().toLowerCase(); dialog.querySelectorAll("[data-vivo-link-name]").forEach(function (row) { row.hidden = Boolean(text && row.dataset.vivoLinkName.indexOf(text) < 0); }); };
          dialog.querySelector("#vivoLinkCancel").onclick = closeEditor;
          dialog.querySelector("#vivoLinkSave").onclick = function () {
            var button = this; button.disabled = true;
            var ids = Array.from(dialog.querySelectorAll('.vivo-link-row input:checked')).map(function (input) { return input.value; });
            request(base + "/links", { sourceIds: ids }, "PUT").then(function (saved) { if (saved.ok) { closeEditor(); options.toast("项目关联已保存"); data = null; load(false); } else { button.disabled = false; dialog.querySelector(".vivo-link-error").textContent = saved.error; } });
          };
        });
      }
      select(selectedTab);
    }
  };
})();
