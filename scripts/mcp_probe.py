#!/usr/bin/env python
# mcp_probe.py — minimal MCP Streamable-HTTP client for probing paginate-pub.
# Usage: python mcp_probe.py <tool> '<json-arguments>'
# Forces SNI/Host to mcp.paginate.dev but connects to the CF edge IP (the
# sandbox resolver cannot resolve the AAAA-only custom domains).
import http.client, json, socket, ssl, sys

import os
MCP = os.environ.get('PAGINATE_MCP_TOKEN', '')
if not MCP:
    raise SystemExit('Set PAGINATE_MCP_TOKEN env var to the MCP bearer token')
IP = "104.21.2.132"
HOST = "mcp.paginate.dev"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

class FixedHTTPS(http.client.HTTPSConnection):
    def __init__(self, **kw):
        super().__init__(IP, 443, context=ctx, timeout=30)
    def connect(self):
        sock = socket.create_connection((IP, 443), timeout=30)
        self.sock = ctx.wrap_socket(sock, server_hostname=HOST)

def post(payload, session=None):
    body = json.dumps(payload).encode()
    conn = FixedHTTPS()
    headers = {
        "Host": HOST,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {MCP}",
    }
    if session:
        headers["mcp-session-id"] = session
    conn.request("POST", "/mcp", body=body, headers=headers)
    resp = conn.getresponse()
    data = resp.read().decode()
    sid = resp.getheader("mcp-session-id")
    conn.close()
    return resp.status, sid, data

def parse_sse(data):
    for line in data.splitlines():
        if line.startswith("data:"):
            try:
                return json.loads(line[5:].strip())
            except Exception:
                pass
    return None

def main():
    tool = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    st, sid, _ = post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "probe", "version": "0"}}})
    sid = sid or "stateless"
    post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    st, _, data = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
        "name": tool, "arguments": args}}, sid)
    msg = parse_sse(data)
    if not msg:
        print(f"HTTP {st} raw: {data[:400]}")
        return
    r = msg.get("result", {})
    if r.get("isError"):
        print("ERROR:", r["content"][0]["text"])
    else:
        print(r["content"][0]["text"])

main()
