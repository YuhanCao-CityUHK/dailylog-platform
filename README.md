# 中科微光 · 工作日志平台（dailylog）

本仓库于 2026-09-14 从当前生产服务器 `/opt/dailylog/app` 导入，作为新版平台的独立私有源码仓库。导入范围、版本记录、验证结果及恢复边界见 [生产代码导入说明](docs/PRODUCTION_IMPORT.md)。仓库不含生产凭证和业务数据。

部署在 dailylog.vivolightsales.com 的新日志平台。一套 Node.js 服务（零外部数据库，node:sqlite），包含：

1. **一期工作日志平台**（按《工作日志平台一期开发文档》实现）：日志填写（多归属/多事项/逐项工时/附件/草稿自动保存）、AI 检查与自动归类（LLM 主路 + 确定性规则兜底）、质量评价（ex/vg/good/一般）、我的日志（补填/修改/删除/标签确认与采纳率）、主管首页（提交情况/风险标签监控/工时分布/重要进展/卡点/我的关注）、项目/分类/员工/部门日常四视角、权限内日志问答（事实/分析分段 + 引用溯源）。
2. **统一项目工作台**：读取钉钉日报工作块中的“成本归属项目”，先按后台项目规则与 `project_aliases` 归并到业务项目，再与平台项目合并为同一目录；带成本编码但无法识别的明细进入“其他”，不会逐条占用主侧栏。普通的新项目名称仍可自动建立入口。每个项目同时展示钉钉日报原文和平台日志原文，原固定 `projectViews` 接口暂时保留为兼容入口。
3. **登录**：钉钉免登（企业内部应用 H5）+ 本地账号密码（外部工程师/管理员），统一会话。
4. **提醒**：工作日 9:00 检查前一工作日未提交并发钉钉工作通知（默认关闭，验证后开启）。
5. **DWS 个人连接**：钉钉员工首次进入时自动发起本人授权；每个平台用户使用独立的 DWS HOME、配置和加密凭证目录，后续由 DWS 自动续期，并以 `corpId + userId` 严格核验身份。本阶段只连接与验证身份，不读取或缓存业务内容。

## 目录

```
src/
  server.ts            主服务（路由/静态/SPA）
  infra/               配置、SQLite、HTTP、工作日历、日志
  auth/                会话、口令、钉钉免登、认证接口
  dws/                 DWS 分用户授权、凭证隔离与本人身份核验
  platform/            一期业务：填写/我的日志/聚合视角/问答/管理/提醒
  digest/              钉钉日报采集、项目匹配、缓存与简述引擎
  web/                 统一项目工作台接线、钉钉日报 API 与权限控制
public/                前端（登录页 + SPA：index.html/app.js/styles.css）
scripts/               init-accounts（初始化账号）、smoke-test（端到端自测）
deploy/                部署指南、nginx、systemd、历史部署脚本（不含密钥）
data/                  运行数据（SQLite/上传附件/日报配置），不入库
```

## 本地开发

```bash
npm install
cp .env.example .env   # 填写本地配置；生产配置由管理员单独保管
npm run init-accounts   # 生成 admin / pinghu01 / pinghu02 及初始密码
npm run dev             # http://127.0.0.1:8100
BASE=http://127.0.0.1:8100 SMOKE_EMP_LOGIN=pinghu01 SMOKE_EMP_PASSWORD=xxx npm run smoke
npm run typecheck
npm run verify-daily-report-project-filter
npm run verify-dynamic-project-catalog
npm run verify-dws-connection
npm run verify-daily-assistant-readiness
```

## 对话式日报助手试点

新助手默认关闭，并按以下顺序独立灰度：总开关与试点用户、对话生成、正式提交、新主管首页、16:30 预准备、17:30/09:30 提醒。对应环境变量均列在 `.env.example`，关闭子开关会保留旧填写或旧主管首页作为回退；`assistant-context.sqlite` 是 12 小时临时证据库，不进入正式主库回滚备份。

试点前离线执行：

```bash
npm run migrate
npm run typecheck
npm test
npm run verify-daily-assistant-readiness
```

该检查不部署、不发送消息，也不读取真实员工聊天、文档或听记。

多源上下文、WorkEvent 真实模型链路、完整性账本、灰度配置和验证方法见
[`docs/日报助手多源WorkEvent开发说明.md`](docs/日报助手多源WorkEvent开发说明.md)。

## 部署

见 `deploy/部署指南.md`（历史部署流程参考）。其中的账号标识已替换为示例值；SSH 私钥、生产 `.env` 和数据库须单独配置。仓库创建不会自动部署或重启线上服务。
