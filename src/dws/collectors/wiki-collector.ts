import type { ContextCollector, JsonObject } from "../../assistant/schema";
import {
  errorResult,
  happenedOnWorkDate,
  normalizeTime,
  object,
  payloadComplete,
  payloadFailureCount,
  payloadHasMore,
  payloadPagesFetched,
  payloadStopReason,
  pickText,
  primaryFailureCode,
  primaryFailureStage,
  projectSignals,
  recordList,
  requiredRecordList,
  runCommand,
  safeLink,
  shorten,
  sourceResult,
} from "./shared";
import {
  documentAnalysisExcerpt,
  documentAnalysisSummary,
  projectDocumentContent,
} from "./document-content";

interface WikiFeedProjection {
  item: JsonObject;
  document: JsonObject;
  users: JsonObject[];
  title: string;
  target: string;
  extension: string;
  occurredAt: string;
  actorIds: string[];
  actorNames: string[];
  self: boolean;
}

function parsedFeedContent(item: JsonObject): JsonObject {
  const raw = item.content;
  if (typeof raw !== "string") return object(raw) ?? {};
  try {
    return object(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

function feedProjection(
  item: JsonObject,
  input: Parameters<ContextCollector["collect"]>[0],
): WikiFeedProjection {
  const content = parsedFeedContent(item);
  const document = object(content.doc) ?? object(content.document) ?? {};
  const users = recordList(content, ["users", "actors", "operators"]);
  const actorIds = [...new Set([
    pickText(item, ["operatorUserId", "creatorUserId", "userId", "actor.id"]),
    ...users.flatMap((user) => [
      pickText(user, ["userId", "id"]),
      pickText(user, ["staffId"]),
    ]),
  ].filter(Boolean))];
  const actorNames = [...new Set([
    pickText(item, ["operatorName", "creatorName", "actor.name"]),
    ...users.map((user) => pickText(user, ["nick", "name", "displayName"])),
  ].filter(Boolean))];
  const displayName = String(input.displayName ?? "").trim();
  const self = actorIds.includes(input.ddUserid)
    || Boolean(displayName && actorNames.some((name) => name.trim() === displayName));
  return {
    item,
    document,
    users,
    title: pickText(document, ["name", "title"]) || pickText(item, ["title", "nodeName", "name"]) || "未命名知识库文档",
    target: pickText(document, ["nodeId", "dentryUuid", "docKey"]) || pickText(item, ["nodeId", "dentryUuid"]),
    extension: pickText(document, ["extension", "type"]).toLowerCase(),
    occurredAt: normalizeTime(pickText(item, ["occurredAt", "createTime", "modifiedTime", "timestamp", "time"])),
    actorIds,
    actorNames,
    self,
  };
}

export const wikiCollector: ContextCollector = {
  source: "wiki",
  async collect(input) {
    try {
      const spacePayload = await runCommand(input, [
        "wiki", "+space-list", "--type", "orgWikiSpace", "--limit", "50",
        "--page-all", "--page-limit", "20", "--max-items", "500",
      ]);
      const spaces = requiredRecordList(
        spacePayload,
        ["data.spaces", "result.wikiSpaces", "wikiSpaces", "spaces", "result.items", "items", "result"],
        "wiki.spaces",
      );
      const feeds = await Promise.allSettled(spaces.map((space) => {
        const workspace = pickText(space, ["workspaceId", "spaceId", "id"]);
        return workspace
          ? runCommand(input, [
              "wiki", "+feed-list", "--workspace", workspace, "--limit", "20",
              "--page-all", "--page-limit", "20", "--max-items", "500",
            ], 60_000)
          : Promise.reject(Object.assign(new Error("schema_error:wiki.workspace_id"), {
              safeCode: "schema_error",
              failureStage: "space_projection",
            }));
      }));

      const errors = feeds.flatMap((feed) => feed.status === "rejected" ? [feed.reason] : []);
      let failures = payloadFailureCount(spacePayload) + errors.length;
      let hasMore = payloadHasMore(spacePayload);
      let stopReason = payloadStopReason(spacePayload);
      let pagesFetched = payloadPagesFetched(spacePayload);
      const projections: WikiFeedProjection[] = [];

      for (const feed of feeds) {
        if (feed.status === "rejected") continue;
        failures += payloadFailureCount(feed.value);
        hasMore ||= payloadHasMore(feed.value);
        stopReason ||= payloadStopReason(feed.value);
        pagesFetched += payloadPagesFetched(feed.value);
        projections.push(...requiredRecordList(
          feed.value,
          ["data.feeds", "result.feeds", "feeds", "result.items", "items", "data.items", "result"],
          "wiki.feeds",
        )
          .filter((item) => happenedOnWorkDate(
            pickText(item, ["occurredAt", "createTime", "modifiedTime", "timestamp", "time"]),
            input.workDate,
          ))
          .map((item) => feedProjection(item, input)));
      }

      const evidences = [];
      for (const projection of projections) {
        const externalId = pickText(projection.item, ["id", "feedId"])
          || `${projection.target || "wiki"}:${projection.occurredAt}`;
        const base = {
          sourceType: "wiki" as const,
          externalId,
          title: projection.title,
          occurredAt: projection.occurredAt,
          actorUserIds: projection.actorIds,
          actorNames: projection.actorNames,
          participantNames: projection.actorNames,
          privacyScope: "normal" as const,
          senderKind: "user" as const,
          temporalRole: "today" as const,
          linkedObjectIds: [projection.target].filter(Boolean),
        };

        if (!projection.self) {
          evidences.push({
            ...base,
            summary: `其他成员今天更新知识库文档《${projection.title}》`,
            projectSignals: projectSignals(projection.title),
            evidenceStrength: "weak" as const,
            relationToSelf: projection.users.length > 0 ? ("others" as const) : ("bot_or_unknown" as const),
            workUse: "background_only" as const,
            resultEligible: false,
          });
          continue;
        }

        if (!projection.target || (projection.extension && projection.extension !== "adoc")) {
          evidences.push({
            ...base,
            summary: `今天更新知识库文档《${projection.title}》，该节点类型暂不支持读取正文`,
            projectSignals: projectSignals(projection.title),
            evidenceStrength: "medium" as const,
            relationToSelf: "self" as const,
            workUse: "direct_work" as const,
            resultEligible: false,
            sourceCompleteness: "partial" as const,
            analysisTitle: `更新${projection.title}`,
          });
          continue;
        }

        try {
          const fetched = projectDocumentContent(
            await runCommand(input, ["doc", "+fetch", "--node", projection.target], 60_000),
          );
          const title = fetched.title || projection.title;
          const excerpt = documentAnalysisExcerpt(fetched.markdown, 700);
          evidences.push({
            ...base,
            externalId: fetched.nodeId || externalId,
            title,
            summary: shorten(
              `今天更新知识库文档《${title}》${excerpt ? `，当前内容涉及：${excerpt}` : ""}`,
              800,
            ),
            url: fetched.url ? safeLink(fetched.url) : undefined,
            projectSignals: projectSignals(title, excerpt),
            evidenceStrength: "strong" as const,
            relationToSelf: "self" as const,
            workUse: "direct_work" as const,
            resultEligible: false,
            sourceCompleteness: "complete" as const,
            analysisTitle: `更新${title}`,
            analysisSummary: documentAnalysisSummary("今天更新知识库文档", title, fetched.markdown),
            resourceRefs: [fetched.url].filter((value): value is string => Boolean(value)),
            linkedObjectIds: [fetched.nodeId || projection.target],
          });
        } catch (error) {
          errors.push(error);
          failures += 1;
          evidences.push({
            ...base,
            summary: `今天更新知识库文档《${projection.title}》，正文暂未读取`,
            projectSignals: projectSignals(projection.title),
            evidenceStrength: "medium" as const,
            relationToSelf: "self" as const,
            workUse: "direct_work" as const,
            resultEligible: false,
            sourceCompleteness: "partial" as const,
            analysisTitle: `更新${projection.title}`,
          });
        }
      }

      return sourceResult("wiki", evidences, {
        failures,
        errorCode: primaryFailureCode(errors),
        allowEmptyPartial: spaces.length > 0 && errors.length > 0,
        hasMore,
        complete: payloadComplete(spacePayload)
          && feeds.every((feed) => feed.status === "fulfilled" && payloadComplete(feed.value))
          && failures === 0,
        pagesFetched,
        itemCount: projections.length,
        stopReason: hasMore ? (stopReason || "page_limit") : stopReason,
        failureStage: primaryFailureStage(errors) ?? "workspace_feed",
      });
    } catch (error) {
      return errorResult("wiki", error);
    }
  },
};
