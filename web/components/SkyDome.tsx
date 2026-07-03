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

import { useEffect, useRef } from "react";
import { CLIENT_POLL_MS } from "@/lib/config";
import type { SkyObject, SkyResponse } from "@/lib/types";
import { SkyEngine } from "./sky/engine";
import { Hud } from "./sky/hud";

const FETCH_TIMEOUT_MS = 8_000;

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

  return <div ref={hostRef} style={{ position: "fixed", inset: 0 }} />;
}
