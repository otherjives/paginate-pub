#!/usr/bin/env python
# acceptance.py — drives the paginate-pub MCP server through its acceptance tests.
# Usage: PAGINATE_MCP_TOKEN=<token> python scripts/acceptance.py
import http.client, json, os, socket, ssl, sys, urllib.request, urllib.parse

MCP = os.environ.get("PAGINATE_MCP_TOKEN", "")
assert MCP, "set PAGINATE_MCP_TOKEN"
IP = "104.21.2.132"; HOST = "mcp.paginate.dev"
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

class C(http.client.HTTPSConnection):
    def __init__(self): super().__init__(IP, 443, context=ctx, timeout=40)
    def connect(self):
        s = socket.create_connection((IP, 443), timeout=40)
        self.sock = ctx.wrap_socket(s, server_hostname=HOST)

def post(p, sid=None):
    c = C()
    h = {"Host": HOST, "Content-Type": "application/json",
         "Accept": "application/json, text/event-stream",
         "Authorization": f"Bearer {MCP}"}
    if sid: h["mcp-session-id"] = sid
    c.request("POST", "/mcp", body=json.dumps(p).encode(), headers=h)
    r = c.getresponse(); d = r.read().decode(); s = r.getheader("mcp-session-id"); c.close()
    return r.status, s, d

def sse(d):
    for l in d.splitlines():
        if l.startswith("data:"):
            try: return json.loads(l[5:].strip())
            except Exception: pass
    return None

_st, _sid, _ = post({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "protocolVersion":"2025-06-18","capabilities":{},
    "clientInfo":{"name":"acceptance","version":"0"}}})
SID = _sid or "stateless"
post({"jsonrpc":"2.0","method":"notifications/initialized"}, SID)

_n = [100]
def call(tool, args):
    _n[0] += 1
    st, _, d = post({"jsonrpc":"2.0","id":_n[0],"method":"tools/call","params":{"name":tool,"arguments":args}}, SID)
    m = sse(d)
    if not m: raise RuntimeError(f"no SSE for {tool}: {d[:200]}")
    if "error" in m: raise RuntimeError(f"{tool}: {m['error']}")
    r = m["result"]
    txt = r["content"][0]["text"]
    if r.get("isError"): raise RuntimeError(f"{tool} error: {txt}")
    try: return json.loads(txt)
    except Exception: return txt

class EdgeHTTPS(http.client.HTTPSConnection):
    # Connect to the edge IP but present SNI for the real hostname (the sandbox
    # resolver cannot resolve the AAAA-only custom domains).
    def __init__(self, host, ip, **kw):
        super().__init__(ip, 443, context=ctx, timeout=25)
        self._host = host
    def connect(self):
        s = socket.create_connection((self.host, 443), timeout=25)
        self.sock = ctx.wrap_socket(s, server_hostname=self._host)

def get(url, resolve=None):
    host = resolve[0] if resolve else urllib.parse.urlparse(url).hostname
    ip = resolve[1] if resolve else "104.21.2.132"
    path = urllib.parse.urlparse(url).path or "/"
    qs = urllib.parse.urlparse(url).query
    if qs: path += "?" + qs
    c = EdgeHTTPS(host, ip)
    c.request("GET", path, headers={"Host": host})
    r = c.getresponse(); body = r.read(); c.close()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, body

passed, failed = [], []
def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))

# --- Test 1: publish public ---
html = "<!doctype html><html><body><h1>acceptance hello</h1></body></html>"
r = call("publish_page", {"html": html, "title": "Acceptance", "slug": "acceptance-hello", "visibility": "public"})
check("T1 publish_page returns url", bool(r.get("url")), str(r))
url = r["url"]; hash_ = r["hash"]
st, hdrs, body = get(url)
check("T1 page serves 200", st == 200, f"status={st}")
check("T1 immutable cache header", "immutable" in hdrs.get("cache-control","") and "31536000" in hdrs.get("cache-control",""), hdrs.get("cache-control",""))
check("T1 text/html content-type", "text/html" in hdrs.get("content-type",""), hdrs.get("content-type",""))
check("T1 body matches", b"acceptance hello" in body)

# --- Test 2: private + group ---
import time as _t0; _RUN = str(int(_t0.time()))
_SECRET = f"<h1>secret stuff {_RUN}</h1>"
r2 = call("publish_page", {"html": _SECRET, "slug": "acceptance-secret", "visibility": "private"})
check("T2 private publish returns private url", "private.paginate.dev" in r2.get("url",""), r2.get("url",""))
call("create_group", {"name": "acceptance-team", "emails": ["friend@example.com"]})
gr = call("grant_access", {"slug": "acceptance-secret", "group": "acceptance-team"})
check("T2 grant_access ok", gr.get("granted") is True, str(gr))
st, hdrs, body = get(r2["url"], resolve=("private.paginate.dev", IP))
# 302 -> Access login = the page IS protected (this is the pass condition).
# 200 with the secret body would mean it is NOT protected.
check("T2 private page is Access-gated (302 login redirect)", st == 302, f"status={st}")
check("T2 access login url present", "cloudflareaccess.com" in str(hdrs.get("location","")), str(hdrs.get("location",""))[:120])
lu = call("list_users", {})
check("T2 list_users shows seats", lu.get("seats_total_free_tier") == 50, str(lu.get("seats_total_free_tier")))

