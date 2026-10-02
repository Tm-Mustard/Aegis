import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import time
import uuid
from contextlib import aclosing
from typing import Any

from dotenv import load_dotenv

load_dotenv()  

from fastapi import FastAPI, WebSocket, WebSocketDisconnect  
from agent import run_compound_agent  

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("gateway")

app = FastAPI()

MAX_FRAME_BYTES = 1 * 1024 * 1024
MAX_PROMPT_BYTES = 32 * 1024
MAX_WORKSPACE_CONTEXT_BYTES = 512 * 1024
MAX_THREAD_ID_LEN = 128

GATEWAY_RUN_TIMEOUT_S = 90
CANCEL_TASK_TIMEOUT_S = 5
AUTH_TIMEOUT_S = 10

REGISTRY_TTL_S = 15 * 60
REGISTRY_MAX_RECORDS = 1000

TERMINAL_EVENT_TYPES = {"final", "failure", "error", "cancelled"}

AUTH_TOKEN = os.environ.get("GATEWAY_AUTH_TOKEN")

_THREAD_ID_RE = re.compile(r"^[A-Za-z0-9_\-:.]{1,%d}$" % MAX_THREAD_ID_LEN)


def _valid_thread_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_THREAD_ID_RE.match(value))


def _short(obj: Any, n: int = 300) -> str:
    s = repr(obj)
    return s if len(s) <= n else s[:n] + "...<truncated>"


class RunRecord:
    __slots__ = ("thread_id", "run_id", "owner", "task", "cancel_reason",
                 "terminal_type", "terminal_event", "started_at",
                 "terminal_at", "zombie")

    def __init__(self, thread_id: str, run_id: str, owner: str):
        self.thread_id = thread_id
        self.run_id = run_id
        self.owner = owner
        self.task: asyncio.Task | None = None
        self.cancel_reason: str | None = None
        self.terminal_type: str | None = None
        self.terminal_event: dict | None = None
        self.started_at = time.monotonic()
        self.terminal_at: float | None = None
        self.zombie = False

    def is_active(self) -> bool:
        return self.task is None or not self.task.done()

    def claim(self, event: dict, reason: str | None = None) -> bool:
        if self.terminal_type is not None:
            return False
        self.terminal_type = event["type"]
        self.terminal_event = event
        self.terminal_at = time.monotonic()
        if reason:
            self.cancel_reason = reason
        return True


class RunRegistry:
    def __init__(self):
        self._by_thread: dict[str, RunRecord] = {}

    def get(self, thread_id: str | None) -> RunRecord | None:
        return self._by_thread.get(thread_id) if thread_id else None

    def is_current(self, rec: RunRecord) -> bool:
        return self._by_thread.get(rec.thread_id) is rec

    def register(self, thread_id: str, run_id: str, owner: str) -> RunRecord:
        self._evict()
        rec = RunRecord(thread_id, run_id, owner)
        self._by_thread[thread_id] = rec
        return rec

    def _evict(self) -> None:
        now = time.monotonic()

        def age(r: RunRecord) -> float:
            return now - (r.terminal_at if r.terminal_at is not None
                          else r.started_at)

        for tid in [t for t, r in self._by_thread.items()
                    if not r.is_active() and age(r) > REGISTRY_TTL_S]:
            del self._by_thread[tid]
        if len(self._by_thread) >= REGISTRY_MAX_RECORDS:
            inactive = sorted(
                (r for r in self._by_thread.values() if not r.is_active()),
                key=lambda r: r.started_at,
            )
            for r in inactive[: len(self._by_thread) - REGISTRY_MAX_RECORDS + 1]:
                self._by_thread.pop(r.thread_id, None)


registry = RunRegistry()


