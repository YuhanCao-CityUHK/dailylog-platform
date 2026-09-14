# 日报助手多源 WorkEvent 开发说明

## 目标链路

新链路按以下顺序运行：DWS 完整分页采集 → 临时加密 Evidence → 聊天上下文重建 → 跨来源 Evidence Bundle → 真实模型事件抽取/融合 → Schema 与 Grounding 硬校验 → 加密 WorkEvent Store → CandidateService → Agent Harness V2。

功能默认关闭。只有同时开启 `DAILY_ASSISTANT_EVENT_FUSION_ENABLED=1` 且钉钉 userid 位于 `DAILY_ASSISTANT_EVENT_FUSION_PILOT_USERIDS` 的员工使用新候选链路；其他员工继续使用旧链路。关闭事件开关即可回滚，不删除新表或正式日报。

## 采集与完整性

- 聊天会话列表与逐会话消息均使用 `--page-all --page-limit 50`；消息查询同时使用北京时间当天起止、`--order asc`，并在服务端再次按北京时间过滤和按消息 ID 去重。
- 文档、Wiki、日历、听记、待办、钉钉日志和考勤审批的可分页列表统一使用完整分页参数。
- 来源账本保存 `complete`、`hasMore`、`stopReason`、`failures`、`pagesFetched`、原始条目数；聊天另存逐会话页数、消息数、失败页和停止原因。
- 任何分页、详情或权限失败均为 `partial/error`。已有证据可以继续使用，但相关 WorkEvent 会限制置信度并要求员工确认。

## Evidence Bundle 与 WorkEvent

Evidence 保留会话、话题、回复、引用、资源关联、与员工关系、时态角色和来源完整性。聊天上下文以本人消息、@本人消息为锚点，合并同回复链、同话题、引用消息以及限定时间内相邻消息；他人消息只作为背景或确认依据。

证据包构建后，每条输入 Evidence 必须出现在至少一个 Bundle，或进入带原因的忽略账本。输入低于预算时调用一次 Fusion；超过预算时逐 Bundle 调用 Extractor，再调用 Fusion 合并中间 WorkEvent。

生产 Provider 调用现有 OpenAI 兼容 `/chat/completions`，使用已有 `LLM_BASE_URL`、`LLM_API_KEY` 和环境变量中的固定主备模型快照。输出必须是 `work-event-v1` 严格 JSON；同一 Provider 的 Schema 错误只修复一次，网络、限流或服务故障可切换备用模型。全部模型不可用时进入 `model_unavailable` 手工模式，不生成规则伪候选。

## 服务端校验

进入 CandidateService 前执行以下硬校验：

- Evidence 必须属于当前员工、当前 Context Job、当前工作日且未过期。
- `today` 必须引用今天的直接证据；`continuation` 清空历史结果。
- 本人 action/result 必须有本人证据 Claim；他人证据不能单独支撑本人成果。
- `completed` 必须有今天、本人、明确且非计划性的结果证据；日程、计划、建议和待办创建不能升级为完成。
- partial 来源限制置信度、禁止保持 completed，并加入缺失状态提示。
- 项目、人员、数字、结果和 Claims 必须在引用证据中有依据；无依据内容被删除、降级或拒绝。
- 聊天原文高相似复制、Markdown、链接、媒体 ID 和下载码不能进入候选正文。

候选项目匹配只使用 WorkEvent 的标题、工作对象、结果、项目信号和参与人。事件的 `sourceCompleteness`、`confidence`、`missingFacts` 会持久化到会话项并进入 Harness V2 权威投影；正式日报仍只保存员工确认后的结构化事项，不保存 Reference、聊天正文或模型输入。

## 存储与迁移

- Context DB v6：扩展来源完整性账本。
- Context DB v7：新增 `assistant_event_runs`、`assistant_events`、`assistant_event_claims`。
- Platform DB v10：会话项新增 `source_completeness`、`candidate_confidence`、`missing_facts_json`。
- Evidence、WorkEvent 和 Claim 使用应用层加密并沿用 Context Job TTL；按用户、Job 和工作日读取。
- 结构化日志只记录 Provider、模型快照、Prompt 版本、Token、耗时、结束原因、重试和错误码，不记录请求或响应正文。

## 配置与验证

配置示例见 `.env.example`。普通验证不调用真实模型：

```bash
npm run typecheck
npm test
```

真实模型集成测试只有显式设置以下开关才会执行，否则自动跳过：

```bash
DAILY_ASSISTANT_REAL_MODEL_TEST=1 node --import tsx --test tests/assistant-events-real.integration.test.ts
```

运行真实测试前还需提供批准的 `LLM_BASE_URL`、`LLM_API_KEY` 和 `DAILY_ASSISTANT_EVENT_PRIMARY_MODEL` 固定快照。不要把密钥写入代码、测试、提交或日志。
