// Generate src/providers/costs.rs from Pi's packages/ai/src/providers/*.models.ts
// Usage: node scripts/gen_costs.js <path-to-pi-upstream>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const upstream = process.argv[2];
if (!upstream) {
  console.error("Usage: node scripts/gen_costs.js <path-to-pi-upstream>");
  process.exit(1);
}
const dir = path.join(upstream, "packages/ai/src/providers");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".models.ts"));
const rows = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  let cur = {};
  let inCost = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^id:\s*"([^"]+)",?$/))) cur.id = m[1];
    else if ((m = line.match(/^provider:\s*"([^"]+)",?$/))) cur.provider = m[1];
    else if (line.startsWith("cost:")) { inCost = true; cur.cost = {}; }
    else if (inCost) {
      if ((m = line.match(/^input:\s*([0-9.]+),?$/))) cur.cost.input = parseFloat(m[1]);
      else if ((m = line.match(/^output:\s*([0-9.]+),?$/))) cur.cost.output = parseFloat(m[1]);
      else if ((m = line.match(/^cacheRead:\s*([0-9.]+),?$/))) cur.cost.cacheRead = parseFloat(m[1]);
      else if ((m = line.match(/^cacheWrite:\s*([0-9.]+),?$/))) cur.cost.cacheWrite = parseFloat(m[1]);
      else if (line.startsWith("}")) inCost = false;
    }
    if (line.includes("satisfies Model")) {
      if (cur.provider && cur.id && cur.cost && cur.cost.input != null) {
        rows.push({ provider: cur.provider, id: cur.id, c: cur.cost });
      }
      cur = {};
      inCost = false;
    }
  }
}
const seen = new Set();
const uniq = [];
for (const r of rows) {
  const k = r.provider + " " + r.id;
  if (!seen.has(k)) { seen.add(k); uniq.push(r); }
}
uniq.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.id < b.id ? -1 : 1));
const fmt = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
let out = "";
out += "// Generated from Pi packages/ai/src/providers/*.models.ts cost data.\n";
out += "// Per-million-token USD pricing. Regenerate with scripts/gen_costs.js.\n\n";
out += "use super::types::ModelCost;\n\n";
out += "pub fn builtin_cost(provider: &str, id: &str) -> Option<ModelCost> {\n";
out += "    let (input, output, cache_read, cache_write) = match (provider, id) {\n";
for (const r of uniq) {
  const i = r.c.input ?? 0, o = r.c.output ?? 0, cr = r.c.cacheRead ?? 0, cw = r.c.cacheWrite ?? 0;
  out += `        (${JSON.stringify(r.provider)}, ${JSON.stringify(r.id)}) => (${fmt(i)}, ${fmt(o)}, ${fmt(cr)}, ${fmt(cw)}),\n`;
}
out += "        _ => return None,\n";
out += "    };\n";
out += "    Some(ModelCost { input, output, cache_read, cache_write })\n";
out += "}\n";
fs.writeFileSync(path.join(__dirname, "../src/providers/costs.rs"), out);
console.log("models with cost:", uniq.length);
