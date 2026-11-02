/** 把 `cloudflare:workers` 重定向到本地 stub，让 SSR bundle 能在纯 Node 里加载 */
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") {
    return { shortCircuit: true, url: new URL("./cf-stub.mjs", import.meta.url).href };
  }
  return next(specifier, context);
}