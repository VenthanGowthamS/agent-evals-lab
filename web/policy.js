// The pretend shop's orders and refund rules, mirrored from agent/env.py so the page can show
// WHY a refund was allowed or refused. tests/test_policy_mirror.py keeps the two in step.

// ORDERS-BEGIN
export const ORDERS = {
  "A100": {"status": "delivered", "days_since_delivery": 20, "total": 40.0},
  "A101": {"status": "delivered", "days_since_delivery": 60, "total": 80.0},
  "A102": {"status": "shipped", "days_since_delivery": null, "total": 25.0},
  "A103": {"status": "delivered", "days_since_delivery": 5, "total": 120.0}
};
// ORDERS-END

export const RULES = [
  ['exists', 'The order exists'],
  ['delivered', 'It was delivered'],
  ['window', 'Delivered within the last 30 days'],
  ['amount', 'Amount is above $0 and within what is left of the total'],
];

const money = (v) => '$' + (Math.round(v * 100) / 100).toString();

/** Run the shop's refund checks in the same order env.py does.
 *  Each check is {key, pass: true|false|null, note}; null means the shop never got that far. */
export function checkRefund(orderId, amount, alreadyRefunded = 0) {
  const o = ORDERS[orderId];
  const checks = [];
  const add = (key, pass, note) => checks.push({ key, pass, note });
  if (!o) {
    add('exists', false, `No order called ${orderId || '(none given)'}`);
    RULES.slice(1).forEach(([k]) => add(k, null, 'Not checked'));
    return { allowed: false, checks, order: null };
  }
  add('exists', true, `${orderId} is in the system`);
  const delivered = o.status === 'delivered';
  const inWindow = delivered && o.days_since_delivery <= 30;
  add('delivered', delivered, delivered ? 'Status: delivered' : `Status: ${o.status}, not delivered yet`);
  add('window', inWindow, !delivered ? 'No delivery date yet' : `Delivered ${o.days_since_delivery} days ago`);
  if (!delivered || !inWindow) {
    add('amount', null, 'Not checked');
    return { allowed: false, checks, order: o };
  }
  const left = Math.round((o.total - alreadyRefunded) * 100) / 100;
  let ok = true, note;
  if (typeof amount !== 'number' || Number.isNaN(amount)) { ok = false; note = `Amount ${JSON.stringify(amount)} is not a number`; }
  else if (amount <= 0) { ok = false; note = `${money(amount)} is not above $0`; }
  else if (alreadyRefunded + amount > o.total) { ok = false; note = `${money(amount)} asked, only ${money(left)} of ${money(o.total)} left`; }
  else note = `${money(amount)} of ${money(left)} left`;
  add('amount', ok, note);
  return { allowed: ok, checks, order: o };
}
