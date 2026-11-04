// Landing proof: runs the real engine on the bundled synthetic sample. Shows an honest failure if anything errors.
import { ReviewSession } from './state.js';

const out = document.getElementById('proof');
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; };

async function run() {
  try {
    const s = new ReviewSession();
    const res = await s.loadBundledSample('json');
    if (res.status !== 'accepted') throw new Error(`sample rejected: ${res.errors?.[0]?.message ?? res.message}`);
    const fwd = s.forward('A');
    const r = fwd.result;
    const receipt = s.snapshot().receipts.find((x) => x.lotId === r.affectedInputLot);
    if (receipt) document.getElementById('lot-tag').textContent = `LOT · ${receipt.lotId} · ${receipt.quantity.toLocaleString('en-US')} ${receipt.unit}`;
    out.replaceChildren();
    out.append(el('p', `${fwd.snapshotLabel} — computed in your browser just now.`, 'proof-label'));
    const big = el('p', '', 'proof-figure');
    big.append(el('span', r.affectedShippedQuantity.toLocaleString('en-US'), 'num'), el('span', ` ${r.unit} affected shipped from input lot ${r.affectedInputLot}`, 'unit'));
    out.append(big);
    const ul = el('ul', undefined, 'proof-customers');
    for (const c of r.customers) ul.append(el('li', `${c.customerId} · ${c.name} · ${c.affectedReceived.toLocaleString('en-US')} ${c.unit}`));
    out.append(ul);
    const others = s.unreachedCustomers(fwd).map((c) => c.id);
    out.append(el('p', `Not reached by this trace: ${others.join(', ') || 'none'} — outside this trace, NOT certified safe.`, 'proof-note'));
  } catch (e) {
    out.replaceChildren(el('p', `Engine proof unavailable: ${e.message}. No figures are shown rather than fabricated ones.`, 'error'));
  }
}
run();
