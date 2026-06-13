"""FastAPI app for sky-tracker.

On startup it launches three background tasks: TLE refresh, OpenSky polling, and
a broadcaster that computes positions every 5 seconds and pushes them to every
connected WebSocket client.
"""

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import data_fetcher
import position_engine

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("sky-tracker.main")

BROADCAST_INTERVAL_SECONDS = 5

# Currently connected WebSocket clients.
clients: set[WebSocket] = set()


def _snapshot() -> str:
    """Serialize the current sky into the wire format."""
    objects = position_engine.compute_positions(
        data_fetcher.tle_text, data_fetcher.plane_states
    )
    return json.dumps({"ts": int(time.time()), "objects": objects})


async def broadcaster() -> None:
    """Every BROADCAST_INTERVAL_SECONDS, push a fresh snapshot to all clients."""
    while True:
        if clients:
            try:
                message = _snapshot()
            except Exception as exc:  # noqa: BLE001 - keep the loop alive
                log.warning("position computation failed: %s", exc)
                message = None

            if message is not None:
                dead = []
                for ws in list(clients):
                    try:
                        await ws.send_text(message)
                    except Exception:  # noqa: BLE001 - drop broken sockets
                        dead.append(ws)
                for ws in dead:
                    clients.discard(ws)
        await asyncio.sleep(BROADCAST_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks = [
        asyncio.create_task(data_fetcher.tle_refresh_loop()),
        asyncio.create_task(data_fetcher.opensky_poll_loop()),
        asyncio.create_task(broadcaster()),
    ]
    log.info("Background tasks started")
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        log.info("Background tasks stopped")


app = FastAPI(title="sky-tracker", lifespan=lifespan)

# Permissive CORS so the frontend can be opened from file:// or any local origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def health():
    return {
        "status": "ok",
        "clients": len(clients),
        "tle_ready": data_fetcher.tle_ready.is_set(),
        "opensky_ready": data_fetcher.opensky_ready.is_set(),
        "planes_cached": len(data_fetcher.plane_states),
    }


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    log.info("client connected (%d total)", len(clients))
    try:
        # Send an immediate snapshot so the client need not wait a full cycle.
        await ws.send_text(_snapshot())
        # Block on receive purely to detect disconnects; we expect no input.
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        log.warning("websocket error: %s", exc)
    finally:
        clients.discard(ws)
        log.info("client disconnected (%d total)", len(clients))
