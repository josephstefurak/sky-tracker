"""Background data fetchers for sky-tracker.

Two sources:
  - Celestrak visual.txt TLEs, refreshed every 6 hours.
  - OpenSky Network live aircraft over a Chicago bounding box, polled every 10s.

Results are stored in module-level variables that the position engine reads.
The fetch functions are designed to run as long-lived asyncio tasks.
"""

import asyncio
import logging

import httpx

log = logging.getLogger("sky-tracker.data_fetcher")

# Celestrak's legacy /pub/TLE/visual.txt path now returns 403; the GP query API
# is the current supported endpoint for the same "visual" satellite group.
CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle"
OPENSKY_URL = (
    "https://opensky-network.org/api/states/all"
    "?lamin=41.5&lomin=-88.0&lamax=42.3&lomax=-87.0"
)

# Celestrak rejects requests without a User-Agent; OpenSky is fine either way.
HTTP_HEADERS = {"User-Agent": "sky-tracker/1.0 (local testing)"}

TLE_REFRESH_SECONDS = 6 * 60 * 60
OPENSKY_POLL_SECONDS = 10

# Module-level state, updated in place by the background tasks below.
# tle_text: raw three-line-element text as returned by Celestrak.
# plane_states: list of OpenSky "states" rows (each a list of fields).
tle_text: str = ""
plane_states: list = []

# Set once the first successful fetch of each source completes.
tle_ready = asyncio.Event()
opensky_ready = asyncio.Event()


async def _fetch_tle(client: httpx.AsyncClient) -> None:
    """Fetch the Celestrak visual TLE set into the module-level cache."""
    global tle_text
    resp = await client.get(CELESTRAK_URL, timeout=30.0)
    resp.raise_for_status()
    tle_text = resp.text
    count = len(tle_text.strip().splitlines()) // 3
    log.info("Fetched %d TLEs from Celestrak", count)
    tle_ready.set()


async def tle_refresh_loop() -> None:
    """Refresh TLEs immediately, then every TLE_REFRESH_SECONDS."""
    async with httpx.AsyncClient(headers=HTTP_HEADERS, follow_redirects=True) as client:
        while True:
            try:
                await _fetch_tle(client)
            except Exception as exc:  # noqa: BLE001 - keep the loop alive
                log.warning("TLE fetch failed: %s", exc)
            await asyncio.sleep(TLE_REFRESH_SECONDS)


async def _fetch_opensky(client: httpx.AsyncClient) -> None:
    """Fetch current aircraft states for the Chicago bounding box."""
    global plane_states
    resp = await client.get(OPENSKY_URL, timeout=30.0)
    resp.raise_for_status()
    data = resp.json()
    states = data.get("states") or []
    plane_states = states
    log.info("Fetched %d aircraft from OpenSky", len(states))
    opensky_ready.set()


async def opensky_poll_loop() -> None:
    """Poll OpenSky immediately, then every OPENSKY_POLL_SECONDS."""
    async with httpx.AsyncClient(headers=HTTP_HEADERS, follow_redirects=True) as client:
        while True:
            try:
                await _fetch_opensky(client)
            except Exception as exc:  # noqa: BLE001 - keep the loop alive
                log.warning("OpenSky fetch failed: %s", exc)
            await asyncio.sleep(OPENSKY_POLL_SECONDS)


if __name__ == "__main__":
    # Quick standalone smoke test: fetch each source once and report.
    logging.basicConfig(level=logging.INFO)

    async def _main() -> None:
        async with httpx.AsyncClient(headers=HTTP_HEADERS, follow_redirects=True) as client:
            print("Fetching TLEs from Celestrak...")
            await _fetch_tle(client)
            lines = tle_text.strip().splitlines()
            print(f"  {len(lines) // 3} satellites; first entry:")
            for line in lines[:3]:
                print(f"    {line}")

            print("\nFetching aircraft from OpenSky...")
            await _fetch_opensky(client)
            print(f"  {len(plane_states)} aircraft in Chicago bounding box")
            for s in plane_states[:5]:
                callsign = (s[1] or "").strip()
                lat, lon, geo_alt = s[6], s[5], s[13]
                print(f"    {callsign:8s} lat={lat} lon={lon} geo_alt={geo_alt}")

    asyncio.run(_main())