@app.get("/")
async def health():
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    send_lock = asyncio.Lock()
    authed = AUTH_TOKEN is None
    owner = "anon"

    own_rec: RunRecord | None = None
    focus_rec: RunRecord | None = None

    async def send(event: dict):
        async with send_lock:
            try:
                await websocket.send_json(event)
            except (WebSocketDisconnect, RuntimeError):
                logger.debug("send failed; socket gone")
            except (TypeError, ValueError):
                logger.exception("event not JSON-serializable: %s", _short(event))

    async def emit(rec: RunRecord, event: dict) -> None:
        event["thread_id"] = rec.thread_id
        event["run_id"] = rec.run_id
        if not registry.is_current(rec):
            logger.warning("fenced event thread_id=%s run_id=%s type=%s",
                           rec.thread_id, rec.run_id, event.get("type"))
            return
        if rec.zombie:
            logger.warning("dropped event from zombie thread_id=%s run_id=%s",
                           rec.thread_id, rec.run_id)
            return
        if event.get("type") in TERMINAL_EVENT_TYPES:
            if not rec.claim(event):
                return
        elif rec.terminal_type is not None:
            return
        await send(event)

    async def terminate(rec: RunRecord, event: dict,
                        reason: str | None = None) -> bool:
        event["thread_id"] = rec.thread_id
        event["run_id"] = rec.run_id
        if not registry.is_current(rec):
            return False
        if not rec.claim(event, reason):
            return False
        await send(event)
        return True

    async def stop_run(rec: RunRecord) -> bool:
        task = rec.task
        if task is None or task.done():
            return True
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task),
                                   timeout=CANCEL_TASK_TIMEOUT_S)
            return True
        except asyncio.TimeoutError:
            logger.error("zombie task thread_id=%s run_id=%s",
                         rec.thread_id, rec.run_id)
            rec.zombie = True
            return False
        except asyncio.CancelledError:
            me = asyncio.current_task()
            if me is not None and getattr(me, "cancelling", lambda: 0)() > 0:
                raise
            return True
        except Exception:
            logger.exception("task raised during teardown thread_id=%s run_id=%s",
                             rec.thread_id, rec.run_id)
            return True

    async def run_agent(rec: RunRecord, prompt: str, workspace_context):
        try:
            async with aclosing(run_compound_agent(
                prompt, rec.thread_id, workspace_context, run_id=rec.run_id
            )) as events:
                async for event in events:
                    if not isinstance(event, dict):
                        continue
                    await emit(rec, event)
                    if rec.terminal_type is not None:
                        break
            if rec.terminal_type is None:
                logger.error("agent ended without terminal event "
                             "thread_id=%s run_id=%s", rec.thread_id, rec.run_id)
                await terminate(rec, {"type": "error",
                                      "message": "run ended without terminal event"})
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("agent run failed thread_id=%s run_id=%s",
                             rec.thread_id, rec.run_id)
            await terminate(rec, {"type": "error", "message": "agent run failed"})

    async def run_agent_with_timeout(rec: RunRecord, prompt: str, workspace_context):
        try:
            await asyncio.wait_for(run_agent(rec, prompt, workspace_context),
                                   timeout=GATEWAY_RUN_TIMEOUT_S)
        except asyncio.TimeoutError:
            logger.error("gateway timeout thread_id=%s run_id=%s",
                         rec.thread_id, rec.run_id)
            await terminate(rec, {
                "type": "error",
                "message": f"gateway timeout after {GATEWAY_RUN_TIMEOUT_S}s",
            })

    def lookup(thread_id: str | None) -> RunRecord | None:
        rec = registry.get(thread_id)
        return rec if rec is not None and rec.owner == owner else None

    try:
        while True:
            if AUTH_TOKEN is not None and not authed:
                try:
                    raw = await asyncio.wait_for(websocket.receive_text(),
                                                 timeout=AUTH_TIMEOUT_S)
                except asyncio.TimeoutError:
                    logger.info("auth timeout; closing")
                    await websocket.close(code=1008)
                    break
            else:
                raw = await websocket.receive_text()

            if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
                await send({"type": "error", "message": "frame too large"})
                continue

            try:
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError("message must be a JSON object")
            except ValueError as e:
                await send({"type": "error", "message": f"invalid message: {e}"})
                continue

            try:
                msg_type = data.get("type", "prompt")

                if msg_type == "auth":
                    if authed and AUTH_TOKEN is not None:
                        await send({"type": "error",
                                    "message": "already authenticated"})
                        continue
                    token = data.get("token")
                    if AUTH_TOKEN is None:
                        authed = True
                    elif isinstance(token, str) and hmac.compare_digest(
                            token.encode(), AUTH_TOKEN.encode()):
                        authed = True
                        owner = hashlib.sha256(token.encode()).hexdigest()[:16]
                    else:
                        await send({"type": "error", "message": "auth failed"})
                        await websocket.close(code=1008)
                        break
                    await send({"type": "auth_ok"})
                    continue

                if not authed:
                    await send({"type": "error", "message": "auth required"})
                    await websocket.close(code=1008)
                    break

                if msg_type == "prompt":
                    thread_id = data.get("thread_id") or str(uuid.uuid4())
                    if not _valid_thread_id(thread_id):
                        await send({"type": "error", "message": "invalid thread_id"})
                        continue

                    if own_rec is not None and own_rec.is_active():
                        await send({"type": "error",
                                    "thread_id": own_rec.thread_id,
                                    "run_id": own_rec.run_id,
                                    "message": "a run is already in progress on this connection"})
                        continue

                    existing = registry.get(thread_id)
                    if existing is not None and existing.is_active():
                        msg = ("previous run is still shutting down; retry shortly"
                               if existing.zombie else "a run is already in progress")
                        await send({"type": "error", "thread_id": thread_id,
                                    "message": msg})
                        continue

                    prompt = data.get("prompt")
                    if not isinstance(prompt, str) or not prompt.strip():
                        await send({"type": "error", "thread_id": thread_id,
                                    "message": "empty or non-string prompt"})
                        continue
                    prompt = prompt.strip()
                    if len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
                        await send({"type": "error", "thread_id": thread_id,
                                    "message": "prompt too large"})
                        continue

                    workspace_context = data.get("workspace_context")
                    if workspace_context is not None:
                        if not isinstance(workspace_context, dict):
                            await send({"type": "error", "thread_id": thread_id,
                                        "message": "workspace_context must be an object"})
                            continue
                        try:
                            wc_size = len(json.dumps(workspace_context).encode("utf-8"))
                        except (TypeError, ValueError):
                            await send({"type": "error", "thread_id": thread_id,
                                        "message": "workspace_context not JSON-serializable"})
                            continue
                        if wc_size > MAX_WORKSPACE_CONTEXT_BYTES:
                            await send({"type": "error", "thread_id": thread_id,
                                        "message": "workspace_context too large"})
                            continue

                    run_id = str(uuid.uuid4())
                    rec = registry.register(thread_id, run_id, owner)
                    rec.task = asyncio.create_task(
                        run_agent_with_timeout(rec, prompt, workspace_context)
                    )
                    own_rec = rec
                    focus_rec = rec

                elif msg_type == "cancel":
                    requested = data.get("thread_id")
                    if requested is not None and not _valid_thread_id(requested):
                        await send({"type": "error", "message": "invalid thread_id"})
                        continue

                    if requested:
                        rec = lookup(requested)
                    else:
                        rec = focus_rec

                    if rec is None or not rec.is_active() or rec.terminal_type is not None:
                        frame = {"type": "cancelled", "already_finished": True}
                        if rec is not None:
                            frame["thread_id"] = rec.thread_id
                            frame["run_id"] = rec.run_id
                        elif requested:
                            frame["thread_id"] = requested
                        await send(frame)
                        continue

                    requested_run = data.get("run_id")
                    if requested_run and requested_run != rec.run_id:
                        await send({"type": "error", "thread_id": rec.thread_id,
                                    "run_id": rec.run_id,
                                    "message": "cancel does not match active run"})
                        continue

                    claimed = rec.claim({
                        "type": "cancelled",
                        "reason": "user",
                        "thread_id": rec.thread_id,
                        "run_id": rec.run_id,
                    }, reason="user")
                    if not claimed:
                        await send({"type": "cancelled", "thread_id": rec.thread_id,
                                    "run_id": rec.run_id, "already_finished": True})
                        continue

                    clean = await stop_run(rec)
                    await send(rec.terminal_event)
                    if not clean:
                        logger.error("closing socket: uncancellable task "
                                     "thread_id=%s run_id=%s",
                                     rec.thread_id, rec.run_id)
                        await websocket.close(code=1011)
                        break

                elif msg_type == "resume":
                    thread_id = data.get("thread_id")
                    if not _valid_thread_id(thread_id):
                        await send({"type": "error", "message": "invalid thread_id"})
                        continue

                    rec = lookup(thread_id)
                    if rec is None:
                        await send({"type": "error", "thread_id": thread_id,
                                    "message": "no resumable run for thread"})
                        continue

                    focus_rec = rec

                    if rec.is_active() and rec.terminal_type is None:
                        await send({"type": "error", "thread_id": thread_id,
                                    "run_id": rec.run_id,
                                    "message": "run still in progress"})
                        continue
                    if rec.cancel_reason == "user":
                        await send({"type": "error", "thread_id": thread_id,
                                    "message": "no resumable run for thread"})
                        continue
                    if rec.terminal_type in {"final", "failure"}:
                        await send({**rec.terminal_event, "replayed": True})
                        continue
                    await send({"type": "error", "thread_id": thread_id,
                                "message": "resume not implemented yet"})

                else:
                    await send({"type": "error",
                                "message": f"unknown message type: {msg_type}"})

            except Exception:
                logger.exception("unhandled error while processing message")
                await send({"type": "error", "message": "internal error"})

    except WebSocketDisconnect:
        logger.info("client disconnected")
    except Exception:
        logger.exception("websocket loop failed")
    finally:
        rec = own_rec
        if rec is not None and rec.is_active() and not rec.zombie:
            if registry.is_current(rec):
                rec.claim({
                    "type": "cancelled",
                    "reason": "disconnect",
                    "thread_id": rec.thread_id,
                    "run_id": rec.run_id,
                }, reason="disconnect")
            else:
                logger.warning("disconnect: record superseded thread_id=%s run_id=%s",
                               rec.thread_id, rec.run_id)
            if not await stop_run(rec):
                logger.error("zombie after disconnect thread_id=%s run_id=%s",
                             rec.thread_id, rec.run_id)