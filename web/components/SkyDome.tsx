"use client";

/**
 * SkyDome — client shell around the dome renderer.
 *
 * Replaces the legacy WebSocket with polling: fetch /api/sky every
 * CLIENT_POLL_MS and feed the snapshot to the engine; dead reckoning keeps
 * motion smooth between polls. Pauses cleanly when the tab is hidden, and is
 * strict-mode-safe (full teardown on unmount).
 *
 * Debug hook (browser console) — window.skyTracker:
 *   skyTracker.stats()                 → { total, sat, plane, iss, lastTs }
 *   skyTracker.tracked                 → live Map of tracked records
 *   skyTracker.simulate([...objects])  → feed synthetic SkyObjects
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

import { useEffect, useRef, useState } from "react";
import { CLIENT_POLL_MS } from "@/lib/config";
import type { SkyObject, SkyResponse } from "@/lib/types";
import { SkyEngine } from "./sky/engine";
import { Hud } from "./sky/hud";

const FETCH_TIMEOUT_MS = 8_000;

/**
 * Screen rotation (projector physically fixed; the image must re-orient).
 *
 * A single CSS rotate on the container that holds the canvas AND the DOM
 * overlays: the transform makes the container the containing block for the
 * HUD's position:fixed elements, so footer, spotlight card and button all
 * pivot with the scene as one rigid unit. Purely presentational — az/alt
 * math, CEILING_MIRROR and the engine never see it.
 *
 * At 90°/270° the container's axes are swapped (100vh × 100vw, centered) so
 * it still covers the viewport exactly and the corner overlays stay visible
 * on a non-square screen; width/height animate together with the transform
 * so the whole move is one smooth swing.
 */
const ROTATION_STORAGE_KEY = "sky-tracker:rotation";
const ROTATION_TRANSITION =
  "transform 350ms ease, width 350ms ease, height 350ms ease";

/** fetch with a hard timeout (manual AbortController: AbortSignal.timeout and
 *  AbortSignal.any are missing from older Android WebViews). */
function fetchSky(): { promise: Promise<SkyResponse>; abort: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const promise = fetch("/api/sky", { cache: "no-store", signal: ctrl.signal })
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
    };
  }
}

export default function SkyDome() {
  const hostRef = useRef<HTMLDivElement>(null);

  // Cumulative clockwise angle. Kept monotonic (0, 90, 180, 270, 360, ...) so
  // every press animates a further 90° clockwise instead of unwinding at the
  // 270° → 0° wrap; localStorage holds angle % 360. `animate` stays false
  // until the first press so the restored orientation applies instantly on
  // load rather than as a spin.
  const [rotation, setRotation] = useState({ angle: 0, animate: false });

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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const engine = new SkyEngine(host);
    const hud = new Hud(
      host,
      () => engine.spotlightCandidates(),
      () => engine.stats()
    );

    let disposed = false;
    let pollTimer: number | null = null;
    let abortInFlight: (() => void) | null = null;
    let inFlight = false;
    let failing = false;

    async function poll(): Promise<void> {
      if (disposed || inFlight) return;
      inFlight = true;
      const { promise, abort } = fetchSky();
      abortInFlight = abort;
      try {
        const snapshot = await promise;
        if (disposed) return;
        engine.ingest(snapshot);
        hud.setSnapshot(snapshot);
        if (failing) {
          failing = false;
          console.log("[sky-tracker] /api/sky recovered");
        }
      } catch (err) {
        if (disposed) return;
        if (!failing) {
          failing = true;
          console.warn(
            "[sky-tracker] /api/sky fetch failed; will keep polling —",
            err
          );
        }
      } finally {
        inFlight = false;
        abortInFlight = null;
      }
    }

    function startPolling(): void {
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(poll, CLIENT_POLL_MS);
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
        void poll(); // refresh immediately on return
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
    };
    window.skyTracker = debugHook;

    return () => {
      disposed = true;
      stopPolling();
      abortInFlight?.();
      document.removeEventListener("visibilitychange", onVisibility);
      if (window.skyTracker === debugHook) delete window.skyTracker;
      hud.destroy();
      engine.destroy();
    };
  }, []);

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
        <button
          type="button"
          onClick={() =>
            setRotation((prev) => ({ angle: prev.angle + 90, animate: true }))
          }
          aria-label="Rotate display 90° clockwise"
          title="Rotate display 90° clockwise"
          style={{
            // Top-right: the spotlight card owns the bottom-right corner.
            position: "absolute",
            top: 12,
            right: 14,
            zIndex: 20,
            width: 34,
            height: 34,
            padding: 0,
            borderRadius: "50%",
            border: "1px solid rgba(190,205,230,0.22)",
            background: "rgba(8,12,20,0.55)",
            color: "rgba(190,205,230,0.6)",
            font: "16px/1 -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
            cursor: "pointer",
          }}
        >
          ⟳
        </button>
      </div>
    </div>
  );
}
