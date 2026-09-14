# 新版日志平台生产代码导入说明

## 来源与版本

- 导入日期：2026-09-14（Asia/Shanghai）。
- 实例：`daily-report-ykh`，公网 IP `47.239.168.39`。
- 平台：`https://dailylog.vivolightsales.com`。
- 当前运行目录：`/opt/dailylog/app`，服务：`dailylog.service`。
- `DEPLOYED_RELEASE` 记录：`39ff5f2a45ab2499b1f09a92dbbd3cb6e6161dbb`。
- 最近 `DEPLOYED_HOTFIX` 记录：`20260908-vivoflow-shared-5f1a424`，候选提交 `5f1a4245bf0ad4710c50464b2a5a25771b9e9d14`，部署时间 `2026-09-08T07:50:22.380361+00:00`。

上述提交号来自生产部署标记，不能证明服务器所有文件都等于某一个原始 Git 提交。原服务器没有 `.git`，本仓库从当前实际文件建立新的提交历史，不包含原开发仓库的提交记录。

## 导入范围

包含生产应用的 `src/`、`public/`、`scripts/`、`tests/`、`deploy/`、`docs/`，以及 README、依赖锁文件、TypeScript 配置和环境配置样例。

不包含生产 `.env`、SSH 私钥、DWS 授权目录、令牌、数据库、员工业务日志、附件、缓存、运行日志、备份、旧发布包和 `node_modules`。

导入时将配置样例、测试用例、注释及历史运维脚本中的真实人员姓名、userid、应用标识替换为示例值，清空示例提醒收件人；修复部署指南文件名乱码，补充忽略规则。生产服务端业务逻辑及前端实现没有修改。历史运维脚本中 `example-*` 和“示例”值只是模板，不能直接作为生产参数执行；迁移审计人等参数也需要显式配置。

## 本地验证

使用 Node.js 24.16.0，通过 `npm ci --ignore-scripts --no-audit --no-fund` 安装锁定依赖。在无生产 `.env`、关闭真实 LLM、DWS 和提醒的本地环境中，清理后的 `npm run typecheck` 通过；`npm test` 共 182 项，其中 181 项通过、1 项跳过、0 项失败。

## 恢复边界

单独克隆仓库不会恢复员工数据、组织成员映射或第三方授权。恢复环境需管理员提供配置、业务数据库及附件，并重新核对通知与定时任务的启用状态。

原 `package.json` 保留了部分生产包中未提供文件的历史命令，例如 `bakeoff`、`legacy-baseline`、`harness-replay` 对应的 `evals/`。这些命令不能由本次导入直接恢复；以仓库实际存在的文件为准。

本次仅建立源码仓库，没有修改、重启或重新部署线上服务。
