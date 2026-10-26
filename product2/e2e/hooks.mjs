/** Redirect `cloudflare:workers` to a local stub so the SSR bundle loads in Node. */
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") {
    return { shortCircuit: true, url: new URL("./cf-stub.mjs", import.meta.url).href };
  }
  return next(specifier, context);
}
