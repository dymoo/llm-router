"""HTTP front-end: GET /healthz, POST /v1/decide, POST /v1/budget."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from .errors import BodyError, CancelledError, LayaServiceError, MemoryBudgetError
from .logutil import configure_logging, log_event
from .runtime import Runtime

LOGGER = configure_logging()


class LayaHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr: tuple[str, int], runtime: Runtime) -> None:
        self.runtime = runtime
        super().__init__(addr, LayaHandler)


class LayaHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 60

    @property
    def runtime(self) -> Runtime:
        return self.server.runtime  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/healthz", "/health"):
            body = self.runtime.health()
            status = 200 if body.get("ready") else 503
            self._write_json(status, body)
            return
        self._write_json(404, _error("not_found", "unknown path"))

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path not in ("/v1/decide", "/v1/budget"):
            self._write_json(404, _error("not_found", "unknown path"))
            return
        try:
            raw = self._read_body(self.runtime.settings.max_body_bytes)
            payload = json.loads(raw.decode("utf-8"))
        except BodyError as exc:
            self._write_json(exc.http_status, _error(exc.code, exc.message))
            return
        except json.JSONDecodeError:
            self._write_json(400, _error("invalid_json", "body is not valid JSON"))
            return
        except UnicodeDecodeError:
            self._write_json(400, _error("invalid_json", "body is not UTF-8"))
            return
        if path == "/v1/budget":
            self._handle_budget(payload)
            return
        self._handle_decide(payload)

    def _handle_decide(self, payload: Any) -> None:
        if not self.runtime.acquire():
            self._write_json(503, _error("busy", "classifier concurrency limit reached"))
            return
        try:
            result = self.runtime.decide(payload)
            self._write_json(200, result)
            log_event(
                LOGGER,
                event="decide",
                status=200,
                backend=result.get("backend"),
                input_tokens=(result.get("usage") or {}).get("input_tokens"),
                bytes=int(self.headers.get("Content-Length") or 0),
            )
        except CancelledError:
            log_event(LOGGER, event="decide", status=499, cancelled=True)
        except MemoryBudgetError as exc:
            self.runtime.mark_oom()
            self._write_json(503, _error(exc.code, exc.message))
        except LayaServiceError as exc:
            self._write_json(exc.http_status, _error(exc.code, exc.message, getattr(exc, "extra", None)))
        except (BrokenPipeError, ConnectionResetError):
            log_event(LOGGER, event="decide", status=499, cancelled=True)
        except Exception:
            log_event(LOGGER, event="decide", status=500)
            self._write_json(500, _error("inference_failed", "classifier inference failed"))
        finally:
            self.runtime.release()

    def _handle_budget(self, payload: Any) -> None:
        try:
            result = self.runtime.budget(payload)
            self._write_json(200, result)
        except LayaServiceError as exc:
            self._write_json(exc.http_status, _error(exc.code, exc.message))
        except Exception:
            self._write_json(500, _error("budget_failed", "tokenizer budget check failed"))

    def _read_body(self, max_bytes: int) -> bytes:
        length = self.headers.get("Content-Length")
        if length is None:
            raise BodyError("length_required", "Content-Length is required", http_status=411)
        try:
            size = int(length)
        except ValueError as exc:
            raise BodyError("invalid_length", "Content-Length is invalid", http_status=400) from exc
        if size < 0 or size > max_bytes:
            raise BodyError("payload_too_large", "JSON body exceeds LAYA_MAX_BODY_BYTES", http_status=413)
        data = self.rfile.read(size)
        if len(data) != size:
            raise BodyError("truncated_body", "request body truncated", http_status=400)
        return data

    def _write_json(self, status: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError) as exc:
            raise CancelledError() from exc


def _error(code: str, message: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"code": code, "message": message}
    if extra:
        payload.update(extra)
    return {"error": payload}


def serve(runtime: Runtime) -> LayaHTTPServer:
    server = LayaHTTPServer((runtime.settings.host, runtime.settings.port), runtime)
    return server
