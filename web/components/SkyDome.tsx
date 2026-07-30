"use client";

/**
 * SkyDome — client shell around the dome renderer.
 *
 * Replaces the legacy WebSocket with polling: fetch /api/sky every
 * CLIENT_POLL_MS and feed the snapshot to the engine; dead reckoning keeps
 * motion smooth between polls. Pauses cleanly when the tab is hidden, and is
 * strict-mode-safe (full teardown on unmount).
 *
 * The observer location is resolved on the client (URL params → this device's
 * stored location → browser geolocation → Chicago fallback, see lib/location)
 * and sent with every poll, because /api/sky computes satellite look angles,
 * plane az/alt and the sun/moon for whoever is asking.
 *
 * Debug hook (browser console) — window.skyTracker:
 *   skyTracker.stats()                 → { total, sat, plane, iss, lastTs }
 *   skyTracker.tracked                 → live Map of tracked records
 *   skyTracker.simulate([...objects])  → feed synthetic SkyObjects
 *   skyTracker.location()              → { observer, source } in use right now
 *   skyTracker.setLocation(lat, lon)   → move the observer (no reload)
 *
 * Ceiling-mirror eyeball check (CEILING_MIRROR = true): this plane sits at
 * the top (N) edge heading east — its chevron must point toward the E label
 * on the LEFT, and over repeated calls with growing az it drifts LEFT:
 *
 *   window.skyTracker.simulate([
 *     { type: "plane", id: "plane:test1", icao24: "test1", callsign: "TEST123",
 *       az: 10, alt: 55, altitudeM: 11000, speedKt: 450, heading: 90,
 *       verticalRateMs: 0, groundDistKm: 20, category: "large",
 *       origin: "ORD", destination: "LGA", originName: "Chicago",
 *       destinationName: "New York", airline: "Test Air" },
 *     { type: "sat", id: "sat:99999", noradId: 99999, name: "TESTSAT",
 *       az: 120, alt: 45, rangeKm: 550, sunlit: true, visibleNow: true,
 *       category: "payload", launchYear: 2020, isISS: false },
 *   ]);
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { CLIENT_POLL_MS } from "@/lib/config";
import {
  clearStoredLocation,
  DEFAULT_LOCATION,
  manualLocation,
  requestGeolocation,
  resolveKnownLocation,
  SOURCE_LABEL,
  storeLocation,
  type ResolvedLocation,
} from "@/lib/location";
import { formatCoords, sameObserver, type Observer } from "@/lib/observer";
import { resolveDisplayZone } from "@/lib/timezone";
import type { SkyObject, SkyResponse } from "@/lib/types";
import { SkyEngine } from "./sky/engine";
import { Hud } from "./sky/hud";

const FETCH_TIMEOUT_MS = 8_000;

/**
 * Two independent orientation controls plus a location control, stacked
 * top-right (the location one is documented at its own effect below):
 *
 * 1. "Rotate view" — whole-scene rotation (projector physically fixed; the
 *    image must re-orient). A single CSS rotate on the container that holds
 *    the canvas AND the DOM overlays: the transform makes the container the
 *    containing block for the HUD's position:fixed elements, so footer,
 *    spotlight card and buttons all pivot with the scene as one rigid unit —
 *    text included. Purely presentational — az/alt math, CEILING_MIRROR and
 *    the engine never see it. At 90°/270° the container's axes are swapped
 *    (100vh × 100vw, centered) so it still covers the viewport exactly and
 *    the corner overlays stay visible on a non-square screen; width/height
 *    animate together with the transform so the move is one smooth swing.
 *
 * 2. "Rotate map" — map/dome orientation only. A data-space azimuth offset
 *    inside lib/projection (see MAP ROTATION there): the sky field, object
 *    positions and the N/E/S/W ring step 90° per press while every piece of
 *    text stays upright — labels, card and footer only follow their objects'
 *    new anchor positions. For aiming "North" at any edge of the room.
 *
 * The two compose: view rotation spins the finished image, map rotation
 * re-aims the sky inside it. Each persists under its own key.
 */
