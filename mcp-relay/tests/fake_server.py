"""A small but honest stdio MCP server for relay tests.

Every start appends its PID to $FAKE_LOG/starts.txt so tests can count real launches.
Tools: echo, image, counter (stateful), slow (progress + sleep), crash, child
(spawns a sleeping grandchild and returns its PID), ask (elicitation round trip).
$FAKE_TOOLS=extra adds a tool so catalog drift can be tested.
"""
import base64
import json
import os
import subprocess
import sys
import threading
import time

LOG = os.environ.get("FAKE_LOG")
if LOG:
    os.makedirs(LOG, exist_ok=True)
    with open(os.path.join(LOG, "starts.txt"), "a", encoding="utf-8") as f:
        f.write(f"{os.getpid()}\n")

PNG = base64.b64encode(bytes(range(256)) * 64).decode()
TOOLS = [
    {"name": "echo", "description": "echo text", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "image", "description": "an image", "inputSchema": {"type": "object"}},
    {"name": "counter", "description": "stateful counter", "inputSchema": {"type": "object"}},
    {"name": "slow", "description": "sleep with progress", "inputSchema": {"type": "object", "properties": {"sec": {"type": "number"}}}},
    {"name": "crash", "description": "exit now", "inputSchema": {"type": "object"}},
    {"name": "child", "description": "spawn a grandchild", "inputSchema": {"type": "object"}},
    {"name": "ask", "description": "elicitation", "inputSchema": {"type": "object"}},
]
if os.environ.get("FAKE_TOOLS") == "extra":
    TOOLS.append({"name": "extra", "description": "drift", "inputSchema": {"type": "object"}})

out_lock = threading.Lock()
count = [0]
waiting = {}


def send(obj):
    with out_lock:
        sys.stdout.buffer.write(json.dumps(obj).encode() + b"\n")
        sys.stdout.buffer.flush()


def text(t):
    return {"content": [{"type": "text", "text": t}]}


def call(mid, name, args, meta):
    if name == "echo":
        send({"jsonrpc": "2.0", "id": mid, "result": text(args.get("text", ""))})
    elif name == "image":
        send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "image", "data": PNG, "mimeType": "image/png"}]}})
    elif name == "counter":
        count[0] += 1
        send({"jsonrpc": "2.0", "id": mid, "result": text(str(count[0]))})
    elif name == "slow":
        token = (meta or {}).get("progressToken")
        sec = float(args.get("sec", 1))
        for i in range(3):
            if token is not None:
                send({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progressToken": token, "progress": i, "total": 3}})
            time.sleep(sec / 3)
        send({"jsonrpc": "2.0", "id": mid, "result": text("slept")})
    elif name == "crash":
        os._exit(3)
    elif name == "child":
        c = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        send({"jsonrpc": "2.0", "id": mid, "result": text(str(c.pid))})
    elif name == "ask":
        rid = "srv-ask-1"
        waiting[rid] = mid
        send({"jsonrpc": "2.0", "id": rid, "method": "elicitation/create",
              "params": {"message": "name?", "requestedSchema": {"type": "object", "properties": {"n": {"type": "string"}}}}})
    else:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"unknown tool {name}"}})


for raw in sys.stdin.buffer:
    try:
        m = json.loads(raw)
    except ValueError:
        continue
    method = m.get("method")
    if method is None and "id" in m:  # reply from the client
        mid = waiting.pop(m["id"], None)
        if mid is not None:
            ans = ((m.get("result") or {}).get("content") or {}).get("n", "?")
            send({"jsonrpc": "2.0", "id": mid, "result": text("hello " + ans)})
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {
            "protocolVersion": min(m["params"].get("protocolVersion", "2025-06-18"), "2025-06-18"),
            "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"},
            "instructions": "fake server for relay tests"}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"tools": TOOLS}})
    elif method == "tools/call":
        p = m.get("params") or {}
        threading.Thread(target=call, args=(m["id"], p.get("name"), p.get("arguments") or {}, p.get("_meta")), daemon=True).start()
    elif method == "ping":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {}})
    elif "id" in m:
        send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "nope"}})
