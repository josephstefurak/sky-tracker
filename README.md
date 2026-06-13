# sky-tracker

Real-time overhead sky visualization: live satellite (Celestrak TLEs) and
aircraft (OpenSky) positions drawn as glowing dots on a black dome canvas,
intended for ceiling projection.

Observer is fixed at lat `41.91734343314767`, lon `-87.63808451349306`,
elevation 180 m (Chicago).

## Run locally

Two processes: the FastAPI backend and a static file server for the frontend.

### 1. Backend (WebSocket + data fetching)

```bash
cd backend
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8080
```

Sanity checks:
- `GET http://localhost:8080/` → health JSON
- `position_engine.py` and `data_fetcher.py` can be run directly
  (`.venv/bin/python position_engine.py`) to print sample positions.

### 2. Frontend (static server)

The frontend uses ES modules + an import map, so it **must be served over
HTTP** — opening `index.html` from `file://` is blocked by the browser's
module CORS policy. Any static server works:

```bash
cd frontend
python -m http.server 5500
```

Then open <http://localhost:5500/>.

`WS_URL` at the top of `frontend/main.js` points at `ws://localhost:8080/ws`.
Swap it to `wss://<host>/ws` when the backend is deployed.

## Notes

- Celestrak's legacy `pub/TLE/visual.txt` path now returns 403; the backend
  uses the current GP query API (`gp.php?GROUP=visual&FORMAT=tle`) for the same
  visual satellite group.
- OpenSky's anonymous endpoint is rate-limited; occasional empty polls are
  expected and the loops keep running.
- `backend/Dockerfile` is provided for later Cloud Run deployment but is not
  deployed yet.
- In the browser console, `skyTracker.stats()` reports connection state and
  the count of tracked satellites/planes.