const ROTATION_STORAGE_KEY = "sky-tracker:rotation";
const MAP_ROTATION_STORAGE_KEY = "sky-tracker:map-rotation";
const ROTATION_TRANSITION =
  "transform 350ms ease, width 350ms ease, height 350ms ease";

// The control cluster idles at full visibility so it can be spotted from
// across the room, then settles into the night sky after a quiet period.
// Any pointer contact or movement over it, keyboard focus, or activation
// (click bubbles from Enter/Space too) wakes it — and a press while dimmed
// still lands, since dimming is opacity-only.
const CONTROLS_DIM_DELAY_MS = 10_000;
const CONTROLS_DIM_OPACITY = 0.45;

const CONTROL_CHIP_STYLE: CSSProperties = {
  width: 46,
  height: 46,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 2,
  borderRadius: "50%",
  border: "1px solid rgba(190,205,230,0.45)",
  background: "rgba(14,20,32,0.78)",
  color: "rgba(222,232,250,0.92)",
  fontFamily: "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  cursor: "pointer",
};

const CONTROL_ICON_STYLE: CSSProperties = {
  fontSize: 17,
  lineHeight: "17px",
};

const CONTROL_CAPTION_STYLE: CSSProperties = {
  fontSize: 8,
  lineHeight: "9px",
  letterSpacing: "0.09em",
  opacity: 0.75,
};

// The location panel: same palette, border and font as the chips above it, so
// the cluster still reads as one control. Folded away by default — this is an
// ambient ceiling display, and the location is a one-time setup per device.
const PANEL_STYLE: CSSProperties = {
  width: 186,
  padding: "10px 11px",
  borderRadius: 12,
  border: "1px solid rgba(190,205,230,0.45)",
  background: "rgba(14,20,32,0.9)",
  color: "rgba(222,232,250,0.92)",
  fontFamily: "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  fontSize: 11,
  lineHeight: 1.5,
  display: "flex",
  flexDirection: "column",
  gap: 7,
};

const PANEL_SOURCE_STYLE: CSSProperties = {
  fontSize: 8,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  opacity: 0.6,
};

const PANEL_COORDS_STYLE: CSSProperties = {
  fontSize: 12,
  fontVariantNumeric: "tabular-nums",
};

const PANEL_FIELD_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "4px 6px",
  borderRadius: 6,
  border: "1px solid rgba(190,205,230,0.35)",
  background: "rgba(0,0,0,0.35)",
  color: "inherit",
  font: "inherit",
};

