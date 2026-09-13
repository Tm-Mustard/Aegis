import os
import uuid
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
        response = await client.chat.completions.create(
            model="groq/compound",
            messages=[
                {
                    "role": "system",
                    "content": "You are Aegis, a code-centric AI agent. Provide accurate, production-ready code."
                },
                {"role": "user", "content": prompt}
            ]
        )

        content = response.choices[0].message.content or ""

        words = content.split(" ")
        for i, word in enumerate(words):
            chunk = word + (" " if i < len(words) - 1 else "")
            yield {
                "type": "code_chunk",
                "run_id": run_id,
                "content": chunk,
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
            "final_output": content
        }

    except Exception as e:
        yield {
            "type": "error",
            "message": str(e)
        }