/**
 * 冒烟自测：起一个内嵌流程直接打 HTTP 接口（需先另开终端 npm run dev，或对生产地址执行）。
 * 用法：BASE=http://127.0.0.1:8100 npm run smoke
 * 覆盖：登录 → 草稿 → AI检查 → 提交 → 我的日志 → 各视角 → 问答 → 管理接口边界。
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:8100";
const LOGIN = process.env.SMOKE_LOGIN ?? "admin";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "";
const EMP_LOGIN = process.env.SMOKE_EMP_LOGIN ?? "pinghu01";
const EMP_PASSWORD = process.env.SMOKE_EMP_PASSWORD ?? "";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`✓ ${name}`);
  else {
    failures += 1;
    console.error(`✗ ${name}`, extra ?? "");
  }
}

async function client(): Promise<{
  fetchJson: (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>;
}> {
  let cookie = "";
  return {
    async fetchJson(path: string, init?: RequestInit) {
      const res = await fetch(BASE + path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(init?.headers ?? {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    },
  };
}

async function main(): Promise<void> {
  const health = await fetch(BASE + "/healthz").then((r) => r.json());
  check("healthz", (health as any).status === "ok");

  if (!EMP_PASSWORD) {
    console.log("（未提供 SMOKE_EMP_PASSWORD，跳过登录链路测试；先跑 npm run init-accounts 拿密码）");
    return;
  }

  /* 外部工程师链路 */
  const emp = await client();
  const login = await emp.fetchJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ loginName: EMP_LOGIN, password: EMP_PASSWORD }),
  });
  check("外部账号登录", login.status === 200 && login.body?.ok === true, login.body);
  const me = await emp.fetchJson("/api/me");
  check("会话有效 /api/me", me.body?.ok === true && me.body?.user?.loginName === EMP_LOGIN);

  const meta = await emp.fetchJson("/api/fill/meta");
  check("填写元数据", meta.body?.ok === true && Array.isArray(meta.body?.categories));

  const newProj = await emp.fetchJson("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "水锤试验台", force: true }),
  });
  check("外部新建项目", newProj.body?.ok === true && newProj.body?.created?.id, newProj.body);
  const pid = String(newProj.body.created.id);

  const draft = {
    affiliations: [
      {
        affId: pid,
        items: [
          {
            text: "完成水锤试验台管路连接，并执行 3 组压力测试；第二组出现压力波动，已复现但尚未定位原因，需要设备组协助排查。",
            hours: 5,
            cats: [],
            atts: [],
          },
        ],
      },
      { affId: "dept", items: [{ text: "整理试验数据记录表，归档 12 组历史数据。", hours: 3, cats: [], atts: [] }] },
    ],
  };
  const saveDraft = await emp.fetchJson("/api/fill/draft", { method: "POST", body: JSON.stringify(draft) });
  check("草稿保存", saveDraft.body?.ok === true);
  const loadDraft = await emp.fetchJson("/api/fill/draft");
  check("草稿读取", loadDraft.body?.ok === true && loadDraft.body?.draft?.affiliations?.length === 2);

  const checkRes = await emp.fetchJson("/api/fill/check", { method: "POST", body: JSON.stringify(draft) });
  check("AI 检查返回", checkRes.body?.ok === true && Array.isArray(checkRes.body?.suggestions), checkRes.body?.error);
  console.log(`  （检查来源：${checkRes.body?.source}；建议 ${checkRes.body?.suggestions?.length} 条；质量预估 ${checkRes.body?.quality}）`);

  const submit = await emp.fetchJson("/api/fill/submit", {
    method: "POST",
    body: JSON.stringify({ affiliations: checkRes.body.affiliations ?? draft.affiliations }),
  });
  check("提交日志", submit.body?.ok === true && submit.body?.totalItems === 2, submit.body);

  const mylogs = await emp.fetchJson("/api/mylogs");
  check("我的日志", mylogs.body?.ok === true && mylogs.body?.rows?.some((r: any) => r.status === "submitted"));

  const homeDenied = await emp.fetchJson("/api/views/home");
  check("外部账号被拒于主管首页", homeDenied.status === 403);
  const drDenied = await emp.fetchJson("/api/workbench/daily-reports");
  check("外部账号被拒于日报汇总", drDenied.status === 403);

  const projView = await emp.fetchJson("/api/views/project?id=" + pid);
  check("项目视角", projView.body?.ok === true && projView.body?.project?.hours7total >= 5, projView.body?.error);
  const deptView = await emp.fetchJson("/api/views/dept");
  check("部门日常视角", deptView.body?.ok === true && deptView.body?.entries?.length >= 1);

  const qa = await emp.fetchJson("/api/qa/ask", {
    method: "POST",
    body: JSON.stringify({ question: "水锤试验台项目当前整体状态是什么？" }),
  });
  check("问答有回答结构", qa.body?.ok === true && qa.body?.answer, qa.body?.error);
  console.log(`  （问答类型：${qa.body?.answer?.kind}；引用 ${qa.body?.answer?.refs?.length ?? 0} 条）`);

  const adminDenied = await emp.fetchJson("/api/admin/users");
  check("外部账号被拒于管理接口", adminDenied.status === 403);

  /* 管理员链路 */
  if (PASSWORD) {
    const adm = await client();
    const aLogin = await adm.fetchJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ loginName: LOGIN, password: PASSWORD }),
    });
    check("管理员登录", aLogin.body?.ok === true, aLogin.body);
    const users = await adm.fetchJson("/api/admin/users");
    check("管理员用户列表", users.body?.ok === true && users.body?.users?.length >= 3);
    const home = await adm.fetchJson("/api/views/home");
    check("管理员主管首页", home.body?.ok === true && home.body?.submission, home.body?.error);
    console.log(`  （进展 ${home.body?.progress?.length ?? 0} 条 / 卡点 ${home.body?.blockers?.length ?? 0} 条，来源 ${home.body?.insightsSource}）`);
    const empView = await adm.fetchJson("/api/views/employee");
    check("管理员员工视角", empView.body?.ok === true && empView.body?.employees?.length >= 1);
  }

  console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
