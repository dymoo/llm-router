"""Typed failures that never include prompt or answer text."""


class LayaServiceError(Exception):
    def __init__(self, code: str, message: str, http_status: int = 500) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.extra: dict[str, object] = {}


class SchemaError(LayaServiceError):
    def __init__(self, message: str, code: str = "invalid_request") -> None:
        super().__init__(code, message, http_status=400)


class BodyError(LayaServiceError):
    pass


class BackendConfigError(LayaServiceError):
    def __init__(self, message: str, code: str = "backend_unavailable") -> None:
        super().__init__(code, message, http_status=503)


class MemoryBudgetError(LayaServiceError):
    def __init__(self, message: str = "process exceeded LAYA_MEMORY_BUDGET_MB") -> None:
        super().__init__("oom", message, http_status=503)


class CancelledError(LayaServiceError):
    def __init__(self) -> None:
        super().__init__("cancelled", "client disconnected", http_status=499)


class ContextExceeded(LayaServiceError):
    def __init__(self, input_tokens: int, max_len: int, head_budget: int) -> None:
        super().__init__("context_exceeded", "input exceeds Laya context", http_status=413)
        self.input_tokens = input_tokens
        self.max_len = max_len
        self.head_budget = head_budget
        self.extra = {
            "input_tokens": input_tokens,
            "max_len": max_len,
            "head_budget": head_budget,
        }
