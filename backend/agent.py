import os
import uuid
from typing import AsyncGenerator, Dict, Any
from groq import AsyncGroq

_client: AsyncGroq | None = None


def _get_client() -> AsyncGroq:
    global _client
    if _client is None:
        _client = AsyncGroq(api_key=os.environ.get("GROQ_API_KEY"))
    return _client


async def run_compound_agent(
    prompt: str,
    thread_id: str,
    workspace_context: Dict[str, Any] | None = None,
    run_id: str | None = None,
) -> AsyncGenerator[Dict[str, Any], None]:
    client = _get_client()
    if run_id is None:
        run_id = str(uuid.uuid4())

    yield {
        "type": "status",
        "thread_id": thread_id,
        "run_id": run_id,
        "node": "supervisor_route",
    }
    yield {
        "type": "status",
        "thread_id": thread_id,
        "run_id": run_id,
        "node": "worker_generate",
    }

    try:
        stream = await client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[
                {
                    "role": "system",
                    "content": "You are Aegis, a code-centric AI agent. Provide accurate, production-ready code.",
                },
                {"role": "user", "content": prompt},
            ],
            stream=True,
        )

        full_output = ""
        async for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                full_output += delta
                yield {
                    "type": "code_chunk",
                    "run_id": run_id,
                    "content": delta,
                    "done": False,
                }

        yield {
            "type": "code_chunk",
            "run_id": run_id,
            "content": "",
            "done": True,
        }

        yield {
            "type": "final",
            "run_id": run_id,
            "final_output": full_output,
        }

    except Exception as e:
        yield {
            "type": "error",
            "run_id": run_id,
            "message": str(e),
        }