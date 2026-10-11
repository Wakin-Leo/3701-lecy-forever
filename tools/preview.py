#!/usr/bin/env python3
"""Loopback-only preview: synthetic personal data, no real API calls or disk writes."""
import argparse
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


GUARD = r'''"use strict";
(() => {
  const originalFetch = window.fetch.bind(window);
  const files = {
    "user/favorites.json": {categories: ["待读", "重要"], items: []},
    "user/highlights.json": {items: []}, "user/read.json": {items: []},
    "user/diary.json": {items: []}, "user/anniversaries.json": {items: []},
    "user/works.json": {items: []},
    "notes/摘要笔记.md": "# 预览笔记\n", "notes/小黄豆罐头日志.md": "# 预览日志\n"
  };
  const saved = sessionStorage.getItem("digest_preview_files");
  if (saved) { try { Object.assign(files, JSON.parse(saved)); } catch (_) {} }
  const persist = () => sessionStorage.setItem("digest_preview_files", JSON.stringify(files));
  const asText = v => typeof v === "string" ? v : JSON.stringify(v, null, 2);
  const toB64 = s => btoa(unescape(encodeURIComponent(s)));
  const fromB64 = s => decodeURIComponent(escape(atob(s)));
  const response = (v, status = 200) => Promise.resolve(new Response(JSON.stringify(v), {
    status, headers: {"Content-Type": "application/json"}
  }));
  sessionStorage.setItem("gate", "1");
  localStorage.setItem("gh_token", "preview-only-not-a-credential");
  // Use no translation key; production keys must never be configured on this origin.
  localStorage.removeItem("tr_key");
  window.__DIGEST_PREVIEW__ = {files, requests: [], reset() {
    sessionStorage.removeItem("digest_preview_files"); location.reload();
  }};
  window.fetch = (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const method = String(options.method || (input && input.method) || "GET").toUpperCase();
    window.__DIGEST_PREVIEW__.requests.push({path: url.pathname, method, local: url.origin === location.origin});
    if (url.origin === location.origin) {
      const path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (Object.hasOwn(files, path)) return response(files[path]);
      return originalFetch(input, options);
    }
    const prefix = "/repos/Wakin-Leo/3701-lecy-forever/contents/";
    if (url.hostname === "api.github.com" && url.pathname.startsWith(prefix)) {
      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      if (method === "GET") {
        if (Object.hasOwn(files, path)) return response({sha: "preview", content: files[path].__previewBinary || toB64(asText(files[path]))});
        if (["journals.json", "site-config.json"].includes(path)) {
          return originalFetch("/" + path).then(r => r.text()).then(s => {
            files[path] = JSON.parse(s); return response({sha: "preview", content: toB64(s)});
          });
        }
        return response({message: "preview file absent"}, 404);
      }
      if (method === "PUT") {
        const body = JSON.parse(options.body || "{}");
        if (path.endsWith(".json") || path.endsWith(".md")) {
          const text = fromB64(body.content || "");
          files[path] = path.endsWith(".json") ? JSON.parse(text) : text;
        } else { files[path] = {__previewBinary: body.content || ""}; }
        persist(); return response({content: {sha: "preview"}, commit: {sha: "preview"}});
      }
      if (method === "DELETE") { delete files[path]; persist(); return response({commit: {sha: "preview"}}); }
    }
    // All remaining outbound fetches are blocked before a network request is made.
    return response({error: {message: "本地预览已阻断外部 API；翻译与语义查询请在线上单独验证。"}}, 403);
  };
  window.addEventListener("DOMContentLoaded", () => {
    const banner = document.createElement("div");
    banner.id = "preview-banner";
    banner.textContent = "本地预览 Local preview · 个人数据为测试数据 · 保存仅在当前标签页 · 外部 API 已阻断";
    banner.style.cssText = "position:sticky;top:0;z-index:9999;background:#fff2c8;color:#4b3900;padding:9px 14px;font:13px system-ui;text-align:center;border-bottom:1px solid #e0c365";
    document.body.prepend(banner);
    const showTestImages = () => document.querySelectorAll('img[src^="works/"]').forEach(img => {
      const item = files[img.getAttribute("src")];
      if (item && item.__previewBinary) img.src = "data:image/jpeg;base64," + item.__previewBinary;
    });
    new MutationObserver(showTestImages).observe(document.body, {childList: true, subtree: true});
    showTestImages();
  });
})();
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    root = args.root.resolve()
    if not (root / "index.html").is_file():
        parser.error("--root must contain index.html")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send_body(self, body, status=200, content_type="application/json", head=False):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "connect-src 'self'; form-action 'self'; object-src 'none'")
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def serve(self, head=False):
            path = unquote(urlsplit(self.path).path).lstrip("/") or "index.html"
            if path == "__preview_guard.js":
                return self.send_body(GUARD.encode(), content_type="application/javascript; charset=utf-8", head=head)
            if path == "__preview_health":
                return self.send_body(b'{"preview":true,"isolated":true}', head=head)
            target = (root / path).resolve()
            parts = path.replace("\\", "/").split("/")
            allowed = path in {"index.html", "app.js", "styles.css", "journals.json", "site-config.json"} or (
                path.startswith("data/") and target.is_relative_to(root / "data") and target.suffix == ".json"
            )
            allowed = allowed and not any(part in {".", ".."} for part in parts)
            if not allowed or not target.is_relative_to(root) or not target.is_file():
                return self.send_body(b'{"error":"not available in isolated preview"}', 404, head=head)
            body = target.read_bytes()
            if path == "index.html":
                body = body.replace(b"<head>", b'<head>\n<script src="/__preview_guard.js"></script>', 1)
            content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
            if content_type.startswith("text/") or path.endswith((".js", ".json")):
                content_type += "; charset=utf-8"
            try:
                self.send_body(body, content_type=content_type, head=head)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            self.serve()

        def do_HEAD(self):
            self.serve(head=True)

        def do_POST(self):
            self.send_body(b'{"error":"read-only HTTP server"}', 405)

        do_PUT = do_DELETE = do_POST

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Local URL: http://127.0.0.1:{args.port}/#latest", flush=True)
    print("Isolated preview: synthetic personal data, no external API calls or real saves.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
