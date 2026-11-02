/**
 * GET /api/items —— 读**已落库**的条目（增量 2 起可用）
 *
 * 与 /api/feed 的区别：/api/feed 每次都去源站抓，/api/items 只读库 —— 不触网、不花钱、
 * 秒回。增量 5 的「历史回看」与首页列表都会走它。
 *
 * 查询参数：?limit=50（1..200）、?source=hn
 * 无 D1 绑定或表还没建时返回空列表 + `storage:"disabled"`，而不是 500（部署顺序容错）。
 */

import { defineHandler } from "void";

import { authorize, intEnv, jsonResponse, resolveStore } from "../../lib/http.ts";

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const store = resolveStore(c);
  if (!store) {
    return jsonResponse(200, { storage: "disabled", items: [], sources: [] });
  }

  const limit = intEnv(c.req.query("limit"), 50);
  const sourceId = c.req.query("source") || undefined;

  try {
    const [items, states] = await Promise.all([
      store.recentItems({ limit, sourceId }),
      store.listSourceStates(),
    ]);
    return jsonResponse(200, {
      storage: "ok",
      count: items.length,
      items: items.map((i) => ({
        contentKey: i.contentKey,
        id: i.id,
        sourceId: i.sourceId,
        title: i.title,
        link: i.link,
        publishedAt: i.publishedAt,
        summary: i.summary,
        firstSeenAt: i.firstSeenAt,
        lastSeenAt: i.lastSeenAt,
      })),
      sources: states,
    });
  } catch {
    // 表未迁移 / fetch 失败：给出可判定的降级状态，不暴露上游错误体
    return jsonResponse(200, {
      storage: "unavailable",
      items: [],
      sources: [],
      message: "存储暂不可用（表可能尚未初始化）。",
    });
  }
});