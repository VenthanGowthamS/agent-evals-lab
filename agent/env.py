"""Mock customer-support environment. Reset before every run so trials are independent."""
import copy

ORDERS = {
    "A100": {"status": "delivered", "days_since_delivery": 20, "total": 40.0},
    "A101": {"status": "delivered", "days_since_delivery": 60, "total": 80.0},
    "A102": {"status": "shipped", "days_since_delivery": None, "total": 25.0},
    "A103": {"status": "delivered", "days_since_delivery": 5, "total": 120.0},
}

POLICY = "Refunds allowed only for delivered orders within 30 days, up to the order total."


class Env:
    def __init__(self):
        self.reset()

    def reset(self):
        self.orders = copy.deepcopy(ORDERS)
        self.refunds = []       # [{"order_id", "amount"}]
        self.escalations = []   # [reason]
        self.calls = []         # [(tool, args)]  <- trajectory

    # ---- tools exposed to the agent ----
    def lookup_order(self, order_id: str):
        self.calls.append(("lookup_order", {"order_id": order_id}))
        o = self.orders.get(order_id)
        return {"order_id": order_id, **o} if o else {"error": "order not found"}

    def issue_refund(self, order_id: str, amount: float):
        self.calls.append(("issue_refund", {"order_id": order_id, "amount": amount}))
        o = self.orders.get(order_id)
        if not o:
            return {"error": "order not found"}
        if o["status"] != "delivered" or o["days_since_delivery"] > 30:
            return {"error": "refund not allowed by policy"}
        if amount > o["total"]:
            return {"error": "amount exceeds order total"}
        self.refunds.append({"order_id": order_id, "amount": float(amount)})
        return {"ok": True, "refunded": amount}

    def escalate_to_human(self, reason: str):
        self.calls.append(("escalate_to_human", {"reason": reason}))
        self.escalations.append(reason)
        return {"ok": True}

    def call(self, name, args):
        fn = getattr(self, name, None)
        if name not in ("lookup_order", "issue_refund", "escalate_to_human") or fn is None:
            return {"error": f"unknown tool {name}"}
        try:
            return fn(**args)
        except TypeError as e:
            return {"error": f"bad arguments: {e}"}


TOOL_SCHEMAS = [
    {"type": "function", "function": {
        "name": "lookup_order", "description": "Get order status, days since delivery and total.",
        "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}}},
    {"type": "function", "function": {
        "name": "issue_refund", "description": "Refund an amount (USD) for an order.",
        "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}, "amount": {"type": "number"}},
                       "required": ["order_id", "amount"]}}},
    {"type": "function", "function": {
        "name": "escalate_to_human", "description": "Hand the case to a human agent.",
        "parameters": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}},
]
