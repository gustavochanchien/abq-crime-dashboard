/* ABQ Incidents Dashboard — app.js
   Orchestrates: data loading, filtering pipeline, and delegates rendering to:
   - map-module.js (Leaflet + dots/heat/zips + region draw)
   - trends-module.js (legend + charts + KPIs + DOW/hour mini-filters)
*/

import { createMapController } from "./map-module.js";
import { createTrendsController } from "./trends-module.js";

let appReadyToRender = false;

window.addEventListener("DOMContentLoaded", () => {
  // ------------------ Config ------------------
  const INCIDENTS_SERVICE_BASE =
    "https://coageo.cabq.gov/cabqgeo/rest/services/Incidents/MapServer/0";

  const ZIP_QUERY_URL =
    "https://pdsmaps.bernco.gov/server/rest/services/BERNCOCAD/ZIP_Codes/MapServer/194/query";

  const INITIAL_DAYS = 30;        // initial fetch size (fast first render)
  const DEFAULT_VIEW_DAYS = 30;   // default slider window shown to user
  const MAX_YEARS_BACK = 2;       // total history cap
  const BACKFILL_STEP_DAYS = 30;  // background chunk size
  const PAGE_SIZE = 2000;

  const DAY_MS = 24 * 60 * 60 * 1000;


/**
 * Notes for future development:
 * - All time values in this file are **epoch milliseconds**.
 * - The ArcGIS `time=` query param expects `[start,end]` in ms; we treat ranges as inclusive
 *   on both ends by snapping to `startOfDay()` / `endOfDay()`.
 * - If the upstream service changes its time semantics (inclusive/exclusive), adjust the
 *   day-boundary helpers first.
 *
 * Tuning knobs:
 * - INITIAL_DAYS controls "time to first paint".
 * - MAX_YEARS_BACK is the hard history cap (also clamped by layer metadata when available).
 * - BACKFILL_STEP_DAYS and PAGE_SIZE trade off latency vs. request count.
 */

  // ------------------ DOM helpers ------------------
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status-bar");

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  function requireEl(id) {
    const el = $(id);
    if (!el) throw new Error(`Missing required element #${id}`);
    return el;
  }

  // Required UI elements
  const timelineCanvas = requireEl("timeline-chart");
  const dowCanvas = requireEl("dow-chart");
  const hourCanvas = requireEl("hour-chart");

  const groupingEl = $("chart-grouping");
  const aggregateEl = $("chart-aggregate");

  const mapDiv = requireEl("map");
  const overlayEl = $("map-overlay");
  const topCardEl = $("top-card");

  const sliderEl = requireEl("slider");
  const dateLabelEl = requireEl("date-label");

  const legendItemsEl = requireEl("legend-items");
  const showAllTypesEl = requireEl("show-all-types");
  const resetTypesBtn = requireEl("select-all-types");

  const controlsEl = requireEl("controls");

  const modeHeatBtn = requireEl("mode-heat");
  const modeZipBtn = requireEl("mode-zip");
  const modeDotsBtn = requireEl("mode-dots");

  const heatOpacityPanel = requireEl("heat-opacity-panel");
  const heatOpacityEl = requireEl("heat-opacity");
  const heatOpacityValEl = requireEl("heat-opacity-val");

  // const drawRegionBtn = requireEl("draw-region-btn");
  const clearRegionBtn = requireEl("clear-region-btn");
  const loadedRangeChip = requireEl("loaded-range-chip");

  // KPI elements
  const kpiTotalEl = requireEl("kpi-total");
  const kpiRangeEl = requireEl("kpi-range");
  const kpiTopTypeEl = requireEl("kpi-toptype");
  const kpiTopTypeSubEl = requireEl("kpi-toptype-sub");
  const kpiPeakEl = requireEl("kpi-peakday");
  const kpiPeakSubEl = requireEl("kpi-peakday-sub");
  const kpiFiltersEl = requireEl("kpi-filters");
  const kpiFiltersSubEl = requireEl("kpi-filters-sub");

  // Mini chart filter UI
  const dowFilterChip = requireEl("dow-filter-chip");
  const hourFilterChip = requireEl("hour-filter-chip");
  const dowClearBtn = requireEl("dow-clear");
  const hourClearBtn = requireEl("hour-clear");

  // ------------------ State ------------------
  /** pointsSorted: { ts:number(ms), type:string, category:string, addr:string, lat:number, lon:number } */
  let pointsSorted = [];

  /**
   * Invariant: `pointsSorted` must remain sorted ascending by `ts` after any merge.
   * Many rendering and range operations assume this ordering for fast scans and stable charts.
   */

  let loadedMinTime = null;
  let loadedMaxTime = null;

  let currentMinTime = null;
  let currentMaxTime = null;

  let absoluteMinAllowed = null;
  let absoluteMaxAllowed = null;

  // ArcGIS field detection
  let dateFieldName = null;
  let typeFieldName = null;
  let addrFieldName = null;

  // Layer metadata (optional)
  let layerTimeExtentStart = null;
  let layerTimeExtentEnd = null;

  // Slider
  let slider = null;
  let currentlyFetchingOlder = false;
  let backgroundPreloadRunning = false;

  // Heat (slider is 10..100)
  let heatOpacity = (+heatOpacityEl.value || 75) / 100;
  heatOpacityValEl.textContent = `${Math.round(heatOpacity * 100)}%`;

  // View
  let viewMode = "dots"; // dots | heat | zips

  // ------------------ Utilities ------------------
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function endOfDay(ms) {
    const d = new Date(ms);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  function formatDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function formatRange(minMs, maxMs) {
    return `${formatDate(minMs)} → ${formatDate(maxMs)}`;
  }

  function yearsBackMs(years) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d.getTime();
  }

  function isFiniteNum(x) {
    return typeof x === "number" && Number.isFinite(x);
  }

  function getLatLon(feature) {
    const g = feature?.geometry;
    if (!g) return null;
    if (isFiniteNum(g.x) && isFiniteNum(g.y)) return { lon: g.x, lat: g.y };
    if (Array.isArray(g.points) && g.points[0]?.length >= 2) {
      return { lon: g.points[0][0], lat: g.points[0][1] };
    }
    return null;
  }

  function findField(attributes, candidates) {
    const keys = Object.keys(attributes || {});
    for (const c of candidates) {
      const exact = keys.find((k) => k.toLowerCase() === c.toLowerCase());
      if (exact) return exact;
    }
    for (const c of candidates) {
      const partial = keys.find((k) => k.toLowerCase().includes(c.toLowerCase()));
      if (partial) return partial;
    }
    return null;
  }

  // ------------------ Categories + icon/color semantics ------------------
  // Primary mapping is by UNM PD call-code (e.g. "31", "39-1", "27-6C").
  // We also keep a small keyword fallback for any unmapped / messy strings.
  const BIG_CATEGORIES = [
    "Violent Crime",
    "Property Crime",
    "Suspicious & Investigation",
    "Disorder / Nuisance",
    "Traffic & Road Safety",
    "Medical & Welfare",
    "Fire & Life Safety",
    "Alarms & Security",
    "Missing / Wanted",
    "Admin / Officer Activity",
    "Animal",
    "Other",
  ];

  function normalizeTypeString(type) {
    return (type ?? "")
      .toString()
      .replace(/^\s*ONSITE\s+/i, "")   // treat "Onsite" as context, not taxonomy
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractCallCode(typeStr) {
    const s = (typeStr || "").trim().toUpperCase();
    if (!s) return null;

    // 1) Hyphenated codes FIRST (e.g., 27-4, 27-3I, 27-5A, 39-1, 27-7W)
    let m = /^(\d{1,2}-\d{1,2}[A-Z0-9]*)\b/.exec(s);
    if (m) return m[1];

    // 2) Letter-suffix numeric codes (e.g., 31S, 31D, 39S, 7S)
    m = /^(\d{1,2}[A-Z])\b/.exec(s);
    if (m) return m[1];

    // 3) Plain numeric codes (e.g., 31, 39, 55, 43, 33, 65, 80)
    m = /^(\d{1,2})\b/.exec(s);
    if (m) return m[1];

    // 4) Pure alpha codes (e.g., SS)
    m = /^([A-Z]{2,3})\b/.exec(s);
    if (m) return m[1];

    return null;
  }



  // Code-first rules (most reliable)
  const CODE_CATEGORY_RULES = [
    // ----- Violent Crime -----
    {
      category: "Violent Crime",
      patterns: [
        /^27-1\b/,                 // 27-1 HOMICIDE
        /^27-4\b/,                 // 27-4 AGGR ASSAULT/BAT
        /^27-8\b/,                 // 27-8 SHOOTING
        /^27-9\b/,                 // 27-9 STABBING
        /^39-3\b/,                 // 39-3 SHOTS FIRED
        /^27-3[A-Z0-9]*\b/,        // 27-3 ROBBERY + 27-3I/27-3C/27-3R/27-3A variants
        /^65\b/,                   // 65 KID/ABDUCT/HOSTA
      ],
    },

    // ----- Property Crime -----
    {
      category: "Property Crime",
      patterns: [
        /^27-0\b/,                 // 27-0 FORGERY/CC/CHECK
        /^27-5[A-Z0-9]*\b/,        // 27-5 BURGLARY + 27-5A/27-5R/27-5C variants
        /^27-6[A-Z0-9]*\b/,        // 27-6 THEFT/FRAUD/EMBE + 27-6M etc
        /^27-7[A-Z0-9]*\b/,        // 27-7 AUTO THEFT + 27-7W etc
        /^7S\b/,                   // 7S ONSITE AUTO THEFT
        /^37\b/,                   // 37 SHOPLIFTING
        /^38\b/,                   // 38 VANDALISM
        /^38M\b/,                   // 38 VANDALISM
      ],
    },

    // ----- Suspicious & Investigation -----
    {
      category: "Suspicious & Investigation",
      patterns: [
        /^31S\b/,                  // 31S ONSITE SUSPICIOUS
        /^31D\b/,                  // 31D SUSP/INTOX PERS
        /^31\b/,                   // 31 SUSP PERS/VEHS
        /^35\b/,                   // 35 PROWLER
      ],
    },

    // ----- Disorder / Nuisance -----
    {
      category: "Disorder / Nuisance",
      patterns: [
        /^39-1\b/,                 // 39-1 LOUD MUSIC
        /^39-2\b/,                 // 39-2 LOUD PARTY
        /^39-5\b/,                 // 39-5 PANHANDLERS
        /^39S\b/,                  // 39S ONSITE DISTURBAN
        /^39\b/,                   // 39 DISTURBANCE
        /^41\b/,                   // 41 NEIGHBOR TROUBLE
        /^80\b/,                   // 80 DEMONSTRATION
        /^32\b/,                   // 32 FIGHT INPROGRESS (move elsewhere if you prefer)
        /^57\b/,                   // 57 NARCOTICS (move elsewhere if you prefer)
      ],
    },

    // ----- Missing / Wanted -----
    {
      category: "Missing / Wanted",
      patterns: [
        /^28\b/,                   // 28 MISSING PERSON
        /^29\b/,                   // 29 WANTED PERSON
      ],
    },

    // ----- Medical & Welfare -----
    {
      category: "Medical & Welfare",
      patterns: [
        /^43\b/,                   // 43 RESCUE CALL
        /^55\b/,                   // 55 AMBULANCE CALL
      ],
    },

    // ----- Fire & Life Safety -----
    {
      category: "Fire & Life Safety",
      patterns: [
        /^33\b/,                   // 33 FIRE CALL
      ],
    },

    // ----- Admin / Officer Activity -----
    {
      category: "Admin / Officer Activity",
      patterns: [
        /^14\b/,                   // 14 ESCORT
        /^16\b/,                   // 16 PRISONER PU/INCU
        /^SS\b/,                   // SS SUBJECT STOP
      ],
    },

    // ----- Animal -----
    {
      category: "Animal",
      patterns: [
        /^11\b/,                   // 11 ANIMAL CALL
      ],
    },
  ];

  function categoryForType(type) {
    const t = normalizeTypeString(type);
    const code = extractCallCode(t);

    if (code) {
      for (const rule of CODE_CATEGORY_RULES) {
        for (const re of rule.patterns) {
          if (re.test(code)) return rule.category;
        }
      }
    }

    return "Other";
  }

  const CATEGORY_COLORS = {
    "Violent Crime": "#dd1616",
    "Property Crime": "#f59e0b",
    "Suspicious & Investigation": "#2e3d94",
    "Disorder / Nuisance": "#a855f7",
    "Traffic & Road Safety": "#eab308",
    "Medical & Welfare": "#0ea5e9",
    "Fire & Life Safety": "#f97316",
    "Alarms & Security": "#14b8a6",
    "Missing / Wanted": "#64748b",
    "Admin / Officer Activity": "#6d5238",
    "Animal": "#10b981",
    "Other": "#94a3b8",
  };

  function colorForCategory(cat) {
    return CATEGORY_COLORS[cat] || CATEGORY_COLORS["Other"];
  }

// --- Bootstrap Icons (canvas sprites) ---
  const BI_FONT_FAMILY = "bootstrap-icons";
  const ICON_SPRITE_PX = 20;
  const ICON_GLYPH_PX = 12;

const CATEGORY_STYLE = {
  "Violent Crime":              { iconClass: "bi-shield-fill-exclamation", glyph: "\uF848" },
  "Property Crime":             { iconClass: "bi-house-lock",             glyph: "\uF7D6" },
  "Suspicious & Investigation": { iconClass: "bi-eye",                    glyph: "\uF33E" },
  "Disorder / Nuisance":        { iconClass: "bi-megaphone",              glyph: "\uF478" },
  "Traffic & Road Safety":      { iconClass: "bi-car-front",              glyph: "\uF7E1" },
  "Medical & Welfare":          { iconClass: "bi-heart-pulse",            glyph: "\uF76F" },
  "Fire & Life Safety":         { iconClass: "bi-fire",                   glyph: "\uF391" },
  "Alarms & Security":          { iconClass: "bi-bell",                   glyph: "\uF18A" },
  "Missing / Wanted":           { iconClass: "bi-search",                 glyph: "\uF52A" },
  "Admin / Officer Activity":   { iconClass: "bi-clipboard-check",        glyph: "\uF26E" },
  "Animal":                     { iconClass: "bi-bug",                    glyph: "\uF1D0" },
  "Other":                      { iconClass: "bi-question-circle",        glyph: "\uF505" },
};

  function iconClassForCategory(cat) {
    return (CATEGORY_STYLE[cat] || CATEGORY_STYLE.Other).iconClass;
  }
  function iconGlyphForCategory(cat) {
    return (CATEGORY_STYLE[cat] || CATEGORY_STYLE.Other).glyph;
  }

  // font readiness
  let iconFontReady = false;
  async function ensureIconFontReady() {
    try {
      if (document.fonts?.load) {
        await document.fonts.load(`${ICON_GLYPH_PX}px ${BI_FONT_FAMILY}`);
      }
      iconFontReady = true;
    } catch {
      iconFontReady = false;
    }
  }

  // sprite cache
  const iconSpriteCache = new Map(); // cat -> canvas
  function buildIconSprite(bgColor, glyph) {
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement("canvas");
    c.width = Math.round(ICON_SPRITE_PX * dpr);
    c.height = Math.round(ICON_SPRITE_PX * dpr);

    const ctx = c.getContext("2d", { alpha: true });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.beginPath();
    ctx.fillStyle = bgColor;
    ctx.arc(ICON_SPRITE_PX / 2, ICON_SPRITE_PX / 2, ICON_SPRITE_PX / 2 - 1, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#fff";
    ctx.font = `900 ${ICON_GLYPH_PX}px ${BI_FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, ICON_SPRITE_PX / 2, ICON_SPRITE_PX / 2 + 0.5);

    return c;
  }

  function spriteForCategory(cat) {
    const key = cat || "Other";
    let sprite = iconSpriteCache.get(key);
    if (sprite) return sprite;

    sprite = buildIconSprite(colorForCategory(key), iconGlyphForCategory(key));
    iconSpriteCache.set(key, sprite);
    return sprite;
  }

  // Shade types within their category by mixing with white based on hash
  function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return { r: 148, g: 163, b: 184 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  function mixRgb(a, b, t) {
    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const b2 = Math.round(a.b + (b.b - a.b) * t);
    return `rgb(${r},${g},${b2})`;
  }

  function shadeForType(type, category) {
    const base = hexToRgb(colorForCategory(category));
    const white = { r: 255, g: 255, b: 255 };
    const h = hash32(type);
    const t = 0.08 + ((h % 100) / 100) * 0.55; // 0.08..0.63
    return mixRgb(base, white, t);
  }

  // ------------------ Data normalization ------------------
  function normalizeFeatures(features) {
    const out = [];
    for (const f of features || []) {
      const attrs = f.attributes || {};
      const ll = getLatLon(f);
      if (!ll) continue;

      const raw = attrs[dateFieldName];
      const ts = typeof raw === "number" ? raw : Date.parse(raw);
      if (!Number.isFinite(ts)) continue;

      const type = (attrs[typeFieldName] ?? "Unknown").toString().trim() || "Unknown";
      const addr = addrFieldName ? (attrs[addrFieldName] ?? "").toString() : "";
      const category = categoryForType(type);

      out.push({ ts, type, category, addr, lat: ll.lat, lon: ll.lon });
    }
    return out;
  }

  function mergePoints(newPts) {

/**
 * Dedup strategy:
 * ArcGIS features do not always provide a stable unique id across paged/time queries,
 * so we approximate uniqueness using (ts,type,lat,lon) rounded to 6 decimals.
 *
 * If you notice duplicates or accidental drops:
 * - Prefer adding a true unique key (e.g., OBJECTID + dateField) to the normalized shape.
 * - Or increase/decrease rounding precision depending on how noisy coordinates are.
 */
    if (!newPts?.length) return;
    const key = (p) => `${p.ts}|${p.type}|${p.lat.toFixed(6)}|${p.lon.toFixed(6)}`;

    const existing = new Set(pointsSorted.map(key));
    for (const p of newPts) {
      const k = key(p);
      if (!existing.has(k)) {
        existing.add(k);
        pointsSorted.push(p);
      }
    }
    pointsSorted.sort((a, b) => a.ts - b.ts);
  }

  // ------------------ ArcGIS (robust) ------------------
  async function arcgisFetch(url, label) {
    setStatus(label);
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();

    let data;
    try { data = JSON.parse(text); }
    catch {
      console.error("Non-JSON response:", text.slice(0, 300));
      throw new Error(`Non-JSON response (HTTP ${res.status})`);
    }

    if (data?.error) {
      const details = Array.isArray(data.error.details) ? data.error.details.join(" | ") : "";
      throw new Error(`${data.error.message || "ArcGIS error"}${details ? " — " + details : ""}`);
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return data;
  }

  async function fetchLayerInfo() {

/**
 * Reads ArcGIS layer metadata (best-effort).
 * If the service publishes `timeInfo.timeExtent`, we use it to clamp history bounds so
 * the slider doesn't offer ranges the service can't satisfy.
 */
    try {
      const url = `${INCIDENTS_SERVICE_BASE}?f=json`;
      const info = await arcgisFetch(url, "Reading layer metadata…");
      const extent = info?.timeInfo?.timeExtent;
      if (Array.isArray(extent) && extent.length >= 2) {
        layerTimeExtentStart = extent[0];
        layerTimeExtentEnd = extent[1];
      }
    } catch (e) {
      console.warn("Layer metadata read failed (continuing):", e);
    }
  }

  async function discoverFieldsIfNeeded() {

/**
 * Schema discovery (best-effort).
 * The incidents layer fields have historically changed naming/casing; we probe a single
 * feature and pick the best match from candidate lists.
 *
 * If the layer schema changes again:
 * - Add new candidates to the lists below.
 * - Consider switching to the layer's `fields` metadata instead of sampling a feature.
 */
    if (dateFieldName && typeFieldName) return;

    const url = `${INCIDENTS_SERVICE_BASE}/query?` + new URLSearchParams({
      where: "1=1",
      outFields: "*",
      returnGeometry: "false",
      resultRecordCount: "1",
      f: "json",
    }).toString();

    const data = await arcgisFetch(url, "Discovering fields…");
    const first = data?.features?.[0];
    if (!first?.attributes) throw new Error("Could not discover fields (no features returned).");

    const attrs = first.attributes;

    dateFieldName = findField(attrs, [
      "ReportDateTime",
      "reportdatetime",
      "reportdate",
      "date",
      "Date_",
      "incidentdate",
      "cvincidentdate",
    ]);

    typeFieldName = findField(attrs, [
      "IncidentType",
      "incidenttype",
      "type",
      "offense",
      "cvincidenttype",
    ]);

    addrFieldName = findField(attrs, [
      "BlockAddress",
      "blockaddress",
      "address",
      "location",
    ]);

    if (!dateFieldName) throw new Error("Could not detect a date field.");
    if (!typeFieldName) throw new Error("Could not detect an incident type field.");
  }

  async function arcgisQueryPaged(paramsBase, labelPrefix) {

/**
 * Paged query helper.
 *
 * Why this exists:
 * - ArcGIS services often cap `resultRecordCount`.
 * - We page with `resultOffset` and merge results client-side.
 *
 * Safeguards:
 * - The `page > 600` break is a circuit breaker against infinite loops if the service
 *   ignores offsets or always returns PAGE_SIZE records.
 */
    let resultOffset = 0;
    let merged = [];
    let page = 1;

    while (true) {
      const params = new URLSearchParams({
        ...paramsBase,
        resultRecordCount: String(PAGE_SIZE),
        resultOffset: String(resultOffset),
        orderByFields: "OBJECTID",
      });

      const url = `${INCIDENTS_SERVICE_BASE}/query?${params.toString()}`;
      const data = await arcgisFetch(url, `${labelPrefix} (page ${page})`);

      const feats = data.features || [];
      merged = merged.concat(feats);

      if (feats.length < PAGE_SIZE) break;
      resultOffset += PAGE_SIZE;
      page += 1;
      if (page > 600) break;
    }

    return merged;
  }

  async function fetchRange(startMs, endMs, label) {
    await discoverFieldsIfNeeded();

    const outFields = ["OBJECTID", dateFieldName, typeFieldName, addrFieldName]
      .filter(Boolean)
      .join(",");

    return await arcgisQueryPaged(
      {
        where: "1=1",
        time: `${startMs},${endMs}`,
        outFields,
        returnGeometry: "true",
        outSR: "4326",
        f: "json",
      },
      label
    );
  }

  // ------------------ Slider + background preload ------------------
  function initSlider() {

/**
 * Slider values are strings from noUiSlider; always `parseInt` before math.
 * `step: DAY_MS` gives a day-granularity slider; adjust if you ever support hourly views.
 */
    if (!loadedMinTime || !loadedMaxTime) return;

    slider = noUiSlider.create(sliderEl, {
      start: [loadedMinTime, loadedMaxTime],
      connect: true,
      range: { min: loadedMinTime, max: loadedMaxTime },
      step: DAY_MS,
      behaviour: "tap-drag",
    });

    currentMinTime = loadedMinTime;
    currentMaxTime = loadedMaxTime;
    dateLabelEl.textContent = formatRange(currentMinTime, currentMaxTime);

    slider.on("update", (values) => {
      currentMinTime = parseInt(values[0], 10);
      currentMaxTime = parseInt(values[1], 10);
      dateLabelEl.textContent = formatRange(currentMinTime, currentMaxTime);

      // If user drags near left edge, pull older chunks immediately (still supported)
      maybeBackfillOlder(currentMinTime);
    });

    slider.on("change", () => redrawAll());
  }

  function updateSliderRange(minTime, maxTime, keepValues = true) {
    if (!slider) return;
    const currentVals = keepValues
      ? slider.get().map((v) => parseInt(v, 10))
      : [minTime, maxTime];

    slider.updateOptions({ range: { min: minTime, max: maxTime } });
    slider.set([
      clamp(currentVals[0], minTime, maxTime),
      clamp(currentVals[1], minTime, maxTime),
    ]);
  }

  function maybeBackfillOlder(currentMin) {
    if (currentlyFetchingOlder) return;
    if (loadedMinTime == null) return;
    if (currentMin <= loadedMinTime + 7 * DAY_MS) backfillOlderChunk(false);
  }

  function updateLoadedRangeChip() {
    if (!loadedMinTime || !loadedMaxTime) {
      loadedRangeChip.textContent = "Loaded: —";
      return;
    }
    loadedRangeChip.textContent = `Loaded: ${formatRange(loadedMinTime, loadedMaxTime)}`;
  }

  async function backfillOlderChunk(quiet) {
    if (currentlyFetchingOlder) return;
    if (loadedMinTime == null || absoluteMinAllowed == null) return;
    if (loadedMinTime <= absoluteMinAllowed + DAY_MS) return;

    const olderEnd = loadedMinTime;
    const olderStart = Math.max(absoluteMinAllowed, olderEnd - BACKFILL_STEP_DAYS * DAY_MS);
    if (olderStart >= olderEnd) return;

    currentlyFetchingOlder = true;
    try {
      const feats = await fetchRange(
        olderStart,
        olderEnd,
        quiet ? "Loading more history…" : `Backfilling… ${formatRange(olderStart, olderEnd)}`
      );
      const pts = normalizeFeatures(feats);
      mergePoints(pts);

      loadedMinTime = olderStart;

      updateLoadedRangeChip();
      updateSliderRange(loadedMinTime, loadedMaxTime, true);
    } catch (e) {
      console.error(e);
      setStatus(`Backfill failed: ${e.message}`);
    } finally {
      currentlyFetchingOlder = false;
      if (!quiet) redrawAll();
    }
  }

  async function loadAllHistoryInBackground() {

/**
 * Background history loader.
 *
 * UX goal: keep the default view (e.g. last 30 days) responsive while progressively
 * warming the in-memory cache for deep time exploration.
 *
 * Considerations for future enhancements:
 * - Add an AbortController so you can stop preloading on tab hide / navigation.
 * - Persist results in IndexedDB to avoid re-fetching on reload.
 * - Defer `redrawAll()` to a requestAnimationFrame / debounced cadence for very large sets.
 */
    if (backgroundPreloadRunning) return;
    backgroundPreloadRunning = true;

    try {
      let cursor = absoluteMinAllowed;
      const end = absoluteMaxAllowed;

      while (cursor < end) {
        const next = Math.min(end, cursor + BACKFILL_STEP_DAYS * DAY_MS);
        const feats = await fetchRange(cursor, next, `Loading history… ${formatRange(cursor, next)}`);
        const pts = normalizeFeatures(feats);
        mergePoints(pts);

        loadedMinTime = loadedMinTime == null ? cursor : Math.min(loadedMinTime, cursor);
        loadedMaxTime = loadedMaxTime == null ? next : Math.max(loadedMaxTime, next);

        updateLoadedRangeChip();

        if (slider) updateSliderRange(loadedMinTime, loadedMaxTime, true);

        redrawAll();
        await new Promise((r) => setTimeout(r, 40));
        cursor = next;
      }

      setStatus("Up to date.");
    } catch (e) {
      console.error(e);
      setStatus(`History load failed: ${e.message}`);
    } finally {
      backgroundPreloadRunning = false;
    }
  }

  function setDefaultMonthView() {
    if (!slider || loadedMaxTime == null) return;

    const end = loadedMaxTime;
    const start = Math.max(loadedMinTime ?? end, end - (DEFAULT_VIEW_DAYS - 1) * DAY_MS);
    slider.set([start, end]);
  }

  // ------------------ Controllers ------------------
  const mapCtl = createMapController({
    mapDiv,
    overlayEl,
    topCardEl,
    modeDotsBtn,
    modeHeatBtn,
    modeZipBtn,
    heatOpacityPanel,
    heatOpacityEl,
    heatOpacityValEl,
    // drawRegionBtn,
    clearRegionBtn,
    setStatus,
    ZIP_QUERY_URL,
    arcgisFetch, // re-use robust fetch + status
    iconFontReadyRef: () => iconFontReady,
    ensureIconFontReady,
    colorForCategory,
    iconGlyphForCategory,
    spriteForCategory,
    shadeForType, // IMPORTANT: needed for pie slices
  });

  const trendsCtl = createTrendsController({
    timelineCanvas,
    dowCanvas,
    hourCanvas,
    groupingEl,
    aggregateEl,
    legendItemsEl,
    showAllTypesEl,
    resetTypesBtn,
    dowFilterChip,
    hourFilterChip,
    dowClearBtn,
    hourClearBtn,
    kpiTotalEl,
    kpiRangeEl,
    kpiTopTypeEl,
    kpiTopTypeSubEl,
    kpiPeakEl,
    kpiPeakSubEl,
    kpiFiltersEl,
    kpiFiltersSubEl,
    formatRange,
    formatDate,
    DAY_MS,
    categoryForType,
    colorForCategory,
    iconClassForCategory,
    shadeForType,
  });

  // Wire legend/DOW/hour invalidation to ZIP cache (as trends-module expects)
  trendsCtl.invalidateZipCacheHook = () => mapCtl.invalidateZipCache();

  // ------------------ Filter pipeline ------------------
  function passesTimeFilter(p) {
    return p.ts >= currentMinTime && p.ts <= currentMaxTime;
  }

  function buildSliceForLegend() {

/**
 * Legend counts are intentionally computed on a slice that:
 * - respects time + region + DOW/hour mini-filters
 * - ignores legend filters themselves
 *
 * This prevents "self-filtering" where the legend would re-count only what is currently
 * checked, making it hard to see what you are excluding.
 */
    // Slice ignores legend filters (so counts remain correct), but includes time/region/dow/hour
    const out = [];
    for (const p of pointsSorted) {
      if (!passesTimeFilter(p)) continue;
      if (!mapCtl.passesRegionFilter(p)) continue;
      if (!trendsCtl.passesDOWFilter(p.ts)) continue;
      if (!trendsCtl.passesHourFilter(p.ts)) continue;
      out.push(p);
    }
    return out;
  }

  function buildFilteredPoints(opts = {}) {
    const ignoreDOW = !!opts.ignoreDOW;
    const ignoreHour = !!opts.ignoreHour;

    const out = [];
    for (const p of pointsSorted) {
      if (!passesTimeFilter(p)) continue;
      if (!mapCtl.passesRegionFilter(p)) continue;
      if (!ignoreDOW && !trendsCtl.passesDOWFilter(p.ts)) continue;
      if (!ignoreHour && !trendsCtl.passesHourFilter(p.ts)) continue;
      if (!trendsCtl.legendAllowsPoint(p)) continue;
      out.push(p);
    }
    return out;
  }

  function clearAllLayersAndStatusEmpty() {
    mapCtl.clearMapLayers();
    setStatus("No data loaded yet.");
  }

  function redrawAll() {
    if (!appReadyToRender) return;

    trendsCtl.syncShowAllTypesFromUI();

    if (!pointsSorted.length || currentMinTime == null || currentMaxTime == null) {
      clearAllLayersAndStatusEmpty();
      return;
    }

    trendsCtl.updateMiniFilterChipsUI();

    // 1) build “slice” for legend (accurate counts)
    const sliceForLegend = buildSliceForLegend();

    // 2) render legend once
    trendsCtl.renderLegend(sliceForLegend);

    // 3) apply legend filters + everything else
    const filtered = buildFilteredPoints();

    trendsCtl.updateKPIs({
      filtered,
      currentMinTime,
      currentMaxTime,
      hasRegion: mapCtl.hasRegion(),
      legendIsNarrowed: trendsCtl.legendIsNarrowed(),
    });

    trendsCtl.renderAllCharts({
      filtered,
      pointsForDow: buildFilteredPoints({ ignoreDOW: true }),
      pointsForHour: buildFilteredPoints({ ignoreHour: true }),
      currentMinTime,
      currentMaxTime,
    });

    if (!filtered.length) {
      mapCtl.clearMapLayers();
      setStatus("No incidents match the current filters.");
      return;
    }

    // MAP RENDER (fix: ZIP mode uses drawZipsWithKey + a stable cache key)

// Rendering happens in an async IIFE so the main redraw can complete quickly.
// If you ever add cancellation (recommended), pass an AbortSignal down to mapCtl.draw*.
    (async () => {
      try {
        if (viewMode === "zips") {
          const zipKey = {
            min: currentMinTime,
            max: currentMaxTime,
            dow: trendsCtl.selectedDOW,
            hour: trendsCtl.selectedHour,
            regionKey: mapCtl.regionKey,
            legendKey: trendsCtl.showAllTypes ? trendsCtl.activeTypeKey : trendsCtl.activeCategoryKey,
            showAllTypes: trendsCtl.showAllTypes,
          };
          await mapCtl.drawZipsWithKey(filtered, zipKey);
        } else {
          await mapCtl.draw(viewMode, filtered, heatOpacity);
        }
      } catch (e) {
        console.error(e);
        setStatus(`${viewMode.toUpperCase()} mode failed: ${e.message}`);
      }
    })();

    setStatus(
      `Loaded ${pointsSorted.length.toLocaleString()} incidents. Showing ${filtered.length.toLocaleString()} in view.`
    );
  }

  // allow modules to trigger redraw
  mapCtl.onRegionChanged = () => {
    mapCtl.invalidateZipCache();
    redrawAll();
  };
  trendsCtl.onFiltersChanged = () => redrawAll();

  // ------------------ UI events ------------------
  heatOpacityEl.addEventListener("input", (e) => {
    heatOpacity = (+e.target.value || 75) / 100;
    heatOpacityValEl.textContent = `${Math.round(heatOpacity * 100)}%`;
    if (viewMode === "heat") mapCtl.applyHeatOpacity(heatOpacity);
  });

  modeDotsBtn.addEventListener("click", () => { viewMode = "dots"; mapCtl.setModeUI(viewMode); redrawAll(); });
  modeHeatBtn.addEventListener("click", () => { viewMode = "heat"; mapCtl.setModeUI(viewMode); redrawAll(); });
  modeZipBtn.addEventListener("click", () => { viewMode = "zips"; mapCtl.setModeUI(viewMode); redrawAll(); });

  // ------------------ Boot ------------------
  (async () => {
    try {
      setStatus("Initializing…");

      mapCtl.initMap();

      await fetchLayerInfo();

      absoluteMaxAllowed = Date.now();
      absoluteMinAllowed = yearsBackMs(MAX_YEARS_BACK);

      // clamp to layer time extent (if present)
      if (Number.isFinite(layerTimeExtentStart)) absoluteMinAllowed = Math.max(absoluteMinAllowed, layerTimeExtentStart);
      console.log("timeExtentEnd:", new Date(layerTimeExtentEnd).toISOString(), "now:", new Date().toISOString());


      // Initial load (30 days)
      const initialEnd = endOfDay(absoluteMaxAllowed);
      const initialStart = startOfDay(initialEnd - (INITIAL_DAYS - 1) * DAY_MS);

      const feats = await fetchRange(initialStart, initialEnd, "Loading initial range…");
      const pts = normalizeFeatures(feats);
      pointsSorted = pts.sort((a, b) => a.ts - b.ts);

      loadedMinTime = initialStart;
      loadedMaxTime = initialEnd;

      updateLoadedRangeChip();

      // Ready UI
      appReadyToRender = true;
      initSlider();
      setDefaultMonthView();

      // Defaults: legend checked by default (after legend has visible lists)
      showAllTypesEl.checked = false;

      mapCtl.setModeUI(viewMode);
      await ensureIconFontReady();

      // First render builds visible legend lists
      redrawAll();

      // Now ensure everything in the legend is selected (checked) by default
      trendsCtl.resetLegendSelection();
      redrawAll();

      // Start loading full history immediately (while default view stays 30 days)
      loadAllHistoryInBackground();
    } catch (e) {
      console.error(e);
      setStatus(`Error: ${e.message}`);
    }
  })();
});
