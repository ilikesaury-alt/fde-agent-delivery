/**
 * /api/conversations —— 会话管理（二期多轮）
 *
 *   GET    /api/conversations            列表（倒序，最多 50，含轮数）
 *   GET    /api/conversations?id=<id>    会话详情（元信息 + 最近 500 轮消息，时间正序）
 *   DELETE /api/conversations?id=<id>    删除会话（连带全部消息）
 *
 * 没有 POST：会话由 `/api/ask` 首次提问时自动创建（标题取首问），
 * 前端「新会话」只是不发 conversationId —— 少一个接口、少一处可失败的状态。
 *
 * 状态码：401 令牌 · 400 缺参 · 404 会话不存在 · 500 存储异常
 */

import { defineHandler } from "void";

import { ERR } from "../../lib/errors.ts";
import { authorize, jsonResponse, resolveRepo } from "../../lib/http.ts";

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const id = new URL(c.req.url).searchParams.get("id");
  try {
    const repo = resolveRepo(c);
    if (!id) {
      const conversations = await repo.listConversations(50);
      return jsonResponse(200, { conversations });
    }

    const conversation = await repo.getConversation(id);
    if (!conversation) return jsonResponse(404, { error: ERR.conversationNotFound });

    // Repo 返回倒序（最新在前）；UI 按时间正序渲染对话，这里翻好再给。
    // 上限 500 轮：单会话正常用量到不了；不设上限会让一次详情把整会话搬进 Worker（cross-review 发现 #2）。
    const messages = (await repo.listMessages(id, 500)).slice().reverse();
    return jsonResponse(200, { conversation, messages });
  } catch (e) {
    console.warn(`[conversations] list failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(500, { error: id ? ERR.messageListFailed : ERR.convListFailed });
  }
});

export const DELETE = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const id = new URL(c.req.url).searchParams.get("id");
  if (!id) return jsonResponse(400, { error: ERR.missingField("id") });

  try {
    const repo = resolveRepo(c);
    const conversation = await repo.getConversation(id);
    if (!conversation) return jsonResponse(404, { error: ERR.conversationNotFound });

    const removedMessages = await repo.deleteConversation(id);
    return jsonResponse(200, { ok: true, removedMessages });
  } catch (e) {
    console.warn(`[conversations] delete failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(500, { error: ERR.convDeleteFailed });
  }
});