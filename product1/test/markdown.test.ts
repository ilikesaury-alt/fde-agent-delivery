/**
 * Markdown 渲染器单元测试 — 重点验证不会死循环
 * 用真实日报输出作为输入
 */

import assert from "node:assert/strict";

import { parseMarkdown } from "../components/markdown-parse.ts";

type Case = { name: string; fn: () => void | Promise<void> };

const REAL_DIGEST = `## 会议主题
项目复盘会，围绕 v2.0 延期与支付流程 P0 bug 修复展开。

## 时间与参会人
- 时间：2026年10月22日
- 参会人：陈明（PM）、刘芳（设计）、周杰（开发）

## 核心结论
- v2.0 延期到11月中旬。
- 优先修复支付流程的3个P0 bug。
- 设计稿本周五前定稿。

## 待办事项
| 事项 | 负责人 | 截止 |
| --- | --- | --- |
| 修复支付bug | 周杰 | 10月25日 |
| 出定稿 | 刘芳 | 10月24日 |

## 遗留问题与风险
测试资源不足，可能影响回归覆盖。

## 一句话摘要
会议确定 v2.0 延期至11月中旬。`;

export const cases: Case[] = [
  {
    name: "真实日报：能解析且包含 6 个 h2",
    fn: () => {
      const blocks = parseMarkdown(REAL_DIGEST);
      const h2 = blocks.filter((b) => b.kind === "h2");
      assert.equal(h2.length, 6, `期望 6 个 h2，实际 ${h2.length}`);
    },
  },
  {
    name: "真实日报：表格被正确识别（2 行数据）",
    fn: () => {
      const blocks = parseMarkdown(REAL_DIGEST);
      const table = blocks.find((b) => b.kind === "table");
      assert.ok(table, "应识别出表格");
      if (table && table.kind === "table") {
        assert.equal(table.head.length, 3);
        assert.equal(table.rows.length, 2);
      }
    },
  },
  {
    name: "真实日报：无序列表被识别",
    fn: () => {
      const blocks = parseMarkdown(REAL_DIGEST);
      const ul = blocks.filter((b) => b.kind === "ul");
      assert.ok(ul.length >= 2, `期望至少 2 个列表，实际 ${ul.length}`);
    },
  },
  {
    name: "空字符串：返回空数组，不抛错",
    fn: () => {
      assert.deepEqual(parseMarkdown(""), []);
    },
  },
  {
    name: "只有空行：返回空数组",
    fn: () => {
      assert.deepEqual(parseMarkdown("\n\n\n   \n"), []);
    },
  },
  {
    name: "单个表格（无其他内容）不死循环",
    fn: () => {
      const blocks = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].kind, "table");
    },
  },
  {
    name: "表格后紧跟正文不死循环",
    fn: () => {
      const blocks = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后续段落");
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0].kind, "table");
      assert.equal(blocks[1].kind, "p");
    },
  },
  {
    name: "含 | 但不是表格的行：按段落处理",
    fn: () => {
      const blocks = parseMarkdown("这是一行 含竖线 a|b 的文字");
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].kind, "p");
    },
  },
  {
    name: "列表后紧跟表格不死循环",
    fn: () => {
      const blocks = parseMarkdown("- item1\n- item2\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0].kind, "ul");
      assert.equal(blocks[1].kind, "table");
    },
  },
  {
    name: "超长输入（5000 行）能在合理时间内完成",
    fn: () => {
      const big = Array.from({ length: 5000 }, (_, i) => `## 标题${i}\n内容${i}`).join("\n");
      const t0 = Date.now();
      const blocks = parseMarkdown(big);
      const ms = Date.now() - t0;
      assert.ok(blocks.length > 0, "应产出 blocks");
      assert.ok(ms < 5000, `解析 5000 行耗时 ${ms}ms，超过 5s 上限`);
    },
  },
  {
    name: "未闭合的加粗不崩溃",
    fn: () => {
      const blocks = parseMarkdown("**未闭合的加粗");
      assert.equal(blocks.length, 1);
    },
  },
  {
    name: "连续表格分隔行不死循环",
    fn: () => {
      const blocks = parseMarkdown("| --- |\n| --- |\n| --- |");
      assert.ok(Array.isArray(blocks));
    },
  },
];
