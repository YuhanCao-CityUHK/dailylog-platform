import type { ContextCollector, JsonObject } from "../../assistant/schema";
import {
  errorResult,
  happenedOnWorkDate,
  normalizeTime,
  payloadComplete,
  payloadFailureCount,
  payloadHasMore,
  payloadPagesFetched,
  payloadStopReason,
  pickText,
  primaryFailureCode,
  primaryFailureStage,
  projectSignals,
  requiredRecordList,
  runCommand,
  runPaginatedCommand,
  safeLink,
  shorten,
  sourceResult,
} from "./shared";
import {
  documentAnalysisExcerpt,
  documentAnalysisSummary,
  projectDocumentContent,
} from "./document-content";

function documentTarget(document: JsonObject): string {
  const canonical = pickText(document, [
    "nodeId",
    "dentryUuid",
    "documentId",
    "docId",
    "url",
    "docUrl",
    "dingTalkUrl",
    "dingtalkOpenUrl",
  ]);
  return canonical && !/^\d+$/.test(canonical) ? canonical : "";
}

function supportedDocument(document: JsonObject): boolean {
  const type = pickText(document, ["docType", "extension", "type"]).toLowerCase();
  return !type || type === "adoc";
}

function selfEdit(version: JsonObject, input: Parameters<ContextCollector["collect"]>[0]): boolean {
  const editor = pickText(version, ["userId", "editorUserId", "operatorUserId", "creatorUserId"]);
  const occurredAt = pickText(version, ["updateTime", "modifiedTime", "createTime", "createdAt"]);
  return editor === input.ddUserid && happenedOnWorkDate(occurredAt, input.workDate);
}

export const documentCollector: ContextCollector = {
  source: "document",
  async collect(input) {
    try {
      const list = await runCommand(input, [
        "doc", "+search", "--page-all", "--limit", "20", "--max-pages", "2", "--max-items", "40",
      ], 30_000);
      const documents = requiredRecordList(
        list,
        ["documents", "result.items", "items", "data.items", "result"],
        "doc.documents",
      ).filter(supportedDocument);

      const evidences = [];
      const errors: unknown[] = [];
      let failures = payloadFailureCount(list);
      let detailPages = 0;
      let validTargets = 0;

      // DWS Doc history endpoints become unstable under parallel fan-out. There
      // are normally only a few adoc candidates, so keep these reads sequential.
      for (const document of documents) {
        const target = documentTarget(document);
        if (!target) {
          const error = Object.assign(new Error("schema: document nodeId or URL missing"), {
            safeCode: "schema_error",
            failureStage: "target_selection",
          });
          errors.push(error);
          failures += 1;
          continue;
        }
        validTargets += 1;

        let versions: JsonObject[] = [];
        let historyComplete = false;
        try {
          const history = await runPaginatedCommand(input, (pageIndex, previous) => {
            const cursor = pageIndex === 0
              ? ""
              : pickText(previous, ["nextCursor", "result.nextCursor", "data.nextCursor"]);
            if (pageIndex > 0 && !cursor) return null;
            return [
              "doc", "+version-list", "--node", target, "--limit", "50",
              ...(cursor ? ["--cursor", cursor] : []),
            ];
          }, { maxPages: 2, timeoutMs: 30_000 });
          detailPages += history.pagesFetched;
          failures += history.failures;
          if (history.error) errors.push(history.error);
          versions = history.pages.flatMap((page) => requiredRecordList(
            page,
            ["versions", "result.versions", "result.items", "items", "result"],
            "doc.versions",
          ));
          historyComplete = history.complete;
        } catch (error) {
          errors.push(error);
          failures += 1;
          continue;
        }

        const ownVersions = versions.filter((version) => selfEdit(version, input));
        if (ownVersions.length === 0) continue;
        const occurredAt = normalizeTime(pickText(ownVersions[0], [
          "updateTime", "modifiedTime", "createTime", "createdAt",
        ]));
        const fallbackTitle = pickText(document, ["name", "title"]) || "未命名文档";

        try {
          const fetched = projectDocumentContent(
            await runCommand(input, ["doc", "+fetch", "--node", target], 60_000),
          );
          const title = fetched.title || fallbackTitle;
          const excerpt = documentAnalysisExcerpt(fetched.markdown, 700);
          evidences.push({
            sourceType: "document" as const,
            externalId: fetched.nodeId || target,
            title,
            summary: shorten(
              `今天编辑文档《${title}》${excerpt ? `，当前内容涉及：${excerpt}` : ""}`,
              800,
            ),
            occurredAt,
            actorUserIds: [input.ddUserid],
            actorNames: input.displayName ? [input.displayName] : [],
            participantNames: [],
            url: safeLink(fetched.url ?? pickText(document, ["url", "docUrl", "dingTalkUrl"])),
            privacyScope: "normal" as const,
            projectSignals: projectSignals(title, excerpt),
            evidenceStrength: "strong" as const,
            relationToSelf: "self" as const,
            senderKind: "user" as const,
            sourceCompleteness: historyComplete && payloadComplete(list) ? ("complete" as const) : ("partial" as const),
            temporalRole: "today" as const,
            workUse: "direct_work" as const,
            analysisTitle: `编辑${title}`,
            analysisSummary: documentAnalysisSummary("今天编辑文档", title, fetched.markdown),
            resultEligible: false,
            resourceRefs: [fetched.url].filter((value): value is string => Boolean(value)),
            linkedObjectIds: [fetched.nodeId || target],
          });
        } catch (error) {
          errors.push(error);
          failures += 1;
          evidences.push({
            sourceType: "document" as const,
            externalId: target,
            title: fallbackTitle,
            summary: `今天编辑文档《${fallbackTitle}》，正文暂未读取`,
            occurredAt,
            actorUserIds: [input.ddUserid],
            actorNames: input.displayName ? [input.displayName] : [],
            participantNames: [],
            url: safeLink(pickText(document, ["url", "docUrl", "dingTalkUrl"])),
            privacyScope: "normal" as const,
            projectSignals: projectSignals(fallbackTitle),
            evidenceStrength: "medium" as const,
            relationToSelf: "self" as const,
            senderKind: "user" as const,
            sourceCompleteness: "partial" as const,
            temporalRole: "today" as const,
            workUse: "direct_work" as const,
            analysisTitle: `编辑${fallbackTitle}`,
            analysisSummary: "",
            resultEligible: false,
            linkedObjectIds: [target],
          });
        }
      }

      const hasMore = payloadHasMore(list);
      const complete = payloadComplete(list) && failures === 0;
      return sourceResult("document", evidences, {
        failures,
        errorCode: primaryFailureCode(errors),
        allowEmptyPartial: validTargets > 0 && errors.length > 0,
        hasMore,
        complete,
        pagesFetched: payloadPagesFetched(list) + detailPages,
        itemCount: documents.length,
        stopReason: payloadStopReason(list) ?? (hasMore ? "document_search_limit" : undefined),
        failureStage: primaryFailureStage(errors) ?? "document_read",
      });
    } catch (error) {
      return errorResult("document", error);
    }
  },
};
