"""Read one brokered document in a fresh Chromium context."""

import asyncio
from base64 import b64decode
from importlib.metadata import version
import json
import os
import sys
from threading import Event, Thread
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, ProxyHandler

import psutil
from playwright.async_api import Error, TimeoutError, async_playwright
from scrapling import Selector

MAX_DOCUMENT = 4 * 1024 * 1024
MEMORY_LIMIT = 1024 ** 3


def observe(stop, peaks):
    root = psutil.Process()
    kernel_limited = os.environ.get("SCRAPLING_CGROUP_LIMITED") == "1"
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
        if not kernel_limited and rss > MEMORY_LIMIT:
            os._exit(74)


def read_gateway(request, url, resource_type):
    query = urlencode({"url": url, "kind": resource_type})
    try:
        with build_opener(ProxyHandler({})).open(
            Request(
                request["gateway"] + "/?" + query,
                headers={"Authorization": "Bearer " + request["token"]},
            ),
            timeout=4,
        ) as reply:
            return reply.read(MAX_DOCUMENT + 1), reply.headers.get("Content-Type")
    except (URLError, OSError):
        return b"", None


def has_body_text(document):
    # An interrupted page can serialize its title or a Trustindex badge before
    # the site's body arrives. Retain that HTML, but keep the capture incomplete.
    nodes = document.xpath(
        "//body//text()[not("
        "ancestor::title or ancestor::script or ancestor::style or "
        "ancestor::template or ancestor::svg or ancestor::noscript or "
        "ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ti-widget-container ')]"
        ")]"
    ).getall()
    return any(character.isalnum() for text in nodes for character in text)


async def read_page(request):
    async with async_playwright() as playwright:
        try:
            browser = await playwright.chromium.launch(
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
            context = await browser.new_context(accept_downloads=False, service_workers="block")
            page = await context.new_page()
            context.on("page", lambda popup: popup.close())
            await context.route_web_socket("**/*", lambda socket: socket.close())
            body = b64decode(request["body"], validate=True)
            document_served = False
            available = asyncio.Semaphore(3)

            async def route_request(route):
                nonlocal document_served
                resource = route.request
                if resource.method != "GET" or not resource.url.startswith("https://"):
                    await route.abort()
                elif resource.resource_type == "document":
                    if document_served or resource.url != request["url"]:
                        await route.abort()
                    else:
                        document_served = True
                        await route.fulfill(status=200, body=body, content_type=request["type"])
                elif resource.resource_type in {"script", "stylesheet", "xhr", "fetch"}:
                    async with available:
                        data, kind = await asyncio.to_thread(
                            read_gateway, request, resource.url, resource.resource_type
                        )
                    if not kind or len(data) > MAX_DOCUMENT:
                        await route.abort()
                    else:
                        await route.fulfill(status=200, body=data, content_type=kind)
                else:
                    await route.abort()

            await context.route("**/*", route_request)
            await page.goto(request["url"], wait_until="commit", timeout=10000)
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=8000)
            except TimeoutError:
                # Slow optional scripts need not hide evidence already in the DOM.
                pass
            await page.wait_for_timeout(950)
            html = await page.content()
            if len(html.encode()) > MAX_DOCUMENT:
                return {"status": "failed"}
            document = Selector(content=html, url=page.url)
            return {
                "status": "ok",
                "url": page.url,
                "content": html,
                "has_body_text": has_body_text(document),
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
            await browser.close()


if __name__ == "__main__":
    stopped = Event()
    measurements = {"tree_rss_bytes": 0, "processes": 0, "system_used_bytes": 0}
    observer = Thread(target=observe, args=(stopped, measurements), daemon=True)
    observer.start()
    try:
        result = asyncio.run(read_page(json.load(sys.stdin)))
    finally:
        stopped.set()
        observer.join()
    print(json.dumps({**result, "resources": measurements}, ensure_ascii=False))
