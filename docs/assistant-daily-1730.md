# 日报助手每日自动分析

- 每天北京时间 17:30 开始自动采集、分析并保存待员工确认的工作事项，包含周末和节假日。每分钟检查一次，到点后的首次检查触发。
- 日报日期为统计窗口结束日。比如 9 月 8 日的日报采集 9 月 7 日 17:30（含）至 9 月 8 日 17:30（不含）的内容。
- 聊天、文档编辑、知识库动态、日历、听记、待办、审批与 DING 的时间筛选以及模型证据校验使用统一窗口。历史日志仍只作背景或待确认延续。
- 覆盖平台已开放个人日志功能的内部钉钉员工。已提交、全天请假或 DWS 授权无效的账号按现有规则跳过。提醒名单和发送开关沿用原设置。
- 自动分析会刷新截止前的采集缓存。分析完成后保存候选与会话；正式日报仍由员工确认提交。
- 同一日期已成功处理的账号不重复处理。单人异常不阻塞其他人，未完成任务在后续轮询重试；服务启动时若已超过 17:30，补做当天尚未完成的任务。

生产配置：

```dotenv
DAILY_ASSISTANT_PREWARM_ENABLED=1
DAILY_ASSISTANT_PREWARM_HOUR=17
DAILY_ASSISTANT_PREWARM_MINUTE=30
```

启动日志 `assistant_automation_started` 包含时区、触发时间和窗口说明。完成记录在 `assistant_schedule_runs`，事件为 `assistant_scheduled_analysis_complete`；异常为 `assistant_scheduled_analysis_failed`。
