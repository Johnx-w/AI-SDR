"""Read one brokered document in a fresh Chromium context."""

from base64 import b64decode
from importlib.metadata import version
import json
import os
import signal
import sys
from threading import Event, Thread
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, ProxyHandler

import psutil
from playwright.sync_api import Error, TimeoutError, sync_playwright
from scrapling import Selector

MAX_DOCUMENT = 4 * 1024 * 1024
MEMORY_LIMIT = 1024 ** 3


def stop_processes(*_):
    for child in reversed(psutil.Process().children(recursive=True)):
        try:
            child.kill()
        except psutil.NoSuchProcess:
            pass
    os._exit(1)


def observe(stop, peaks):
    root = psutil.Process()
    while not stop.wait(0.1):
        children = root.children(recursive=True)
        rss = 0
        for process in [root, *children]:
            try:
                rss += process.memory_info().rss
            except psutil.NoSuchProcess:
                pass
        peaks["tree_rss_bytes"] = max(peaks["tree_rss_bytes"], rss)
        peaks["processes"] = max(peaks["processes"], len(children) + 1)
        memory = psutil.virtual_memory()
        peaks["system_used_bytes"] = max(peaks["system_used_bytes"], memory.total - memory.available)
        if rss > MEMORY_LIMIT:
            stop_processes()


def read_page(request):
    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch(
                chromium_sandbox=True,
                proxy={"server": "http://127.0.0.1:1"},
                args=[
                    "--proxy-bypass-list=<-loopback>",
                    "--host-resolver-rules=MAP * ~NOTFOUND",
                    "--disable-quic",
                    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                ],
                timeout=7000,
            )
        except Error:
            return {"status": "unavailable"}
        try:
            context = browser.new_context(accept_downloads=False, service_workers="block")
            page = context.new_page()
            context.on("page", lambda popup: popup.close())
            context.route_web_socket("**/*", lambda socket: socket.close())
            opener = build_opener(ProxyHandler({}))
            body = b64decode(request["body"], validate=True)
            document_served = False

            def route_request(route):
                nonlocal document_served
                resource = route.request
                if resource.method != "GET" or not resource.url.startswith("https://"):
                    route.abort()
                elif resource.resource_type == "document":
                    if document_served or resource.url != request["url"]:
                        route.abort()
                    else:
                        document_served = True
                        route.fulfill(status=200, body=body, content_type=request["type"])
                elif resource.resource_type in {"script", "stylesheet", "xhr", "fetch"}:
                    query = urlencode({"url": resource.url, "kind": resource.resource_type})
                    try:
                        with opener.open(
                            Request(
                                request["gateway"] + "/?" + query,
                                headers={"Authorization": "Bearer " + request["token"]},
                            ),
                            timeout=4,
                        ) as reply:
                            data = reply.read(MAX_DOCUMENT + 1)
                            kind = reply.headers.get("Content-Type")
                    except (URLError, TimeoutError, OSError):
                        route.abort()
                        return
                    if len(data) > MAX_DOCUMENT:
                        route.abort()
                    else:
                        route.fulfill(status=200, body=data, content_type=kind)
                else:
                    route.abort()

            context.route("**/*", route_request)
            page.goto(request["url"], wait_until="domcontentloaded", timeout=18000)
            page.wait_for_timeout(950)
            html = page.content()
            if len(html.encode()) > MAX_DOCUMENT:
                return {"status": "failed"}
            document = Selector(content=html, url=page.url)
            return {
                "status": "ok",
                "url": page.url,
                "content": html,
                "links": document.css("a::attr(href)").getall()[:150],
                "versions": {
                    "python": sys.version.split()[0],
                    "scrapling": version("scrapling"),
                    "playwright": version("playwright"),
                    "chromium": browser.version,
                },
            }
        except TimeoutError:
            return {"status": "timeout"}
        except Error:
            return {"status": "failed"}
        finally:
            browser.close()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop_processes)
    stopped = Event()
    measurements = {"tree_rss_bytes": 0, "processes": 0, "system_used_bytes": 0}
    observer = Thread(target=observe, args=(stopped, measurements), daemon=True)
    observer.start()
    try:
        result = read_page(json.load(sys.stdin))
    finally:
        stopped.set()
        observer.join()
    print(json.dumps({**result, "resources": measurements}, ensure_ascii=False))
