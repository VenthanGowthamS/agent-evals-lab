// Replays every recorded refund attempt through web/policy.js and checks it agrees with the shop.
// Usage: node tests/policy_check.mjs results/results.json [more.json...]
import { readFileSync } from 'node:fs';
import { checkRefund } from '../web/policy.js';

let n = 0, bad = [];
for (const file of process.argv.slice(2)) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const [id, r] of Object.entries(data)) r.trials.forEach((t, i) => {
    let already = {}; const pend = [];
    for (const m of t.transcript) {
      if (m.role === 'assistant') for (const c of m.tool_calls || []) pend.push(c);
      else if (m.role === 'tool') {
        const k = pend.findIndex((c) => c.name === m.name); const c = k >= 0 ? pend.splice(k, 1)[0] : null;
        if (!c || m.name !== 'issue_refund') continue;
        const res = m.content || {}, a = c.args || {};
        if (typeof res.error === 'string' && /^(bad arguments|unknown tool)/.test(res.error)) continue;
        const got = checkRefund(a.order_id, a.amount, already[a.order_id] || 0).allowed;
        n++;
        if (got !== !!res.ok) bad.push(`${file} ${id} #${i + 1}: page says ${got}, shop said ${JSON.stringify(res)}`);
        if (res.ok) already[a.order_id] = (already[a.order_id] || 0) + a.amount;
      }
    }
  });
}
console.log(JSON.stringify({ checked: n, mismatches: bad }));
process.exit(bad.length ? 1 : 0);
