"""Thin client for the GWDG Academic Cloud Chat AI endpoint (OpenAI-compatible).

Credentials come from .env (CHAT_AI_BASE_URL, CHAT_AI_API_KEY) — never hard-code them.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

import requests
from dotenv import load_dotenv

load_dotenv()

DEFAULT_BASE_URL = "https://chat-ai.academiccloud.de/v1"

# These models return their chain of thought in a separate "reasoning" field and
# leave "content" empty until they are done, so they need a generous token budget.
REASONING_MODELS = {
    "qwen3.5-397b-a17b",
    "qwen3.5-122b-a10b",
    "qwen3.6-27b",
    "qwen3.6-35b-a3b",
    "qwen3-30b-a3b-instruct-2507",
    "openai-gpt-oss-120b",
}


class ChatAIError(RuntimeError):
    pass


@dataclass
class Completion:
    content: str
    reasoning: str
    model: str
    finish_reason: str
    usage: dict = field(default_factory=dict)
    latency_s: float = 0.0

    @property
    def truncated(self) -> bool:
        return self.finish_reason == "length"


class ChatAI:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: int = 600,
        max_retries: int = 4,
        extra_body: dict | None = None,
    ) -> None:
        self.api_key = api_key or os.getenv("CHAT_AI_API_KEY")
        if not self.api_key:
            raise ChatAIError("CHAT_AI_API_KEY is not set — copy env.example to .env and fill it in.")
        self.base_url = (base_url or os.getenv("CHAT_AI_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        # Extra fields for every completion request, e.g. the thinking switch
        # {"chat_template_kwargs": {"enable_thinking": False}}
        self.extra_body = extra_body or {}
        self.session = requests.Session()
        self.session.headers.update(
            {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        )

    def models(self) -> list[str]:
        response = self.session.get(f"{self.base_url}/models", timeout=60)
        response.raise_for_status()
        return sorted(m["id"] for m in response.json().get("data", []))

    def complete(
        self,
        model: str,
        system: str,
        user: str,
        temperature: float = 0.0,
        max_tokens: int = 4096,
        top_p: float = 1.0,
        response_format: dict | None = None,
    ) -> Completion:
        payload = {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "top_p": top_p,
        }
        if response_format:  # e.g. {"type": "json_schema", ...} for schema-constrained output
            payload["response_format"] = response_format
        payload.update(self.extra_body)

        last_error: Exception | None = None
        for attempt in range(self.max_retries):
            started = time.time()
            try:
                response = self.session.post(
                    f"{self.base_url}/chat/completions", json=payload, timeout=self.timeout
                )
                # 429/5xx are transient on the shared cluster; back off and retry.
                if response.status_code == 429 or response.status_code >= 500:
                    raise ChatAIError(f"HTTP {response.status_code}: {response.text[:200]}")
                response.raise_for_status()
                data = response.json()
                choice = data["choices"][0]
                message = choice["message"]
                return Completion(
                    content=(message.get("content") or "").strip(),
                    reasoning=(message.get("reasoning") or "").strip(),
                    model=data.get("model", model),
                    finish_reason=choice.get("finish_reason", ""),
                    usage=data.get("usage", {}),
                    latency_s=round(time.time() - started, 2),
                )
            except (requests.RequestException, ChatAIError, KeyError, ValueError) as error:
                last_error = error
                if attempt < self.max_retries - 1:
                    time.sleep(2**attempt)

        raise ChatAIError(f"{model}: failed after {self.max_retries} attempts — {last_error}")