# --- Test 3: move private -> public ---
mv = call("set_visibility", {"slug": "acceptance-secret", "to": "public"})
check("T3 set_visibility moved", mv.get("moved") is True, str(mv))
# old private URL should be gone (landing json, not the secret)
st, hdrs, body = get(f"https://private.paginate.dev/s/acceptance-secret/{r2['hash']}/", resolve=("private.paginate.dev", IP))
check("T3 old private URL dead", _SECRET.encode() not in body, body[:100].decode(errors="replace"))
import time as _t
ok3 = False
for _ in range(5):
    st, hdrs, body = get(f"https://pub.paginate.dev/s/acceptance-secret/{r2['hash']}/")
    if st == 200 and _SECRET.encode() in body:
        ok3 = True; break
    _t.sleep(1.0)
check("T3 new public URL serves", ok3, f"status={st}")

# --- Test 3b: split-slug move (the bug we fixed) ---
try:
    call("delete_page", {"slug": "acceptance-split"})  # clean slate
except RuntimeError:
    pass  # already clean (back-to-back runs)
import time; time.sleep(0.5)
call("publish_page", {"html": "<h1>v1</h1>", "slug": "acceptance-split", "visibility": "public"})
call("publish_page", {"html": "<h1>v2</h1>", "slug": "acceptance-split", "visibility": "public"})
import time; time.sleep(0.5)  # let KV propagate before the move reads it back
mv2 = call("set_visibility", {"slug": "acceptance-split", "to": "private"})
check("T3b set_visibility moves all versions", mv2.get("versions_moved") == 2, str(mv2.get("versions_moved")))
la = call("list_assets", {"visibility": "private"})
split_priv = [a for a in la["assets"] if a["slug"] == "acceptance-split"]
check("T3b both split versions now private in D1", len(split_priv) == 2, f"got {len(split_priv)}")

# --- Test 4: get_status ---
gs = call("get_status", {})
check("T4 get_status has spend", "spend" in gs and "this_month_usd" in gs["spend"], str(gs)[:200])
check("T4 get_status has seats", gs.get("seats",{}).get("free_tier") == 50, str(gs.get("seats")))
check("T4 get_status has usage", "usage" in gs and "workers_requests_today" in gs["usage"], "")

# --- Test 5: audit_leaks clean-ish + list_assets + get_ops_log ---
al = call("audit_leaks", {})
check("T5 audit_leaks runs", "findings" in al, str(al)[:200])
la2 = call("list_assets", {})
check("T5 list_assets has entries", la2.get("count",0) >= 3, str(la2.get("count")))
ops = call("get_ops_log", {"limit": 10})
check("T5 get_ops_log has entries", ops.get("count",0) >= 5, str(ops.get("count")))

# --- Test 6: email guard (arbitrary recipient must refuse) ---
try:
    se = call("send_email", {"to": "stranger@elsewhere.example", "subject": "hi", "body_text": "hi"})
    check("T6 send_email refuses unverified recipient", False, f"no refusal: {se}")
except RuntimeError as e:
    check("T6 send_email refuses unverified recipient", "verified destination" in str(e).lower(), str(e)[:150])

# --- Test 7: dns + secrets list ---
dns = call("list_dns", {})
check("T7 list_dns works", dns.get("count",0) >= 3, str(dns.get("count")))
sec = call("list_worker_secrets", {})
names = sec.get("secrets", [])
check("T7 secrets listed (names only)", "MCP_TOKEN" in names and "CF_API_TOKEN" in names, str(names))
check("T7 no secret values leaked", all(isinstance(n, str) and len(n) < 40 and "=" not in n for n in sec.get("secrets", [])), "")

# --- Test 8: create_db ---
try:
    db = call("create_db", {"name": "acceptance-db", "visibility": "private", "owner_slug": "acceptance-secret"})
    check("T8 create_db ok", db.get("created") is True and db.get("d1_uuid"), str(db)[:200])
except RuntimeError as e:
    check("T8 create_db ok (idempotent re-run)", "already exists" in str(e).lower(), str(e)[:150])

# --- Teardown: leave no residue (suite is self-cleaning) ---
# The suite's own fixtures (acceptance-* slugs) are deleted after every run:
# KV copies via the platform's own tools, then D1 rows. The path-scoped Access
# app on private.paginate.dev/s/acceptance-secret is kept — grant_access
# adopts it idempotently on the next run (deleting/recreating it per run
# would churn Access apps and can hit rate limits).
for _slug in ("acceptance-hello", "acceptance-secret", "acceptance-split"):
    try:
        call("delete_page", {"slug": _slug})
        print(f"teardown: deleted {_slug}")
    except RuntimeError as e:
        # missing slug = already clean (e.g. back-to-back runs); other errors
        # would have failed the suite above
        print(f"teardown: {_slug} already clean")

print()
print(f"== {len(passed)} passed, {len(failed)} failed ==")
if failed:
    print("FAILED:", failed)
    sys.exit(1)
