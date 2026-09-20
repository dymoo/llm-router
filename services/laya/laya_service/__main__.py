"""python -m laya_service [serve|export|probe|compile]"""

from __future__ import annotations

import signal
import sys

from .snapshot import apply_runtime_env


def main(argv: list[str] | None = None) -> int:
    apply_runtime_env()
    args = list(sys.argv[1:] if argv is None else argv)
    command = args[0] if args and not args[0].startswith("-") else "serve"
    rest = args[1:] if args and not args[0].startswith("-") else args
    if command == "export":
        from .export import main as export_main

        return export_main(rest)
    if command == "probe":
        from .npu.probe import main as probe_main

        return probe_main(rest)
    if command == "compile":
        from .npu.compile import main as compile_main

        return compile_main(rest)
    if command not in {"serve", "run"}:
        sys.stderr.write("usage: python -m laya_service [serve|export|probe|compile]\n")
        return 2
    from .config import load_settings
    from .http_server import serve
    from .logutil import configure_logging, log_event
    from .runtime import Runtime

    logger = configure_logging()
    settings = load_settings()
    runtime = Runtime(settings)
    server = serve(runtime)

    def _stop(signum: int, _frame: object) -> None:
        log_event(logger, event="shutdown", signal=signum)
        server.shutdown()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    log_event(
        logger,
        event="listen",
        host=settings.host,
        port=settings.port,
        backend=settings.backend,
        model_revision=settings.model_revision,
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
