# Stub Cockpit core on a Unix socket: answers like browser.rs and logs every request.
import socket, os, json, sys, threading
sock = sys.argv[1]
if os.path.exists(sock): os.remove(sock)
srv = socket.socket(socket.AF_UNIX); srv.bind(sock); srv.listen(4)
log = open(sys.argv[2], "a")
def serve(c):
    f = c.makefile("rwb")
    for line in f:
        m = json.loads(line); log.write(line.decode()); log.flush()
        r = {"re": m.get("id")}
        if m["type"] == "hello": r["version"] = "0.1.0"
        elif m["type"] == "sessions": r.update(sessions=[{"id":"A","title":"settings redesign","marker":"S","suggested":True}], linked=None, blocked=False)
        else: r["ok"] = True
        f.write((json.dumps(r)+"\n").encode()); f.flush()
while True:
    c,_ = srv.accept(); threading.Thread(target=serve, args=(c,), daemon=True).start()
