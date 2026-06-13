"""Position computation for sky-tracker.

Satellites: Skyfield turns Celestrak TLEs into topocentric az/alt for the
observer. Aircraft: OpenSky lat/lon/geometric-altitude are converted to az/alt
with a haversine ground distance and an atan2 elevation angle.

All functions take their input data as arguments so they stay pure and testable;
main.py wires in the live data from data_fetcher.
"""

import math

from skyfield.api import EarthSatellite, load, wgs84

import route_cache

# Observer location (Chicago).
OBS_LAT = 41.91734343314767
OBS_LON = -87.63808451349306
OBS_ELEV_M = 180.0

# Visibility thresholds, in degrees above the horizon.
SAT_MIN_ALT_DEG = 5.0
PLANE_MIN_ALT_DEG = 2.0

EARTH_RADIUS_M = 6371000.0
MS_TO_KNOTS = 1.94384

# Skyfield timescale and observer are reused across calls.
_ts = load.timescale()
_observer = wgs84.latlon(OBS_LAT, OBS_LON, elevation_m=OBS_ELEV_M)

# Parsed-satellite cache, keyed on the raw TLE text so we only re-parse when
# Celestrak hands us a fresh set.
_cached_tle_text = None
_cached_satellites: list = []


def _get_satellites(tle_text: str):
    """Parse three-line-element text into EarthSatellite objects, cached."""
    global _cached_tle_text, _cached_satellites
    if tle_text == _cached_tle_text:
        return _cached_satellites

    sats = []
    lines = [ln.rstrip() for ln in tle_text.strip().splitlines()]
    for i in range(0, len(lines) - 2, 3):
        name = lines[i].strip()
        line1 = lines[i + 1]
        line2 = lines[i + 2]
        # Sanity check that we are aligned on a real TLE triple.
        if not (line1.startswith("1 ") and line2.startswith("2 ")):
            continue
        try:
            sats.append(EarthSatellite(line1, line2, name, _ts))
        except Exception:  # noqa: BLE001 - skip malformed entries
            continue

    _cached_tle_text = tle_text
    _cached_satellites = sats
    return sats


def compute_satellite_positions(tle_text: str, t=None):
    """Return visible satellites as a list of object dicts."""
    sats = _get_satellites(tle_text or "")
    if not sats:
        return []

    if t is None:
        t = _ts.now()

    objects = []
    for sat in sats:
        topocentric = (sat - _observer).at(t)
        alt, az, _ = topocentric.altaz()
        if alt.degrees <= SAT_MIN_ALT_DEG:
            continue

        name = sat.name or str(sat.model.satnum)
        is_iss = "ISS" in name.upper()
        objects.append(
            {
                "id": "ISS" if is_iss else str(sat.model.satnum),
                "type": "sat",
                "az": round(az.degrees, 2),
                "alt": round(alt.degrees, 2),
                "name": name,
                "bright": 1.0,
            }
        )
    return objects


def _observer_az_alt(lat: float, lon: float, alt_m: float):
    """Azimuth and elevation angle from the observer to a point in the sky.

    Azimuth uses the initial great-circle bearing; the ground distance uses the
    haversine formula; elevation is atan2(height_above_observer, ground_distance).
    """
    phi1 = math.radians(OBS_LAT)
    phi2 = math.radians(lat)
    dphi = math.radians(lat - OBS_LAT)
    dlmb = math.radians(lon - OBS_LON)

    # Initial bearing (azimuth), normalized to [0, 360).
    y = math.sin(dlmb) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlmb)
    bearing = (math.degrees(math.atan2(y, x)) + 360.0) % 360.0

    # Great-circle ground distance (haversine).
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    ground = EARTH_RADIUS_M * c

    # Elevation angle above the observer's horizontal plane.
    dh = alt_m - OBS_ELEV_M
    elevation = math.degrees(math.atan2(dh, ground))
    return bearing, elevation


def compute_plane_positions(plane_states):
    """Convert OpenSky state rows into visible-plane object dicts."""
    objects = []
    for s in plane_states or []:
        # OpenSky state-vector field layout.
        icao24 = (s[0] or "").strip()
        callsign = (s[1] or "").strip()
        lon = s[5]
        lat = s[6]
        on_ground = s[8]
        velocity = s[9]      # m/s
        heading = s[10]      # degrees true
        geo_alt = s[13]      # meters above sea level

        if lat is None or lon is None or geo_alt is None or on_ground:
            continue

        az, alt = _observer_az_alt(lat, lon, geo_alt)
        if alt <= PLANE_MIN_ALT_DEG:
            continue

        obj = {
            "id": icao24 or callsign,
            "type": "plane",
            "az": round(az, 2),
            "alt": round(alt, 2),
            "speed": round(velocity * MS_TO_KNOTS) if velocity is not None else None,
            "heading": round(heading, 1) if heading is not None else None,
            "callsign": callsign or icao24,
        }

        # Attach origin/destination IATA codes if the route is cached. Pure
        # dict lookup, so this never blocks the WebSocket loop. Fields are
        # omitted when unavailable; the frontend handles their absence.
        route = route_cache.get_route(callsign)
        if route and route.get("origin_iata") and route.get("destination_iata"):
            obj["origin"] = route["origin_iata"]
            obj["destination"] = route["destination_iata"]

        objects.append(obj)
    return objects


def compute_positions(tle_text: str, plane_states):
    """Combined satellite + plane object list for one WebSocket frame."""
    return compute_satellite_positions(tle_text) + compute_plane_positions(plane_states)


if __name__ == "__main__":
    # Standalone smoke test: fetch a live TLE set and print visible satellites.
    import httpx

    from data_fetcher import CELESTRAK_URL, HTTP_HEADERS

    print(f"Observer: lat={OBS_LAT} lon={OBS_LON} elev={OBS_ELEV_M}m\n")
    print("Fetching TLEs from Celestrak...")
    text = httpx.get(
        CELESTRAK_URL, timeout=30.0, headers=HTTP_HEADERS, follow_redirects=True
    ).text
    total = len(text.strip().splitlines()) // 3
    print(f"  parsed {total} satellites\n")

    visible = compute_satellite_positions(text)
    print(f"Satellites currently above {SAT_MIN_ALT_DEG} deg: {len(visible)}")
    for obj in sorted(visible, key=lambda o: o["alt"], reverse=True)[:10]:
        print(
            f"  {obj['name']:25s} az={obj['az']:6.2f}  alt={obj['alt']:5.2f}"
            f"  id={obj['id']}"
        )
