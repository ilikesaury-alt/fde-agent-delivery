import { readFileSync, writeFileSync } from 'fs';
const p = new URL('../docs/作品集-总览.md', import.meta.url);
const s = readFileSync(p, 'utf8');
writeFileSync(p, s + '\n[test](../product1/docs/does-not-exist.md)\n\n见 `product1/docs/also-missing.md`\n');
console.log('injected');
