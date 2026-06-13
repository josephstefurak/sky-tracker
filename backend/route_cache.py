"""Flight-route enrichment via adsbdb.

For each callsign seen in the OpenSky feed we look up origin/destination from the
free, no-auth adsbdb API and cache the result in memory. Lookups run as
fire-and-forget asyncio tasks so the WebSocket loop never blocks on the network.

Cache policy:
  - Positive results are kept permanently (a route doesn't change mid-flight).
  - Negative results (no route, e.g. military/private) are kept for 2 hours so we
    don't re-query on every sighting.
  - Transient errors (timeouts, 429, 5xx) are NOT cached, so they retry on the
    next sighting.
"""

import asyncio
import logging
import time

import httpx

log = logging.getLogger("sky-tracker.route_cache")

ADSBDB_URL = "https://api.adsbdb.com/v0/callsign/{cs}"
NEGATIVE_TTL_SECONDS = 2 * 60 * 60
HTTP_HEADERS = {"User-Agent": "sky-tracker/1.0 (local testing)"}

# callsign -> positive route dict, or {"negative": True, "fetched_at": ts}
_routes: dict = {}
# callsigns with an in-flight fetch, to avoid duplicate concurrent lookups
_inflight: set = set()
# Lazily created inside the running event loop.
_client: httpx.AsyncClient = None


def get_route(callsign: str):
    """Return the cached route dict for a callsign, or None if unknown/negative.

    Pure lookup — safe to call from the (non-async) position-building path.
    """
    cs = (callsign or "").strip().upper()
    if not cs:
        return None
    entry = _routes.get(cs)
    if not entry or entry.get("negative"):
        return None
    return entry


def _needs_fetch(cs: str) -> bool:
    entry = _routes.get(cs)
    if entry is None:
        return True
    if entry.get("negative"):
        return (time.time() - entry["fetched_at"]) > NEGATIVE_TTL_SECONDS
    return False  # positive results are permanent


async def _fetch_route(cs: str) -> None:
    global _client
    try:
        if _client is None:
            _client = httpx.AsyncClient(
                headers=HTTP_HEADERS, follow_redirects=True, timeout=15.0
            )
        resp = await _client.get(ADSBDB_URL.format(cs=cs))

        # adsbdb returns 404 for callsigns it has no route for.
        if resp.status_code == 404:
            _routes[cs] = {"negative": True, "fetched_at": time.time()}
            return
        resp.raise_for_status()

        response = resp.json().get("response")
        flightroute = response.get("flightroute") if isinstance(response, dict) else None
        if not flightroute:
            _routes[cs] = {"negative": True, "fetched_at": time.time()}
            return

        origin = flightroute.get("origin") or {}
        destination = flightroute.get("destination") or {}
        _routes[cs] = {
            "origin_iata": origin.get("iata_code"),
            "origin_name": origin.get("name"),
            "destination_iata": destination.get("iata_code"),
            "destination_name": destination.get("name"),
            "fetched_at": time.time(),
        }
        log.info(
            "route %s: %s -> %s",
            cs,
            origin.get("iata_code"),
            destination.get("iata_code"),
        )
    except Exception as exc:  # noqa: BLE001 - transient errors stay uncached
        log.debug("route fetch failed for %s: %s", cs, exc)
    finally:
        _inflight.discard(cs)


def ensure_route(callsign: str) -> None:
    """Schedule a background route fetch for a callsign if it isn't cached yet."""
    cs = (callsign or "").strip().upper()
    if not cs or cs in _inflight or not _needs_fetch(cs):
        return
    _inflight.add(cs)
    try:
        asyncio.create_task(_fetch_route(cs))
    except RuntimeError:
        # No running event loop (called outside async context); nothing to do.
        _inflight.discard(cs)


if __name__ == "__main__":
    # Standalone smoke test: look up a couple of callsigns.
    logging.basicConfig(level=logging.INFO)

    async def _main() -> None:
        for cs in ["UAL304", "AAL100", "ZZZZZZ"]:
            ensure_route(cs)
        await asyncio.sleep(5)  # let the background tasks finish
        for cs in ["UAL304", "AAL100", "ZZZZZZ"]:
            print(f"{cs}: {get_route(cs)}")

    asyncio.run(_main())
