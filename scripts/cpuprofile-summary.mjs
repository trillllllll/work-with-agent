// Summarise a Chrome .cpuprofile: self and inclusive time per function, so editing hot spots can be attributed.
// Usage: node scripts/cpuprofile-summary.mjs <file.cpuprofile> [top=25]
import { readFileSync } from 'node:fs';

const [file, topArg] = process.argv.slice(2);
if (!file) { console.error('usage: node scripts/cpuprofile-summary.mjs <file.cpuprofile> [top]'); process.exit(1); }
const top = Number(topArg ?? 25);
const profile = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const self = new Map(); const inclusive = new Map();
const label = (node) => {
  const frame = node.callFrame;
  const url = frame.url ? frame.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '') : '';
  return `${frame.functionName || '(anonymous)'} ${url}${url ? `:${frame.lineNumber + 1}` : ''}`;
};
let total = 0;
profile.samples.forEach((id, index) => {
  const delta = (profile.timeDeltas[index + 1] ?? 0) / 1000;
  total += delta;
  const node = nodes.get(id);
  const name = label(node);
  self.set(name, (self.get(name) ?? 0) + delta);
  const seen = new Set();
  for (let cursor = id; cursor !== undefined; cursor = parent.get(cursor)) {
    const entry = label(nodes.get(cursor));
    if (seen.has(entry)) continue; seen.add(entry);
    inclusive.set(entry, (inclusive.get(entry) ?? 0) + delta);
  }
});
const idle = ['(idle) ', '(program) ', '(garbage collector) '].reduce((sum, name) => sum + (self.get(name) ?? 0), 0);
console.log(`profile ${(total).toFixed(0)} ms, busy ${(total - idle).toFixed(0)} ms, gc ${(self.get('(garbage collector) ') ?? 0).toFixed(0)} ms`);
const print = (title, map) => {
  console.log(`\n${title}`);
  for (const [name, ms] of [...map].filter(([name]) => !/^\((idle|program|root)\) /.test(name)).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${ms.toFixed(1).padStart(8)} ms  ${name}`);
};
print('self time', self);
print('inclusive time', inclusive);
