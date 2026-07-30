/**
 * DOM overlay HUD: legend + status line (bottom-left) and the rotating
 * spotlight card (bottom-right). Pure DOM, updated via direct mutation on a
 * 1 Hz tick and a 12 s spotlight rotation — never per-frame React state.
 * Styling is dim and ambient: this shares a ceiling with the night sky.
 */

import { formatClock } from "@/lib/timezone";
import type { PlaneObject, SatObject, SkyResponse } from "@/lib/types";
import type { EngineStats, TrackedRecord } from "./engine";

const SPOTLIGHT_ROTATE_MS = 12_000;
const SPOTLIGHT_FADE_MS = 300;

const SAT_CATEGORY_LABEL: Record<SatObject["category"], string> = {
  station: "Station",
  payload: "Satellite",
  "rocket-body": "Rocket body",
  debris: "Debris",
};

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function div(cssText: string, parent?: HTMLElement): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = cssText;
  parent?.appendChild(el);
  return el;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly statusLine: HTMLDivElement;
  private readonly stalenessDot: HTMLSpanElement;
  private readonly degradedLine: HTMLDivElement;

  private readonly card: HTMLDivElement;
  private readonly cardPhoto: HTMLImageElement;
  private readonly cardTitle: HTMLDivElement;
  private readonly cardLines: HTMLDivElement[];
  private readonly cardAccent: HTMLDivElement;

  private snapshot: SkyResponse | null = null;
  private spotIndex = -1;
  private cardShown = false;

  /** IANA zone for the footer clock; null → UTC, explicitly labeled. */
  private timeZone: string | null = null;
  /** Which location source is in use, e.g. "your location". */
  private locationLabel = "";

  private readonly tickTimer: number;
  private readonly rotateTimer: number;
  private fadeTimeout: number | null = null;

  constructor(
    host: HTMLElement,
    private readonly getCandidates: () => TrackedRecord[],
    private readonly getStats: () => EngineStats
  ) {
    // ---- Legend + status (bottom-left) ----
    this.root = div(
      [
        "position:fixed",
        "left:14px",
        "bottom:12px",
        "z-index:10",
        "font:12px -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
        "line-height:1.6",
        "pointer-events:none",
        "user-select:none",
      ].join(";"),
      host
    );

    const legend = div("opacity:0.75", this.root);
    legend.innerHTML =
      '<div style="color:#aaaacc">● satellite</div>' +
      '<div style="color:#e4eeff">✦ visible now</div>' +
      '<div style="color:#ffd700">● ISS</div>' +
      '<div style="color:#ffa040">▶ plane</div>' +
      '<div style="color:#ffa040">◉ helicopter</div>';

    this.statusLine = div(
      "margin-top:6px;color:rgba(190,205,230,0.55)",
      this.root
    );
    this.stalenessDot = document.createElement("span");
    this.stalenessDot.style.cssText =
      "display:inline-block;width:7px;height:7px;border-radius:50%;" +
      "margin-left:8px;background:#666a75;vertical-align:0";
    this.degradedLine = div(
      "margin-top:2px;color:rgba(224,176,80,0.6);font-size:11px;max-width:46vw;display:none",
      this.root
    );

    // ---- Spotlight card (bottom-right) ----
    this.card = div(
      [
        "position:fixed",
        "right:14px",
        "bottom:12px",
        "z-index:10",
        "max-width:340px",
        "padding:12px 14px",
        "border-radius:10px",
        "background:rgba(8,12,20,0.72)",
        "font:14px -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
        "pointer-events:none",
        "user-select:none",
        "opacity:0",
        `transition:opacity ${SPOTLIGHT_FADE_MS}ms ease`,
      ].join(";"),
      host
    );
    this.cardPhoto = document.createElement("img");
    this.cardPhoto.style.cssText =
      "float:right;width:92px;height:62px;object-fit:cover;border-radius:6px;" +
      "margin:0 0 6px 10px;display:none";
    this.cardPhoto.alt = "";
    this.cardPhoto.addEventListener("error", () => {
      this.cardPhoto.style.display = "none";
    });
    this.cardPhoto.addEventListener("load", () => {
      this.cardPhoto.style.display = "block";
    });
    this.card.appendChild(this.cardPhoto);
    this.cardTitle = div(
      "font-size:18px;font-weight:600;color:rgba(235,242,255,0.92)",
      this.card
    );
    this.cardLines = [0, 1, 2].map(() =>
      div("margin-top:3px;color:rgba(190,205,230,0.75)", this.card)
    );
    this.cardAccent = div(
      "margin-top:5px;font-size:13px;color:rgba(150,165,190,0.6)",
      this.card
    );

    this.tickTimer = window.setInterval(() => this.tick(), 1000);
    this.rotateTimer = window.setInterval(
      () => this.rotate(),
      SPOTLIGHT_ROTATE_MS
    );
    this.tick();
  }

  setSnapshot(snapshot: SkyResponse): void {
    this.snapshot = snapshot;
    this.tick();
  }

  /**
   * Timezone for the footer clock: the observer's zone, or null when it could
   * not be determined (the clock then reads UTC and says so). The times shown
   * follow the sky on the ceiling, not the device in the room.
   */
  setTimeZone(timeZone: string | null): void {
    this.timeZone = timeZone;
    this.tick();
  }

  /** Note which location source the sky is computed from ("your location",
   *  "Chicago (default)", "custom"). Rendered as text, never HTML. */
  setLocationLabel(label: string): void {
    this.locationLabel = label;
    this.tick();
  }

  /**
   * Drop the spotlight card and the last snapshot — used when the observer
   * changes, because the card holds strings copied out of an object that is no
   * longer in the sky (its "km away" was measured from the old location) and
   * would otherwise linger for up to a full rotation interval.
   */
  clearSpotlight(): void {
    if (this.fadeTimeout !== null) {
      clearTimeout(this.fadeTimeout);
      this.fadeTimeout = null;
    }
    this.snapshot = null;
    this.card.style.opacity = "0";
    this.cardShown = false;
    this.spotIndex = -1;
    this.tick();
  }

  destroy(): void {
    clearInterval(this.tickTimer);
    clearInterval(this.rotateTimer);
    if (this.fadeTimeout !== null) clearTimeout(this.fadeTimeout);
    this.root.remove();
    this.card.remove();
  }

  // ---- 1 Hz: clock, counts, staleness, degradation notices ----
  private tick(): void {
    const stats = this.getStats();
    const twilight = this.snapshot?.astro.twilight ?? "—";
    const hhmm = formatClock(new Date(), this.timeZone);
    const where = this.locationLabel ? ` · ${this.locationLabel}` : "";
    this.statusLine.textContent =
      `${stats.sat + stats.iss} satellites · ${stats.plane} planes · ` +
      `${twilight} · ${hhmm}${where}`;
    // Re-appended every tick by design: setting textContent wipes children.
    this.statusLine.appendChild(this.stalenessDot);

    const age = stats.lastTs > 0 ? Date.now() / 1000 - stats.lastTs : null;
    this.stalenessDot.style.background =
      age === null
        ? "#666a75" // no data yet
        : age < 25
          ? "#6fbf6f" // fresh
          : age < 60
            ? "#d9aa4e" // missed a poll or two
            : "#c96a5e"; // stale

    const problems: string[] = [];
    const st = this.snapshot?.status;
    if (st && !st.satellites.ok && st.satellites.message)
      problems.push(st.satellites.message);
    if (st && !st.planes.ok && st.planes.message)
      problems.push(st.planes.message);
    if (problems.length > 0) {
      this.degradedLine.textContent = problems.join(" · ");
      this.degradedLine.style.display = "block";
    } else {
      this.degradedLine.style.display = "none";
    }

    // First fill: as soon as anything is trackable, light the card up.
    if (!this.cardShown && this.getCandidates().length > 0) this.rotate();
  }

  // ---- 12 s: advance the spotlight ----
  private rotate(): void {
    const candidates = this.getCandidates();
    if (candidates.length === 0) {
      this.card.style.opacity = "0";
      this.cardShown = false;
      this.spotIndex = -1;
      return;
    }
    this.spotIndex = (this.spotIndex + 1) % candidates.length;
    const rec = candidates[this.spotIndex];

    if (this.cardShown) {
      // Fade out, swap content, fade back in.
      this.card.style.opacity = "0";
      if (this.fadeTimeout !== null) clearTimeout(this.fadeTimeout);
      this.fadeTimeout = window.setTimeout(() => {
        this.fillCard(rec);
        this.card.style.opacity = "0.95";
      }, SPOTLIGHT_FADE_MS);
    } else {
      this.fillCard(rec);
      this.card.style.opacity = "0.95";
      this.cardShown = true;
    }
  }

  private fillCard(rec: TrackedRecord): void {
    if (rec.data.type === "plane") this.fillPlaneCard(rec.data);
    else this.fillSatCard(rec.data);
  }

  private setLines(lines: string[]): void {
    for (let i = 0; i < this.cardLines.length; i++) {
      const text = lines[i] ?? "";
      this.cardLines[i].textContent = text;
      this.cardLines[i].style.display = text ? "block" : "none";
    }
  }

  private fillPlaneCard(p: PlaneObject): void {
    const cs = (p.callsign || "").trim() || p.icao24.toUpperCase();
    this.cardTitle.textContent = p.airline ? `${cs} · ${p.airline}` : cs;

    const lines: string[] = [];
    if (p.aircraftType) {
      lines.push(
        p.operator && p.operator !== p.airline
          ? `${p.aircraftType} — ${p.operator}`
          : p.aircraftType
      );
    }
    if (p.origin && p.destination) {
      const from = [p.origin, p.originName].filter(Boolean).join(" ");
      const to = [p.destination, p.destinationName].filter(Boolean).join(" ");
      lines.push(`${from} → ${to}`);
    }
    const facts: string[] = [];
    if (p.altitudeM !== null) facts.push(`${fmtInt(p.altitudeM)} m`);
    if (p.speedKt !== null) facts.push(`${fmtInt(p.speedKt)} kt`);
    if (p.groundDistKm !== null) facts.push(`${fmtInt(p.groundDistKm)} km away`);
    let factLine = facts.join(" · ");
    if (typeof p.verticalRateMs === "number") {
      if (p.verticalRateMs > 2) factLine += " ↑";
      else if (p.verticalRateMs < -2) factLine += " ↓";
    }
    if (factLine) lines.push(factLine);
    this.setLines(lines);

    this.cardAccent.textContent =
      p.category === "rotorcraft" ? "helicopter" : "";
    this.cardAccent.style.display =
      p.category === "rotorcraft" ? "block" : "none";
    this.cardAccent.style.color = "rgba(255,160,64,0.7)";

    this.cardPhoto.style.display = "none";
    if (p.photoUrl) {
      if (this.cardPhoto.src === p.photoUrl && this.cardPhoto.complete) {
        // Same cached image again: 'load' won't re-fire, show it directly.
        if (this.cardPhoto.naturalWidth > 0)
          this.cardPhoto.style.display = "block";
      } else {
        this.cardPhoto.src = p.photoUrl; // 'load' shows it
      }
    }
  }

  private fillSatCard(s: SatObject): void {
    this.cardTitle.textContent = s.name;

    const lines: string[] = [];
    const cat = SAT_CATEGORY_LABEL[s.category];
    lines.push(s.launchYear ? `${cat} · launched ${s.launchYear}` : cat);
    lines.push(`${fmtInt(s.rangeKm)} km up`);
    this.setLines(lines);

    const twilight = this.snapshot?.astro.twilight ?? "night";
    if (s.visibleNow) {
      this.cardAccent.textContent = "✦ sunlit — visible now";
      this.cardAccent.style.color = "rgba(207,224,255,0.9)";
    } else if (!s.sunlit) {
      this.cardAccent.textContent = "in Earth's shadow";
      this.cardAccent.style.color = "rgba(150,165,190,0.6)";
    } else {
      this.cardAccent.textContent =
        twilight === "day" || twilight === "civil"
          ? "overhead in daylight"
          : "sunlit";
      this.cardAccent.style.color = "rgba(150,165,190,0.6)";
    }
    this.cardAccent.style.display = "block";

    this.cardPhoto.style.display = "none";
  }
}
