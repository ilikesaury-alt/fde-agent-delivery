// 产品⑤ AI 资讯雷达 —— Cloudflare 侧配置（权威源）
// ⚠️ 不要手改 .void-wrangler.jsonc（void migrate/deploy 生成的产物，改了会被覆盖）
//
// 本增量（增量 1：骨架 + M0）**不涉及 D1**；
// D1 绑定与 migrations_dir 在增量 2（存储层）加入，届时需先 `npx wrangler d1 create`。
import { defineConfig } from "void/config";

export default defineConfig({
  worker: {
    compatibility_date: "2026-02-24",
  },
  cloudflare: {
    account_id: "e279d1f8bcb29c72945905179e57faeb",
    name: "ai-hot-radar",
    d1_databases: [
      {
        binding: "DB",
        database_name: "ai-hot-radar-db",
        database_id: "1e53e023-38f4-4afe-bc92-ade98e4b5a93",
        migrations_dir: "db/migrations",
      },
    ],
  },
  head: {
    titleTemplate: "%s",
    htmlAttrs: { lang: "zh-CN" },
    meta: [
      { charset: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      {
        name: "description",
        content:
          "定时聚合多源 AI 资讯 → 评分精选 → 每日日报。带源健康监测与评测集标定的筛选。",
      },
    ],
  },
});