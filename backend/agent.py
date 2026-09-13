import os
import uuid
import asyncio
from typing import AsyncGenerator, Dict, Any
from groq import AsyncGroq

async def run_compound_agent(
    prompt: str,
    thread_id: str,
    workspace_context: Dict[str, Any] | None = None
) -> AsyncGenerator[Dict[str, Any], None]:
    client = AsyncGroq(api_key=os.environ.get("GROQ_API_KEY"))
    run_id = str(uuid.uuid4())

    yield {
        "type": "status",
        "thread_id": thread_id,
        "run_id": run_id,
        "node": "supervisor_route"
    }
    yield {
        "type": "status",
        "thread_id": thread_id,
        "run_id": run_id,
        "node": "worker_generate"
    }

    try:
        stream = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {
                    "role": "system",
                    "content": "You are Aegis, a code-centric AI agent. Provide accurate, production-ready code."
                },
                {"role": "user", "content": prompt}
            ],
            stream=True
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
                    "done": False
                }

        yield {
            "type": "code_chunk",
            "run_id": run_id,
            "content": "",
            "done": True
        }

        yield {
            "type": "final",
            "run_id": run_id,
            "final_output": full_output
        }

    except Exception as e:
        yield {
            "type": "error",
            "message": str(e)
        }