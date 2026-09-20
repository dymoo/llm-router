"""Classifier backends. Production default is CPU PyTorch."""

from typing import Any, Protocol


class ClassifierBackend(Protocol):
    name: str

    def decide(self, state: Any, questions: dict[str, dict[str, Any]]) -> dict[str, Any]:
        ...

    def health(self) -> dict[str, Any]:
        ...
