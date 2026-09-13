import json
import uuid
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from agent import run_compound_agent

app = FastAPI()

@app.get("/")
async def health():
    return {"status": "ok"}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)

            msg_type = data.get("type", "prompt")
            thread_id = data.get("thread_id") or str(uuid.uuid4())

            if msg_type == "prompt":
                prompt = data.get("prompt", "").strip()
                if not prompt:
                    await websocket.send_json({"type": "error", "message": "empty prompt"})
                    continue

                workspace_context = data.get("workspace_context")

                async for event in run_compound_agent(prompt, thread_id, workspace_context):
                    await websocket.send_json(event)

            elif msg_type == "resume":
                await websocket.send_json({
                    "type": "status",
                    "thread_id": thread_id,
                    "run_id": str(uuid.uuid4()),
                    "node": "prepare_final_output"
                })

    except WebSocketDisconnect:
        print("Client disconnected")