import asyncio
import json
import uuid
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI()

async def dummy_agent_stream(prompt: str):
    yield {"type": "status", "node": "supervisor_route"}
    await asyncio.sleep(0.4)

    yield {"type": "status", "node": "worker_generate"}
    await asyncio.sleep(0.2)

    fake_answer = f"This is a dummy streamed response to: '{prompt}'"
    tokens = fake_answer.split(" ")

    full_text = ""
    for tok in tokens:
        full_text += (tok + " ")
        yield {"type": "code_chunk", "content": tok + " "}
        await asyncio.sleep(0.08)

    yield {"type": "final", "final_output": full_text.strip()}

@app.get("/")
async def root():
    return {"status": "ok"}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)

            prompt = data.get("prompt", "")
            thread_id = data.get("thread_id") or str(uuid.uuid4())

            if not prompt:
                await websocket.send_json({"type": "error", "message": "empty prompt"})
                continue

            await websocket.send_json({"type": "ack", "thread_id": thread_id})

            async for event in dummy_agent_stream(prompt):
                await websocket.send_json(event)

    except WebSocketDisconnect:
        print("Client disconnected")