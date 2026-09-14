import { DAILY_REPORTS_PAGE_CSS } from "./daily-reports-page-styles";
import {
  renderWorkbenchPage,
  type WorkbenchNavId,
  type WorkbenchShellRole,
} from "./workbench-shell";

const DAILY_REPORTS_API = "/api/workbench/daily-reports";

export function renderDailyReportsPage(params: {
  role: WorkbenchShellRole;
  activeNav: WorkbenchNavId;
  userLabel?: string;
  sessionUserId?: string;
  showAdminOpsLink?: boolean;
  portfolioEnabled?: boolean;
  apiBase?: string;
  initialDate?: string;
  initialView?: string;
  canManageRoster?: boolean;
  canManageProjectGroups?: boolean;
  canExecuteAsManager?: boolean;
  qualityAccessDisabled?: boolean;
}): string {
  const apiBase = params.apiBase ?? DAILY_REPORTS_API;
  const canManageRoster = Boolean(params.canManageRoster);
  const canManageProjectGroups = Boolean(params.canManageProjectGroups);
  const roleClass =
    params.role === "employee"
      ? "dr-role-employee"
      : params.role === "admin"
        ? "dr-role-admin"
        : "dr-role-manager";
  const pageTitle =
    params.role === "employee"
      ? "日报汇总 · 员工工作台"
      : params.role === "admin"
        ? "日报汇总 · 管理员"
        : "日报汇总 · 主管工作台";
  const description = canManageRoster
    ? "跨组织日报汇总：默认按项目组查看，可切换公司视图。管理员可在「管理名单」维护统计人员；主管/管理员可在「项目组设置」调整归属。"
    : canManageProjectGroups
      ? "跨组织日报汇总：默认按项目组查看，可切换公司视图；可在「项目组设置」调整人员归属。"
      : "跨组织日报汇总：默认按项目组查看，可切换公司视图。";

  const rosterToolbar = canManageRoster
    ? `<button type="button" class="dr-btn" id="drmToggle" aria-expanded="false" aria-controls="drmPanel">管理名单</button>`
    : "";
  const groupToolbar = canManageProjectGroups
    ? `<button type="button" class="dr-btn" id="dpgToggle" aria-expanded="false" aria-controls="dpgPanel">项目组设置</button>`
    : "";

  const rosterPanel = canManageRoster
    ? `<div class="drm-panel" id="drmPanel" aria-hidden="true">
      <div class="drm-inner">
        <div class="drm-head">
          <h3>管理统计名单</h3>
          <span class="drm-hint">分企业搜人 · 加入即校验近 7 天日报</span>
        </div>
        <div class="drm-banner" id="drmBanner" role="status"></div>
        <div class="drm-cols" id="drmCols"><div class="drm-note"><span class="drm-spin"></span> 载入名单…</div></div>
      </div>
    </div>`
    : "";

  const projectViewRosterPanel = `<div class="drm-panel" id="dpvrPanel" aria-hidden="true">
      <div class="drm-inner">
        <div class="drm-head">
          <h3 id="dpvrTitle">项目组名单</h3>
          <span class="drm-hint" id="dpvrHint">名单仅作参考；日报按三类研发模板统一日筛，请用「刷新」重扫当日</span>
        </div>
        <div class="drm-banner" id="dpvrBanner" role="status"></div>
        <div class="drm-actions" style="margin-bottom:12px">
          <button type="button" class="dr-btn" id="dpvrRediscover" style="display:none">重新发现</button>
        </div>
        <div class="drm-cols" id="dpvrCols"><div class="drm-note"><span class="drm-spin"></span> 载入名单…</div></div>
      </div>
    </div>`;

  const groupPanel = canManageProjectGroups
    ? `<div class="dpg-panel" id="dpgPanel" aria-hidden="true">
      <div class="dpg-inner">
        <div class="dpg-head">
          <h3>项目组归属</h3>
          <span class="dpg-hint">颅内 / 脑机 / 运营 · 保存后立即生效</span>
        </div>
        <div class="dpg-banner" id="dpgBanner" role="status"></div>
        <div class="dpg-table-wrap" id="dpgTableWrap"><div class="drm-note"><span class="drm-spin"></span> 载入…</div></div>
        <div class="dpg-actions">
          <button type="button" class="dr-btn dr-btn-primary" id="dpgSave">保存设置</button>
        </div>
      </div>
    </div>`
    : "";

  return renderWorkbenchPage({
    role: params.role,
    activeNav: params.activeNav,
    title: "日报汇总",
    pageTitle,
    description,
    userLabel: params.userLabel,
    sessionUserId: params.sessionUserId,
    portfolioEnabled: Boolean(params.portfolioEnabled),
    showAdminOpsLink: params.showAdminOpsLink,
    canExecuteAsManager: Boolean(params.canExecuteAsManager),
    qualityAccessDisabled: params.qualityAccessDisabled,
    extraCss: DAILY_REPORTS_PAGE_CSS,
    mainHtml: `
  <div class="dr-root ${roleClass}">
    <div class="dr-toolbar">
      <div class="dr-view-switch" id="drViewSwitch" role="tablist" aria-label="视图切换">
        <button type="button" class="dr-view-btn is-on" data-view="project" role="tab" aria-selected="true">项目视图</button>
        <button type="button" class="dr-view-btn" data-view="company" role="tab" aria-selected="false">公司视图</button>
      </div>
      <label class="dr-filter">
        <span class="dr-field-k">日期</span>
        <input type="date" class="dr-date-input" id="drDate" aria-label="日报日期" />
      </label>
      <button type="button" class="dr-btn" id="drRefresh">刷新</button>
      <span class="dr-spacer"></span>
      <button type="button" class="dr-btn" id="dpvrToggle" aria-expanded="false" aria-controls="dpvrPanel" style="display:none">项目组名单</button>
      ${groupToolbar}
      ${rosterToolbar}
    </div>
    <p class="dr-meta" id="drMeta" aria-live="polite">加载中…</p>
    ${groupPanel}
    ${rosterPanel}
    ${projectViewRosterPanel}
    <div class="dr-stack" id="drContent"></div>
  </div>`,
    scriptHtml: `<script>${buildDailyReportsClientJs({
      apiBase,
      initialDate: params.initialDate ?? "",
      initialView: params.initialView ?? "project",
      canManageRoster,
      canManageProjectGroups,
    })}</script>`,
  });
}