const PANEL_BUTTON_STYLE: CSSProperties = {
  padding: "5px 8px",
  borderRadius: 7,
  border: "1px solid rgba(190,205,230,0.35)",
  background: "rgba(255,255,255,0.06)",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

const PANEL_NOTE_STYLE: CSSProperties = {
  fontSize: 10,
  color: "rgba(224,176,80,0.8)",
};

/**
 * Read the stored map orientation synchronously (useState initializer), so
 * the mount-time persist effect can never transiently clobber a stored value
 * with the default. Safe here — unlike rotation.angle, mapQuarters never
 * appears in rendered DOM, so the server/client initial render still matches.
 */
function readStoredMapQuarters(): number {
  if (typeof window === "undefined") return 0;
  let stored = 0;
  try {
    stored = parseInt(
      localStorage.getItem(MAP_ROTATION_STORAGE_KEY) ?? "0",
      10
    );
  } catch {
    // Storage unavailable (privacy mode) — keep the default orientation.
  }
  return stored === 1 || stored === 2 || stored === 3 ? stored : 0;
}

/** fetch with a hard timeout (manual AbortController: AbortSignal.timeout and
 *  AbortSignal.any are missing from older Android WebViews). The observer
 *  travels as query params: the server needs it for the satellite look angles,
 *  the plane az/alt and the sun/moon, and cannot guess it. */
function fetchSky(
  observer: Observer
): { promise: Promise<SkyResponse>; abort: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  // 4 decimals is ~11 m, far finer than a dome 46 km across can show, and
  // deliberately no finer: these coordinates are somebody's location and a
  // query string ends up in whatever access log sits in front of the app, which
  // is the one place this code cannot control (the handler itself refuses to log
  // them). Rounding here is the cheap half of that problem.
  const query = new URLSearchParams({
    lat: observer.lat.toFixed(4),
    lon: observer.lon.toFixed(4),
    elev: observer.elevationM.toFixed(0),
  });
  const promise = fetch(`/api/sky?${query}`, {
    cache: "no-store",
    signal: ctrl.signal,
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<SkyResponse>;
    })
    .finally(() => clearTimeout(timer));
  return { promise, abort: () => ctrl.abort() };
}

declare global {
  interface Window {
    skyTracker?: {
      tracked: SkyEngine["tracked"];
      stats: () => ReturnType<SkyEngine["stats"]>;
      simulate: (objects: SkyObject[]) => void;
      location: () => ResolvedLocation | null;
      setLocation: (lat: number, lon: number) => boolean;
    };
  }
}

export default function SkyDome() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SkyEngine | null>(null);

  // Cumulative clockwise angle. Kept monotonic (0, 90, 180, 270, 360, ...) so
  // every press animates a further 90° clockwise instead of unwinding at the
  // 270° → 0° wrap; localStorage holds angle % 360. `animate` stays false
  // until the first press so the restored orientation applies instantly on
  // load rather than as a spin.
  const [rotation, setRotation] = useState({ angle: 0, animate: false });

  // Map/dome orientation in screen-clockwise quarter turns (0–3).
  const [mapQuarters, setMapQuarters] = useState(readStoredMapQuarters);

  // Where this dome is looking up from. Null until the mount-time resolution
  // finishes — URL params and this device's stored location are synchronous,
  // only a first-time visitor waits on geolocation. Resolved into state rather
  // than a useState initializer because the panel renders coordinates: a
  // synchronous read of localStorage would make the server and client's first
  // render disagree.
  const [location, setLocation] = useState<ResolvedLocation | null>(null);
  const locationRef = useRef<ResolvedLocation | null>(null);
  const observerRef = useRef<Observer | null>(null);
  const zoneRef = useRef<string | null>(null);
  const locationAppliedRef = useRef(false);

  // Set by the engine effect so the location effect can reach the live Hud and
  // force a poll without owning (or remounting) either.
  const hudRef = useRef<Hud | null>(null);
  const pollRef = useRef<((force?: boolean) => void) | null>(null);

  // Location panel state (folded away by default).
  const [panelOpen, setPanelOpen] = useState(false);
  const [latField, setLatField] = useState("");
  const [lonField, setLonField] = useState("");
  const [fieldError, setFieldError] = useState(false);
  const [geoState, setGeoState] = useState<"idle" | "asking" | "failed">("idle");
  // Identifies the newest "Use my location" request, so a slow fix that lands
  // after the user has chosen something else is discarded rather than applied.
  const geoRequestRef = useRef(0);

  /** Adopt a location. A no-op change is dropped so that an equal-but-new
   *  object cannot re-fire the effect that wipes and refetches the sky. */
  const applyLocation = useCallback((next: ResolvedLocation) => {
    setLocation((prev) =>
      prev &&
      prev.source === next.source &&
      sameObserver(prev.observer, next.observer)
        ? prev
        : next
    );
  }, []);

  // Controls stay bright until CONTROLS_DIM_DELAY_MS of quiet, then dim.
  const [controlsDimmed, setControlsDimmed] = useState(false);
  const dimTimerRef = useRef<number | null>(null);

  const wakeControls = useCallback(() => {
    setControlsDimmed(false);
    if (dimTimerRef.current !== null) window.clearTimeout(dimTimerRef.current);
    dimTimerRef.current = window.setTimeout(
      () => setControlsDimmed(true),
      CONTROLS_DIM_DELAY_MS
    );
  }, []);

  useEffect(() => {
    wakeControls(); // arm the initial settle-down timer
    return () => {
      if (dimTimerRef.current !== null)
        window.clearTimeout(dimTimerRef.current);
    };
  }, [wakeControls]);

  useEffect(() => {
    let stored = 0;
    try {
      stored = parseInt(localStorage.getItem(ROTATION_STORAGE_KEY) ?? "0", 10);
    } catch {
      // Storage unavailable (privacy mode) — keep the default orientation.
    }
    if (stored === 90 || stored === 180 || stored === 270) {
      setRotation({ angle: stored, animate: false });
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ROTATION_STORAGE_KEY, String(rotation.angle % 360));
    } catch {
      // Best-effort persistence only.
    }
  }, [rotation.angle]);

  // Resolve where we are, once: URL params → this device's stored location →
  // browser geolocation → the Chicago fallback.
  useEffect(() => {
    let cancelled = false;
    const known = resolveKnownLocation();
    if (known) {
      applyLocation(known);
      return;
    }
    void requestGeolocation().then((geo) => {
      if (!cancelled) applyLocation(geo ?? DEFAULT_LOCATION);
    });
    return () => {
      cancelled = true;
    };
  }, [applyLocation]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const engine = new SkyEngine(host);
    engineRef.current = engine;
    const hud = new Hud(
      host,
      () => engine.spotlightCandidates(),
      () => engine.stats()
    );
    hudRef.current = hud;
    // A brand-new Hud (first mount, or strict mode's second) has to be told
    // what the already-resolved location effect will not repeat for it.
    const resolved = locationRef.current;
    if (resolved) hud.setLocationLabel(SOURCE_LABEL[resolved.source]);
    hud.setTimeZone(zoneRef.current);

    let disposed = false;
    let pollTimer: number | null = null;
    let failing = false;
    // The observer can change between polls, so a response that arrives after a
    // change has to be dropped: ingesting it would repopulate the dome with the
    // old location's objects and hand dead reckoning a velocity sample taken
    // straight across the discontinuity.
    let generation = 0;
    let request: { generation: number; abort: () => void } | null = null;

    async function poll(force = false): Promise<void> {
      const observer = observerRef.current;
      if (disposed || !observer) return; // no location resolved yet
      if (request) {
        if (!force) return; // one poll in flight is enough
        request.abort(); // location changed: that answer is about the old sky
        request = null;
      }
      const mine = ++generation;
      const { promise, abort } = fetchSky(observer);
      request = { generation: mine, abort };
      try {
        const snapshot = await promise;
        if (disposed || mine !== generation) return;
        engine.ingest(snapshot);
        hud.setSnapshot(snapshot);
        if (failing) {
          failing = false;
          console.log("[sky-tracker] /api/sky recovered");
        }
      } catch (err) {
        if (disposed || mine !== generation) return;
        if (!failing) {
          failing = true;
          console.warn(
            "[sky-tracker] /api/sky fetch failed; will keep polling —",
            err
          );
        }
      } finally {
        if (request?.generation === mine) request = null;
      }
    }

    const triggerPoll = (force?: boolean): void => void poll(force);
    pollRef.current = triggerPoll;

    function startPolling(): void {
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(() => void poll(), CLIENT_POLL_MS);
    }

    function stopPolling(): void {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    void poll();
    startPolling();

    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        engine.pause();
        stopPolling();
      } else {
        engine.resume();
        // Forced: a request issued before the tab was hidden may still be
        // sitting there (a frozen tab does not even run its timeout), and an
        // unforced poll would be dropped and leave the dome stale for another
        // full interval.
        void poll(true);
        startPolling();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const debugHook = {
      tracked: engine.tracked,
      stats: () => engine.stats(),
      simulate: (objects: SkyObject[]) => {
        // Keep the staleness dot green while playing with synthetic data.
        engine.ingest({ ts: Math.floor(Date.now() / 1000), objects });
      },
      location: () => locationRef.current,
      setLocation: (lat: number, lon: number): boolean => {
        const next = manualLocation(String(lat), String(lon));
        if (!next) {
          console.warn("[sky-tracker] setLocation: coordinates out of range");
          return false;
        }
        applyLocation(next);
        return true;
      },
    };
    window.skyTracker = debugHook;

    return () => {
      disposed = true;
      stopPolling();
      request?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      if (window.skyTracker === debugHook) delete window.skyTracker;
      if (engineRef.current === engine) engineRef.current = null;
      if (hudRef.current === hud) hudRef.current = null;
      if (pollRef.current === triggerPoll) pollRef.current = null;
      hud.destroy();
      engine.destroy();
    };
  }, [applyLocation]);

  // Apply + persist the map orientation. Declared after the engine effect so
  // the mount-time run sees a live engine; state comes pre-hydrated from the
  // initializer, so this run applies the stored orientation (and re-syncs the
  // module-level projection offset after a hot reload) — it never writes a
  // value other than the one just read.
  useEffect(() => {
    engineRef.current?.setMapRotationQuarters(mapQuarters);
    try {
      localStorage.setItem(MAP_ROTATION_STORAGE_KEY, String(mapQuarters));
    } catch {
      // Best-effort persistence only.
    }
  }, [mapQuarters]);

  /**
   * Apply a resolved location: remember it, persist it, tell the HUD, and
   * refetch immediately. Declared after the engine effect so hudRef/pollRef are
   * live the first time it runs.
   *
   * The engine is NOT recreated — that would drop the WebGL context and flash
   * the projector black. Only its tracked objects go, because az/alt are
   * topocentric: an object's position from the old location is meaningless at
   * the new one, and letting ingest() see both would read the jump as velocity.
   */
  useEffect(() => {
    if (!location) return;
    observerRef.current = location.observer;
    locationRef.current = location;

    // A chosen location is remembered; falling back to the default instead
    // forgets, so a later load can try geolocation again.
    if (location.source === "default") clearStoredLocation();
    else storeLocation(location);

    // The first resolution just fills an empty dome. A later change has the old
    // sky on screen, which must go before the new snapshot lands.
    if (locationAppliedRef.current) {
      engineRef.current?.resetTracked();
      hudRef.current?.clearSpotlight();
    }
    locationAppliedRef.current = true;
    hudRef.current?.setLocationLabel(SOURCE_LABEL[location.source]);
    pollRef.current?.(true);

    // The clock follows the sky, not the room. Resolving a zone for custom
    // coordinates needs a lazy import, so it lands a moment later.
    let cancelled = false;
    void resolveDisplayZone(location).then((zone) => {
      if (cancelled) return;
      zoneRef.current = zone;
      hudRef.current?.setTimeZone(zone);
    });
    return () => {
      cancelled = true;
    };
  }, [location]);

  const openPanel = useCallback(() => {
    const current = locationRef.current;
    setLatField(current ? current.observer.lat.toFixed(4) : "");
    setLonField(current ? current.observer.lon.toFixed(4) : "");
    setFieldError(false);
    setGeoState("idle");
    setPanelOpen(true);
  }, []);

  const applyTypedCoordinates = useCallback(() => {
    geoRequestRef.current++; // supersede any pending "Use my location"
    const next = manualLocation(latField, lonField);
    if (!next) {
      setFieldError(true);
      return;
    }
    setFieldError(false);
    applyLocation(next);
    setPanelOpen(false);
  }, [applyLocation, latField, lonField]);

  const useDeviceLocation = useCallback(() => {
    // A geolocation fix can take ten seconds behind a permission prompt, and the
    // user may well pick something else in the meantime. Stamp the request and
    // drop a result that a later choice has already superseded — otherwise the
    // late fix silently overwrites (and persists over) what they chose.
    const mine = ++geoRequestRef.current;
    setGeoState("asking");
    void requestGeolocation().then((geo) => {
      if (mine !== geoRequestRef.current) return;
      if (!geo) {
        setGeoState("failed");
        return;
      }
      setGeoState("idle");
      applyLocation(geo);
      setPanelOpen(false);
    });
  }, [applyLocation]);

  const useDefaultLocation = useCallback(() => {
    geoRequestRef.current++; // supersede any pending "Use my location"
    applyLocation(DEFAULT_LOCATION);
    setPanelOpen(false);
  }, [applyLocation]);

  const orientation = ((rotation.angle % 360) + 360) % 360;
  const swapped = orientation === 90 || orientation === 270;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "#000",
      }}
    >
      <div
        ref={hostRef}
        className="sky-rotator"
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: swapped ? "100vh" : "100vw",
          height: swapped ? "100vw" : "100vh",
          transform: `translate(-50%, -50%) rotate(${rotation.angle}deg)`,
          transition: rotation.animate ? ROTATION_TRANSITION : "none",
        }}
      >
        <div
          onPointerEnter={wakeControls}
          onPointerMove={wakeControls}
          onPointerDown={wakeControls}
          onClick={wakeControls}
          onFocus={wakeControls}
          style={{
            // Top-right: the spotlight card owns the bottom-right corner.
            // One stacked cluster so both orientation controls are found
            // together at a glance.
            position: "absolute",
            top: 12,
            right: 12,
            zIndex: 20,
            display: "flex",
            flexDirection: "column",
            // Right-aligned rather than centered so the wider location panel
            // hangs under the chips without pushing them off the edge.
            alignItems: "flex-end",
            gap: 10,
            // An open panel is active use: it must not fade mid-edit.
            opacity: controlsDimmed && !panelOpen ? CONTROLS_DIM_OPACITY : 1,
            transition: "opacity 700ms ease",
          }}
        >
          <button
            type="button"
            onClick={() =>
              setRotation((prev) => ({ angle: prev.angle + 90, animate: true }))
            }
            aria-label="Rotate view: turn the whole display 90° clockwise, text included"
            title="Rotate view — turn the whole display 90°; text turns with it"
            style={CONTROL_CHIP_STYLE}
          >
            <span aria-hidden="true" style={CONTROL_ICON_STYLE}>
              ⟳
            </span>
            <span aria-hidden="true" style={CONTROL_CAPTION_STYLE}>
              VIEW
            </span>
          </button>
          <button
            type="button"
            onClick={() => setMapQuarters((prev) => (prev + 1) % 4)}
            aria-label="Rotate map: turn the sky and compass 90° clockwise, text stays upright"
            title="Rotate map — turn the sky and N/E/S/W 90°; text stays upright"
            style={CONTROL_CHIP_STYLE}
          >
            <span
              aria-hidden="true"
              style={{ ...CONTROL_ICON_STYLE, fontSize: 14 }}
            >
              N⟳
            </span>
            <span aria-hidden="true" style={CONTROL_CAPTION_STYLE}>
              MAP
            </span>
          </button>
          <button
            type="button"
            onClick={() => (panelOpen ? setPanelOpen(false) : openPanel())}
            aria-expanded={panelOpen}
            aria-label="Location: choose which sky this dome shows"
            title="Location — which sky this dome shows"
            style={CONTROL_CHIP_STYLE}
          >
            <span aria-hidden="true" style={CONTROL_ICON_STYLE}>
              ◎
            </span>
            <span aria-hidden="true" style={CONTROL_CAPTION_STYLE}>
              LOC
            </span>
          </button>
          {panelOpen && (
            <div style={PANEL_STYLE}>
              <div>
                <div style={PANEL_SOURCE_STYLE}>
                  {location ? SOURCE_LABEL[location.source] : "locating…"}
                </div>
                <div style={PANEL_COORDS_STYLE}>
                  {location ? formatCoords(location.observer) : "—"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={latField}
                  onChange={(e) => setLatField(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyTypedCoordinates();
                  }}
                  inputMode="text"
                  placeholder="lat"
                  aria-label="Latitude, degrees north"
                  style={PANEL_FIELD_STYLE}
                />
                <input
                  value={lonField}
                  onChange={(e) => setLonField(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyTypedCoordinates();
                  }}
                  inputMode="text"
                  placeholder="lon"
                  aria-label="Longitude, degrees east"
                  style={PANEL_FIELD_STYLE}
                />
              </div>
              {fieldError && (
                <div style={PANEL_NOTE_STYLE}>
                  lat −90…90, lon −180…180
                </div>
              )}
              <button
                type="button"
                onClick={applyTypedCoordinates}
                style={PANEL_BUTTON_STYLE}
              >
                Show this sky
              </button>
              <button
                type="button"
                onClick={useDeviceLocation}
                style={PANEL_BUTTON_STYLE}
              >
                {geoState === "asking" ? "Locating…" : "Use my location"}
              </button>
              {geoState === "failed" && (
                <div style={PANEL_NOTE_STYLE}>
                  location unavailable — unchanged
                </div>
              )}
              <button
                type="button"
                onClick={useDefaultLocation}
                title="Forget this device's location and fall back to Chicago. A later load will try your browser location again."
                style={PANEL_BUTTON_STYLE}
              >
                Reset to default
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