function buildDailyReportsClientJs(opts: {
  apiBase: string;
  initialDate: string;
  initialView: string;
  canManageRoster: boolean;
  canManageProjectGroups: boolean;
}): string {
  const api = opts.apiBase.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const initDate = opts.initialDate.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const initView = opts.initialView === "company"
    ? "company"
    : opts.initialView.startsWith("custom:")
      ? opts.initialView
      : "project";
  const canManageRoster = opts.canManageRoster ? "true" : "false";
  const canManageProjectGroups = opts.canManageProjectGroups ? "true" : "false";

  const rosterBlock = opts.canManageRoster
    ? `
  var ROSTER = API + '/roster';
  var CONTACTS = API + '/contacts';
  var toggle = document.getElementById('drmToggle');
  var panel = document.getElementById('drmPanel');
  var cols = document.getElementById('drmCols');
  var banner = document.getElementById('drmBanner');
  var rosterLoaded = false;
  function showBanner(kind, msg){
    banner.className = 'drm-banner show ' + kind;
    banner.innerHTML = msg;
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(function(){ banner.className='drm-banner'; }, 7000);
  }
  function renderRoster(orgs){
    if(!orgs || !orgs.length){ cols.innerHTML='<div class="drm-note">配置里没有组织</div>'; return; }
    cols.innerHTML = orgs.map(function(o){
      var mark = esc((o.label||'·').slice(0,1));
      var cred = o.usesDeployedCredentials
        ? '<span class="drm-cred">复用部署凭证</span>'
        : '<span class="drm-cred indep">独立应用</span>';
      var members = (o.employees||[]).map(function(e){
        return '<div class="drm-member"><span class="drm-m-name">'+esc(e.name||e.userid)+'</span>'
          + '<span class="drm-m-uid">'+esc(e.userid)+'</span><span class="drm-m-spacer"></span>'
          + '<button class="drm-x" title="移除" data-action="remove" data-org="'+esc(o.label)+'" data-userid="'+esc(e.userid)+'">×</button></div>';
      }).join('');
      if(!members) members = '<div class="drm-members-empty">暂无成员</div>';
      return '<section class="drm-col">'
        + '<div class="drm-col-head"><span class="dr-org-mark">'+mark+'</span><h4>'+esc(o.label)+'</h4>'+cred+'</div>'
        + '<div class="drm-members">'+members+'</div>'
        + '<div class="drm-search-wrap"><input class="drm-search" data-org="'+esc(o.label)+'" placeholder="在'+esc(o.label)+'里按姓名搜索…" autocomplete="off" />'
        + '<div class="drm-results" data-results="'+esc(o.label)+'"></div></div>'
        + '</section>';
    }).join('');
  }
  function loadRoster(){
    cols.innerHTML = '<div class="drm-note"><span class="drm-spin"></span> 载入名单…</div>';
    fetch(ROSTER, {headers:{Accept:'application/json'}})
      .then(function(r){return r.json();})
      .then(function(data){
        if(!data || data.ok===false){ cols.innerHTML='<div class="drm-note">载入失败：'+esc((data&&data.error)||'未知错误')+'</div>'; return; }
        rosterLoaded = true;
        renderRoster(data.orgs);
        prewarm(data.orgs);
      })
      .catch(function(e){ cols.innerHTML='<div class="drm-note">载入失败：'+esc(e.message||e)+'</div>'; });
  }
  function prewarm(orgs){
    (orgs||[]).forEach(function(o){
      fetch(CONTACTS+'?org='+encodeURIComponent(o.label)+'&q=', {headers:{Accept:'application/json'}}).catch(function(){});
    });
  }
  function resultsBox(org){ return cols.querySelector('.drm-results[data-results="'+(window.CSS&&CSS.escape?CSS.escape(org):org)+'"]'); }
  function doSearch(org, q){
    var box = resultsBox(org);
    if(!box) return;
    if(!q){ box.className='drm-results'; box.innerHTML=''; return; }
    box.className='drm-results show';
    box.innerHTML='<div class="drm-note"><span class="drm-spin"></span> 搜索中…</div>';
    fetch(CONTACTS+'?org='+encodeURIComponent(org)+'&q='+encodeURIComponent(q), {headers:{Accept:'application/json'}})
      .then(function(r){return r.json();})
      .then(function(data){
        if(!data || data.ok===false){ box.innerHTML='<div class="drm-note">'+esc((data&&data.error)||'搜索失败')+'</div>'; return; }
        var list = data.candidates||[];
        if(!list.length){ box.innerHTML='<div class="drm-note">无匹配</div>'; return; }
        box.innerHTML = list.map(function(c){
          if(c.inRoster){
            return '<button class="drm-result" disabled><span class="drm-r-name">'+esc(c.name||c.userid)+'</span><span class="drm-r-tag">已在名单</span></button>';
          }
          return '<button class="drm-result" data-action="add" data-org="'+esc(org)+'" data-userid="'+esc(c.userid)+'" data-name="'+esc(c.name||'')+'">'
            + '<span class="drm-r-name">'+esc(c.name||c.userid)+'</span><span class="drm-r-uid">'+esc(c.userid)+'</span></button>';
        }).join('');
      })
      .catch(function(e){ box.innerHTML='<div class="drm-note">搜索失败：'+esc(e.message||e)+'</div>'; });
  }
  function postRoster(payload){
    return fetch(ROSTER, {method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload)}).then(function(r){return r.json();});
  }
  cols.addEventListener('click', function(e){
    var btn = e.target.closest('[data-action]');
    if(!btn) return;
    var action = btn.getAttribute('data-action');
    var org = btn.getAttribute('data-org');
    var userid = btn.getAttribute('data-userid');
    if(action==='add'){
      showBanner('ok', '<span class="drm-spin"></span> 加入中…');
      postRoster({action:'add', org:org, userid:userid, name:btn.getAttribute('data-name')||''}).then(function(data){
        if(!data || data.ok===false){ showBanner('err', '加入失败'); return; }
        renderRoster(data.orgs); load();
      });
    } else if(action==='remove'){
      postRoster({action:'remove', org:org, userid:userid}).then(function(data){
        if(!data || data.ok===false){ showBanner('err', '移除失败'); return; }
        renderRoster(data.orgs); load();
      });
    }
  });
  var searchTimers = {};
  cols.addEventListener('input', function(e){
    var inp = e.target;
    if(!inp.classList || !inp.classList.contains('drm-search')) return;
    var org = inp.getAttribute('data-org');
    clearTimeout(searchTimers[org]);
    searchTimers[org] = setTimeout(function(){ doSearch(org, inp.value.trim()); }, 320);
  });
  if(toggle) toggle.addEventListener('click', function(){
    var open = panel.classList.toggle('open');
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if(open && !rosterLoaded) loadRoster();
  });`
    : "";

  const groupBlock = opts.canManageProjectGroups
    ? `
  var PG_API = API + '/project-groups';
  var dpgToggle = document.getElementById('dpgToggle');
  var dpgPanel = document.getElementById('dpgPanel');
  var dpgWrap = document.getElementById('dpgTableWrap');
  var dpgBanner = document.getElementById('dpgBanner');
  var dpgSave = document.getElementById('dpgSave');
  var dpgLoaded = false;
  function showDpgBanner(kind, msg){
    dpgBanner.className = 'dpg-banner show ' + kind;
    dpgBanner.textContent = msg;
    clearTimeout(showDpgBanner._t);
    showDpgBanner._t = setTimeout(function(){ dpgBanner.className='dpg-banner'; }, 6000);
  }
  function renderDpgTable(members){
    if(!members || !members.length){ dpgWrap.innerHTML='<div class="drm-note">暂无人员</div>'; return; }
    var opts = '<option value="intracranial">颅内项目组</option><option value="brain">脑机项目组</option><option value="ops">运营组</option>';
    dpgWrap.innerHTML = '<table class="dpg-table"><thead><tr><th>姓名</th><th>组织</th><th>项目组</th></tr></thead><tbody>'
      + members.map(function(m){
        return '<tr><td>'+esc(m.name||m.userid)+'</td><td>'+esc(m.orgLabel)+'</td><td>'
          + '<select class="dpg-select" data-org="'+esc(m.orgLabel)+'" data-userid="'+esc(m.userid)+'">'
          + opts.replace('value="'+m.projectGroup+'"','value="'+m.projectGroup+'" selected')
          + '</select></td></tr>';
      }).join('') + '</tbody></table>';
  }
  function loadDpg(){
    dpgWrap.innerHTML = '<div class="drm-note"><span class="drm-spin"></span> 载入…</div>';
    fetch(PG_API, {headers:{Accept:'application/json'}})
      .then(function(r){return r.json();})
      .then(function(data){
        if(!data || data.ok===false){ dpgWrap.innerHTML='<div class="drm-note">载入失败</div>'; return; }
        dpgLoaded = true;
        renderDpgTable(data.members);
      })
      .catch(function(){ dpgWrap.innerHTML='<div class="drm-note">载入失败</div>'; });
  }
  if(dpgSave) dpgSave.addEventListener('click', function(){
    var rows = dpgWrap.querySelectorAll('.dpg-select');
    var updates = [];
    rows.forEach(function(sel){
      updates.push({ orgLabel: sel.getAttribute('data-org'), userid: sel.getAttribute('data-userid'), projectGroup: sel.value });
    });
    dpgSave.disabled = true;
    fetch(PG_API, {method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({updates:updates})})
      .then(function(r){return r.json();})
      .then(function(data){
        dpgSave.disabled = false;
        if(!data || data.ok===false){ showDpgBanner('err', (data&&data.error)||'保存失败'); return; }
        renderDpgTable(data.members);
        showDpgBanner('ok', '已保存');
        load();
      })
      .catch(function(e){ dpgSave.disabled=false; showDpgBanner('err', e.message||'保存失败'); });
  });
  if(dpgToggle) dpgToggle.addEventListener('click', function(){
    var open = dpgPanel.classList.toggle('open');
    dpgPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    dpgToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if(open && !dpgLoaded) loadDpg();
  });`
    : "";

  const projectViewRosterBlock = `
  var dpvrToggle = document.getElementById('dpvrToggle');
  var dpvrPanel = document.getElementById('dpvrPanel');
  var dpvrCols = document.getElementById('dpvrCols');
  var dpvrBanner = document.getElementById('dpvrBanner');
  var dpvrRediscover = document.getElementById('dpvrRediscover');
  var dpvrHint = document.getElementById('dpvrHint');
  var dpvrTitle = document.getElementById('dpvrTitle');
  var dpvrLoadedViewId = '';
  var dpvrOrgLabel = '';
  function customViewIdFromView(v){
    if(!v || v.indexOf('custom:')!==0) return '';
    return v.slice(7);
  }
  function isCustomViewActive(){ return VIEW.indexOf('custom:')===0; }
  function showDpvrBanner(kind, msg){
    if(!dpvrBanner) return;
    dpvrBanner.className = 'drm-banner show ' + kind;
    dpvrBanner.innerHTML = msg;
    clearTimeout(showDpvrBanner._t);
    showDpvrBanner._t = setTimeout(function(){ dpvrBanner.className='drm-banner'; }, 7000);
  }
  function syncProjectViewRosterToolbar(access){
    var onCustom = isCustomViewActive();
    if(dpvrToggle) dpvrToggle.style.display = onCustom ? '' : 'none';
    if(!onCustom && dpvrPanel){
      dpvrPanel.classList.remove('open');
      dpvrPanel.setAttribute('aria-hidden', 'true');
      if(dpvrToggle) dpvrToggle.setAttribute('aria-expanded', 'false');
    }
    if(access && access.customOnly){
      var drmToggle = document.getElementById('drmToggle');
      var dpgToggle = document.getElementById('dpgToggle');
      if(drmToggle) drmToggle.style.display = 'none';
      if(dpgToggle) dpgToggle.style.display = 'none';
    }
  }
  function renderProjectViewRoster(members, label, orgLabel){
    if(!dpvrCols) return;
    dpvrOrgLabel = orgLabel || dpvrOrgLabel;
    if(dpvrTitle && label) dpvrTitle.textContent = label + ' · 名单';
    if(dpvrHint && orgLabel) dpvrHint.textContent = orgLabel + ' · 按姓名搜索加入 · 重新发现扫描近 30 天';
    var list = members || [];
    var rows = list.map(function(m){
      var src = m.source === 'discovery' ? '自动' : (m.source === 'manual' ? '手动' : '');
      var tag = src ? ('<span class="drm-r-tag">'+esc(src)+'</span>') : '';
      return '<div class="drm-member"><span class="drm-m-name">'+esc(m.name||m.userid)+'</span>'
        + '<span class="drm-m-uid">'+esc(m.userid)+'</span>'+tag+'<span class="drm-m-spacer"></span>'
        + '<button class="drm-x" title="移除" data-pv-action="remove" data-userid="'+esc(m.userid)+'">×</button></div>';
    }).join('');
    if(!rows) rows = '<div class="drm-members-empty">暂无成员 · 可搜索加入或点「重新发现」</div>';
    var mark = esc((orgLabel||'·').slice(0,1));
    dpvrCols.innerHTML = '<section class="drm-col">'
      + '<div class="drm-col-head"><span class="dr-org-mark">'+mark+'</span><h4>'+esc(orgLabel||'组织')+'</h4></div>'
      + '<div class="drm-members">'+rows+'</div>'
      + '<div class="drm-search-wrap"><input class="drm-search" id="dpvrSearch" placeholder="在'+esc(orgLabel||'组织')+'里按姓名搜索…" autocomplete="off" />'
      + '<div class="drm-results" id="dpvrResults"></div></div>'
      + '</section>';
  }
  function pvRosterApi(viewId){ return API + '/project-views/' + encodeURIComponent(viewId) + '/roster'; }
  function loadProjectViewRoster(force){
    var viewId = customViewIdFromView(VIEW);
    if(!viewId || !dpvrCols) return;
    if(!force && dpvrLoadedViewId === viewId && dpvrCols.querySelector('.drm-member, .drm-members-empty')) return;
    dpvrLoadedViewId = viewId;
    dpvrCols.innerHTML = '<div class="drm-note"><span class="drm-spin"></span> 载入名单…</div>';
    fetch(pvRosterApi(viewId), {headers:{Accept:'application/json'}})
      .then(function(r){return r.json();})
      .then(function(data){
        if(!data || data.ok===false){ dpvrCols.innerHTML='<div class="drm-note">载入失败：'+esc((data&&data.error)||'未知错误')+'</div>'; return; }
        renderProjectViewRoster(data.members, data.label, data.orgLabel);
      })
      .catch(function(e){ dpvrCols.innerHTML='<div class="drm-note">载入失败：'+esc(e.message||e)+'</div>'; });
  }
  function postProjectViewRoster(viewId, payload){
    return fetch(pvRosterApi(viewId), {method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload)}).then(function(r){return r.json();});
  }
  function doProjectViewSearch(q){
    var box = document.getElementById('dpvrResults');
    if(!box || !dpvrOrgLabel) return;
    if(!q){ box.className='drm-results'; box.innerHTML=''; return; }
    box.className='drm-results show';
    box.innerHTML='<div class="drm-note"><span class="drm-spin"></span> 搜索中…</div>';
    fetch(API+'/contacts?org='+encodeURIComponent(dpvrOrgLabel)+'&q='+encodeURIComponent(q), {headers:{Accept:'application/json'}})
      .then(function(r){return r.json();})
      .then(function(data){
        if(!data || data.ok===false){ box.innerHTML='<div class="drm-note">'+esc((data&&data.error)||'搜索失败')+'</div>'; return; }
        var list = data.candidates||[];
        if(!list.length){ box.innerHTML='<div class="drm-note">无匹配</div>'; return; }
        box.innerHTML = list.map(function(c){
          if(c.inRoster){
            return '<button class="drm-result" disabled><span class="drm-r-name">'+esc(c.name||c.userid)+'</span><span class="drm-r-tag">已在名单</span></button>';
          }
          return '<button class="drm-result" data-pv-action="add" data-userid="'+esc(c.userid)+'" data-name="'+esc(c.name||'')+'">'
            + '<span class="drm-r-name">'+esc(c.name||c.userid)+'</span><span class="drm-r-uid">'+esc(c.userid)+'</span></button>';
        }).join('');
      })
      .catch(function(e){ box.innerHTML='<div class="drm-note">搜索失败：'+esc(e.message||e)+'</div>'; });
  }
  if(dpvrCols) dpvrCols.addEventListener('click', function(e){
    var btn = e.target.closest('[data-pv-action]');
    if(!btn) return;
    var viewId = customViewIdFromView(VIEW);
    if(!viewId) return;
    var action = btn.getAttribute('data-pv-action');
    var userid = btn.getAttribute('data-userid');
    if(action==='add'){
      showDpvrBanner('ok', '<span class="drm-spin"></span> 加入中…');
      postProjectViewRoster(viewId, {action:'add', userid:userid, name:btn.getAttribute('data-name')||''}).then(function(data){
        if(!data || data.ok===false){ showDpvrBanner('err', '加入失败'); return; }
        renderProjectViewRoster(data.members, data.label, data.orgLabel);
        load(true);
      });
    } else if(action==='remove'){
      postProjectViewRoster(viewId, {action:'remove', userid:userid}).then(function(data){
        if(!data || data.ok===false){ showDpvrBanner('err', '移除失败'); return; }
        renderProjectViewRoster(data.members, data.label, data.orgLabel);
        load(true);
      });
    }
  });
  var dpvrSearchTimer;
  if(dpvrCols) dpvrCols.addEventListener('input', function(e){
    var inp = e.target;
    if(!inp || inp.id !== 'dpvrSearch') return;
    clearTimeout(dpvrSearchTimer);
    dpvrSearchTimer = setTimeout(function(){ doProjectViewSearch(inp.value.trim()); }, 320);
  });
  if(dpvrRediscover) dpvrRediscover.addEventListener('click', function(){
    var viewId = customViewIdFromView(VIEW);
    if(!viewId) return;
    dpvrRediscover.disabled = true;
    showDpvrBanner('ok', '<span class="drm-spin"></span> 重新发现中…');
    fetch(API + '/project-views/' + encodeURIComponent(viewId) + '/discover', {method:'POST',headers:{Accept:'application/json'}})
      .then(function(r){return r.json();})
      .then(function(data){
        dpvrRediscover.disabled = false;
        if(!data || data.ok===false){ showDpvrBanner('err', esc((data&&data.error)||'发现失败')); return; }
        renderProjectViewRoster(data.members, data.label, data.orgLabel);
        showDpvrBanner('ok', '发现完成 · 新增 '+(data.added||0)+' 人 · 共 '+(data.totalRoster||0)+' 人');
        load(true);
      })
      .catch(function(e){ dpvrRediscover.disabled=false; showDpvrBanner('err', esc(e.message||'发现失败')); });
  });
  if(dpvrToggle && dpvrPanel) dpvrToggle.addEventListener('click', function(){
    var open = dpvrPanel.classList.toggle('open');
    dpvrPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    dpvrToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if(open) loadProjectViewRoster(true);
  });`;

  return `
(function(){
  var API = '${api}';
  var INIT_DATE = '${initDate}';
  var VIEW = '${initView}';
  var CAN_MANAGE = ${canManageRoster};
  var dateInput = document.getElementById('drDate');
  var refreshBtn = document.getElementById('drRefresh');
  var meta = document.getElementById('drMeta');
  var content = document.getElementById('drContent');
  var viewBtns = document.querySelectorAll('.dr-view-btn');
  var viewSwitch = document.getElementById('drViewSwitch');
  var viewBtns = document.querySelectorAll('.dr-view-btn');
  if (INIT_DATE && dateInput) dateInput.value = INIT_DATE;
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function fmtTime(ms){ if(!ms) return ''; try { return new Date(Number(ms)).toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit'}); } catch(e){ return ''; } }
  function bindLogout(){
    var logoutBtn = document.getElementById('logoutBtn');
    if(!logoutBtn) return;
    logoutBtn.addEventListener('click', function(){
      fetch('/api/workbench/logout', { method:'POST' })
        .then(function(r){ return r.json().catch(function(){ return {}; }); })
        .then(function(data){ location.href = data.redirectTo || "/workbench/login"; })
        .catch(function(){ location.href = "/workbench/login"; });
    });
  }
  function renderViewTabs(access){
    if(!viewSwitch) return;
    var html = '';
    if(access && access.customOnly){
      (access.customViews||[]).forEach(function(v, i){
        var cv = 'custom:'+v.id;
        html += '<button type="button" class="dr-view-btn'+((VIEW===cv || (i===0 && VIEW.indexOf('custom:')!==0))?' is-on':'')+'" data-view="'+esc(cv)+'" role="tab">' + esc(v.label) + '</button>';
      });
      viewSwitch.innerHTML = html;
      if(VIEW.indexOf('custom:')!==0 && access.customViews && access.customViews[0]){
        VIEW = 'custom:'+access.customViews[0].id;
      }
    } else {
      html += '<button type="button" class="dr-view-btn'+(VIEW==='company'?'':' is-on')+'" data-view="project" role="tab">项目视图</button>';
      html += '<button type="button" class="dr-view-btn'+(VIEW==='company'?' is-on':'')+'" data-view="company" role="tab">公司视图</button>';
      (access && access.customViews ? access.customViews : []).forEach(function(v){
        var cv = 'custom:'+v.id;
        html += '<button type="button" class="dr-view-btn'+(VIEW===cv?' is-on':'')+'" data-view="'+esc(cv)+'" role="tab">'+esc(v.label)+'</button>';
      });
      viewSwitch.innerHTML = html;
    }
    viewBtns = viewSwitch.querySelectorAll('.dr-view-btn');
  }
  if(viewSwitch) viewSwitch.addEventListener('click', function(e){
    var btn = e.target.closest('.dr-view-btn');
    if(!btn) return;
    setView(btn.getAttribute('data-view'));
  });
  function setView(v){
    VIEW = v || 'project';
    viewBtns.forEach(function(btn){
      var on = btn.getAttribute('data-view') === VIEW;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    syncProjectViewRosterToolbar(window.__drAccess || null);
    load(false);
  }

  function renderMediaItems(items, kind){
    if(!items || !items.length) return '';
    return '<div class="dr-media-row">' + items.map(function(a){
      var name = esc(a.name || (kind === 'img' ? '图片' : '附件'));
      if(a.url){
        if(kind === 'img'){
          return '<a class="dr-media-img-wrap" href="'+esc(a.url)+'" target="_blank" rel="noopener noreferrer">'
            + '<img class="dr-media-img" src="'+esc(a.url)+'" alt="'+name+'" loading="lazy" />'
            + '</a>';
        }
        return '<a class="dr-media-att" href="'+esc(a.url)+'" target="_blank" rel="noopener noreferrer">'+name+'</a>';
      }
      return '<span class="dr-media-placeholder" title="请在钉钉原日志查看">'+name+' · 原日志</span>';
    }).join('') + '</div>';
  }
  function renderReportActions(r){
    if(r.openInDingtalkUrl){
      return '<div class="dr-rpt-actions"><a class="dr-btn dr-btn-sm dr-dingtalk-link" href="'+esc(r.openInDingtalkUrl)+'" target="_blank" rel="noopener noreferrer">在钉钉原日志评论</a></div>';
    }
    if(r.reportId){
      return '<div class="dr-rpt-actions"><span class="dr-btn dr-btn-sm dr-dingtalk-link is-disabled" title="请在钉钉 → 日志 → 按同事与日期查找">在钉钉原日志评论</span></div>';
    }
    return '';
  }
  function renderReport(r){
    var head = r.templateName ? ('<div class="dr-rpt-tmpl">'+esc(r.templateName)+(r.createTime?(' · '+esc(fmtTime(r.createTime))):'')+'</div>') : '';
    var rows = (r.contents||[]).filter(function(f){
      return String(f.value||'').trim() || (f.attachments && f.attachments.length);
    }).map(function(f){
      var body = '';
      if(String(f.value||'').trim()) body += '<div class="dr-field-text">'+esc(f.value)+'</div>';
      if(f.attachments && f.attachments.length) body += renderMediaItems(f.attachments, 'att');
      return '<div class="dr-field"><span class="dr-field-k">'+esc(f.key)+'</span><span class="dr-field-v">'+body+'</span></div>';
    }).join('');
    if (r.images && r.images.length) {
      rows += '<div class="dr-field"><span class="dr-field-k">图片</span><span class="dr-field-v">'+renderMediaItems(r.images, 'img')+'</span></div>';
    }
    if(!rows) rows = '<div class="dr-field"><span class="dr-field-v dr-muted">（无内容）</span></div>';
    return '<div class="dr-rpt">'+head+rows+renderReportActions(r)+'</div>';
  }
  function renderOrg(org){
    var subCount = org.submitted ? org.submitted.length : 0;
    var missCount = org.missing ? org.missing.length : 0;
    var leaveCount = org.onLeave ? org.onLeave.length : 0;
    var mark = esc((org.label||'·').slice(0,1));
    var subs = (org.submitted||[]).map(function(emp){
      var multi = (emp.reports && emp.reports.length>1) ? (' <span class="dr-count">'+emp.reports.length+' 篇</span>') : '';
      return '<div class="dr-emp"><div class="dr-emp-name">'+esc(emp.name||emp.userid)+multi+'</div>'+(emp.reports||[]).map(renderReport).join('')+'</div>';
    }).join('');
    if(!subs) subs = '<div class="dr-empty">本组织该日暂无已提交日报</div>';
    var missing = missCount ? ('<div class="dr-missing"><span class="dr-missing-lbl">未提交（'+missCount+'）</span>'+org.missing.map(function(m){return esc(m.name||m.userid);}).join('、')+'</div>') : '';
    var onleave = leaveCount ? ('<div class="dr-onleave"><span class="dr-onleave-lbl">请假（'+leaveCount+'）</span>'+org.onLeave.map(function(m){return esc(m.name||m.userid);}).join('、')+'</div>') : '';
    var errs = (org.errors && org.errors.length) ? ('<div class="dr-errline">读取失败：'+org.errors.map(function(e){return esc(e.name||e.userid);}).join('、')+'</div>') : '';
    var leavePill = leaveCount ? ('<span class="dr-pill dr-pill-leave">请假 '+leaveCount+'</span>') : '';
    return '<section class="dr-org">'
      + '<div class="dr-org-head"><div class="dr-org-title"><span class="dr-org-mark">'+mark+'</span><h2>'+esc(org.label)+'</h2></div>'
      + '<span class="dr-org-stat"><span class="dr-pill dr-pill-ok">已交 '+subCount+'</span><span class="dr-pill dr-pill-miss">未交 '+missCount+'</span>'+leavePill+'</span></div>'
      + subs + missing + onleave + errs + '</section>';
  }
  function renderProjectGroup(group){
    var subCount = 0, missCount = 0, leaveCount = 0;
    var allSubmitted = [];
    var allMissing = [];
    var allOnLeave = [];
    var allErrors = [];
    (group.orgs||[]).forEach(function(org){
      subCount += (org.submitted||[]).length;
      missCount += (org.missing||[]).length;
      leaveCount += (org.onLeave||[]).length;
      (org.submitted||[]).forEach(function(emp){ allSubmitted.push(emp); });
      (org.missing||[]).forEach(function(m){ allMissing.push(m); });
      (org.onLeave||[]).forEach(function(m){ allOnLeave.push(m); });
      (org.errors||[]).forEach(function(e){ allErrors.push(e); });
    });
    var subs = allSubmitted.map(function(emp){
      var multi = (emp.reports && emp.reports.length>1) ? (' <span class="dr-count">'+emp.reports.length+' 篇</span>') : '';
      return '<div class="dr-emp"><div class="dr-emp-name">'+esc(emp.name||emp.userid)+multi+'</div>'+(emp.reports||[]).map(renderReport).join('')+'</div>';
    }).join('');
    if(!subs && !allMissing.length && !allOnLeave.length && !allErrors.length) subs = '<div class="dr-empty">该组暂无数据</div>';
    var missing = missCount ? ('<div class="dr-missing"><span class="dr-missing-lbl">未提交（'+missCount+'）</span>'+allMissing.map(function(m){return esc(m.name||m.userid);}).join('、')+'</div>') : '';
    var onleave = leaveCount ? ('<div class="dr-onleave"><span class="dr-onleave-lbl">请假（'+leaveCount+'）</span>'+allOnLeave.map(function(m){return esc(m.name||m.userid);}).join('、')+'</div>') : '';
    var errs = allErrors.length ? ('<div class="dr-errline">读取失败：'+allErrors.map(function(e){return esc(e.name||e.userid);}).join('、')+'</div>') : '';
    var leavePill = leaveCount ? ('<span class="dr-pill dr-pill-leave">请假 '+leaveCount+'</span>') : '';
    return '<section class="dr-pgroup dr-pgroup--'+esc(group.id)+'">'
      + '<div class="dr-pgroup-head"><h2>'+esc(group.label)+'</h2>'
      + '<span class="dr-org-stat"><span class="dr-pill dr-pill-ok">已交 '+subCount+'</span><span class="dr-pill dr-pill-miss">未交 '+missCount+'</span>'+leavePill+'</span></div>'
      + '<div class="dr-pgroup-body dr-pgroup-body--flat">'+subs+missing+onleave+errs+'</div></section>';
  }
  function renderCustomProjectView(cpv){
    var orgs = cpv.orgs || [];
    var hitCount = 0;
    var subs = [];
    orgs.forEach(function(org){
      (org.submitted||[]).forEach(function(emp){
        hitCount += 1;
        subs.push('<div class="dr-emp"><div class="dr-emp-name">'+esc(emp.name||emp.userid)+'</div>'+(emp.reports||[]).map(renderReport).join('')+'</div>');
      });
    });
    var body = subs.join('') || '<div class="dr-empty">该日暂无命中「'+esc(cpv.label)+'」的日报模块</div>';
    return '<section class="dr-pgroup dr-pgroup--custom"><div class="dr-pgroup-head"><h2>'+esc(cpv.label)+'</h2>'
      + '<span class="dr-org-stat"><span class="dr-pill dr-pill-ok">命中 '+hitCount+' 人</span></span></div>'
      + '<p class="dr-readonly-notice">汇总页仅供浏览；评论请在钉钉原日志进行。</p>'
      + '<div class="dr-pgroup-body dr-pgroup-body--flat">'+body+'</div></section>';
  }
  function load(refresh){
    meta.textContent = '加载中…';
    content.innerHTML = '';
    var p = new URLSearchParams();
    var d = dateInput && dateInput.value;
    if(d) p.set('date', d);
    p.set('view', VIEW);
    if(refresh) p.set('refresh', '1');
    fetch(API+'?'+p.toString(), {headers:{Accept:'application/json'}})
      .then(function(r){return r.json();})
      .then(function(data){
        if(!data || data.ok===false){ meta.textContent = '加载失败：'+esc((data&&data.error)||'未知错误'); return; }
        if(data.access) {
          window.__drAccess = data.access;
          renderViewTabs(data.access);
          syncProjectViewRosterToolbar(data.access);
        } else {
          syncProjectViewRosterToolbar(null);
        }
        if(dateInput && data.date && !dateInput.value) dateInput.value = data.date;
        var tail = data.errorCount ? (' · 读取失败 '+data.errorCount) : '';
        var scanNote = data.scanning ? ' · <span class="drm-spin"></span> 正在扫描…' : '';
        var partialNote = data.partialScan ? ' · 名册快扫（刷新=全量）' : '';
        var cacheNote = data.cacheScannedAt ? (' · 缓存 '+esc(fmtTime(Date.parse(data.cacheScannedAt)))) : '';
        if(data.customProjectView){
          meta.innerHTML = (data.dateLabel||data.date||'')+' · '+esc(data.customProjectView.label)+' · 命中 '+(data.submittedCount||0)+' 人'+partialNote+cacheNote+scanNote+tail;
          content.innerHTML = renderCustomProjectView(data.customProjectView);
          if(isCustomViewActive()) loadProjectViewRoster(false);
          return;
        }
        var viewLabel = VIEW === 'company' ? '公司视图' : '项目视图';
        var leaveTail = (data.onLeaveCount||0) ? (' · 请假 '+data.onLeaveCount) : '';
        meta.textContent = (data.dateLabel||data.date||'')+' · '+viewLabel+' · 已交 '+(data.submittedCount||0)+' · 未交 '+(data.missingCount||0)+leaveTail+tail;
        if(VIEW === 'company'){
          content.innerHTML = (data.orgs||[]).map(renderOrg).join('') || '<div class="dr-empty">暂无组织配置</div>';
        } else {
          content.innerHTML = (data.projectGroups||[]).map(renderProjectGroup).join('') || '<div class="dr-empty">暂无项目组数据</div>';
        }
      })
      .catch(function(e){ meta.textContent='加载失败：'+esc(e.message||e); });
  }
  ${rosterBlock}
  ${groupBlock}
  ${projectViewRosterBlock}
  if(dateInput) dateInput.addEventListener('change', function(){ load(false); });
  if(refreshBtn) refreshBtn.addEventListener('click', function(){ load(true); });
  bindLogout();
  renderViewTabs(null);
  load();
})();
`;
}
