// map-module.js
// Owns: Leaflet map, fast dots canvas layer, heat layer, ZIP choropleth, region draw, pie-chart clusters, click popups with scrollable event lists.

export function createMapController({
  /**
   * MapController responsibilities / architecture
   * -------------------------------------------
   * This module owns the Leaflet map instance and three mutually-exclusive render modes:
   *   1) Dots: a custom Canvas overlay (fast for many points) with optional cluster/pie rendering.
   *   2) Heat: Leaflet.heat layer.
   *   3) ZIPs: a choropleth layer (ArcGIS GeoJSON ZIP polygons) with point-in-polygon counting.
   *
   * Design notes:
   * - "drawGen" is a generation counter used to invalidate in-flight async work (future-proofing).
   * - We keep caches (zipGeoJSON/zipFeatureMeta + lastZipKey/lastZipCounts) to avoid expensive
   *   recomputation when only styles/UI change.
   * - All DOM inputs are injected so this controller can be unit-tested with stubs.
   */

  mapDiv,
  overlayEl,
  topCardEl,
  modeDotsBtn,
  modeHeatBtn,
  modeZipBtn,
  heatOpacityPanel,
  heatOpacityEl,
  heatOpacityValEl,
  drawRegionBtn,
  clearRegionBtn,
  setStatus,
  ZIP_QUERY_URL,
  arcgisFetch,
  iconFontReadyRef,
  ensureIconFontReady,
  colorForCategory,
  spriteForCategory,
  shadeForType,
}) {
  let map = null;
  let heatLayer = null;
  let zipLayer = null;
  let dotsCanvasLayer = null;

  // Leaflet draw
  let drawnItems = null;
  let drawControl = null;
  let drawGen = 0;

  // Region filter
  let regionLayer = null;
  let regionBounds = null;
  let regionLatLngs = null;

  // ZIP caches
  let zipGeoJSON = null;
  let zipFeatureMeta = null; // [{zip, ringsList, bboxes, leafletLayer}]
  let lastZipKey = null;
  let lastZipCounts = null;

  // external hook
  let onRegionChanged = null;

  // --- Click / tooltip support (dots mode) ---
  let currentMode = "dots";
  let lastDotGroups = [];
  let lastDotGroupsGrid = null;

  const HIT_PADDING_PX = 4;
  const GRID_CELL_PX = 64;
  const SIMPLE_DOTS_MAX_ZOOM = 14;
  const ZOOM_MID_MIN = 14;
  const ZOOM_IN_MIN = 15;
  const SMALL_POINT_COUNT = 100;


  // Visual size heuristic for a clustered location-group.
  // Kept as a pure function so it can be tuned without touching draw code.
  function groupRadiusPx(total) {
    return (
      total >= 200 ? 17 :
      total >= 100 ? 15 :
      total >= 25  ? 13 :
      total >= 10  ? 12 :
      total >= 2   ? 11 :
      10
    );
  }


  // Small helper for percentage labels in popups. (Avoid divide-by-zero.)
  function pct(n, d) {
    if (!d) return "0%";
    return `${Math.round((n / d) * 100)}%`;
  }


  // IMPORTANT: popup HTML is assembled via template strings; always escape untrusted fields
  // (type/address) to prevent XSS. Leaflet popups do not sanitize content.
  function escapeHtml(s) {
    return (s ?? "")
      .toString()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }


  // Time formatting helper used in popups. Defensive: timestamps may be missing/invalid.
  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return String(ts);
    }
  }


  // Build a coarse spatial index in screen-space (container pixels) for fast hit-testing.
  // This dramatically reduces the number of groups we distance-check on click.
  function buildGroupsGrid(groups) {
    if (!map) return null;
    const grid = new Map();
    for (const g of groups) {
      const pt = map.latLngToContainerPoint([g.lat, g.lon]);
      const cx = Math.floor(pt.x / GRID_CELL_PX);
      const cy = Math.floor(pt.y / GRID_CELL_PX);
      const key = `${cx}|${cy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(g);
    }
    return grid;
  }


  // Given a click point in container pixels, find the nearest group within its hit radius.
  // We only search the 3x3 neighborhood of grid cells around the click.
  function findHitGroup(containerPt) {
    if (!map || !lastDotGroups?.length) return null;

    const cx = Math.floor(containerPt.x / GRID_CELL_PX);
    const cy = Math.floor(containerPt.y / GRID_CELL_PX);

    let best = null;
    let bestD2 = Infinity;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${cx + dx}|${cy + dy}`;
        const bucket = lastDotGroupsGrid?.get(key);
        if (!bucket) continue;

        for (const g of bucket) {
          const pt = map.latLngToContainerPoint([g.lat, g.lon]);
          const total = g.total ?? g.count ?? 1;
          const r = groupRadiusPx(total) + HIT_PADDING_PX;

          const dxp = pt.x - containerPt.x;
          const dyp = pt.y - containerPt.y;
          const d2 = dxp * dxp + dyp * dyp;

          if (d2 <= r * r && d2 < bestD2) {
            best = g;
            bestD2 = d2;
          }
        }
      }
    }

    return best;
  }


  // Popup renderer for a location-group.
  // - Shows a breakdown (top N types) + a scrollable, time-sorted event list.
  // - Limits output to keep DOM lightweight and avoid massive popups for dense locations.
  function buildPopupHtmlForGroup(g) {
    const total = g.total ?? g.count ?? 1;
    const breakdown = g.breakdown instanceof Map ? g.breakdown : null;

    // Summary rows: types + counts + %
    let summaryRows = "";
    if (breakdown && breakdown.size) {
      const entries = Array.from(breakdown.entries())
        .map(([type, meta]) => ({ type, count: meta.count, category: meta.category }))
        .sort((a, b) => b.count - a.count);

      summaryRows = entries
        .slice(0, 12)
        .map((e) => {
          const color =
            typeof shadeForType === "function"
              ? shadeForType(e.type, e.category)
              : colorForCategory(e.category);

          return `
            <div style="display:flex;align-items:center;gap:8px;margin:6px 0;">
              <span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;flex:0 0 auto;"></span>
              <div style="flex:1 1 auto;min-width:0;">
                <div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${escapeHtml(e.type)}
                </div>
                <div style="font-size:12px;color:rgba(0,0,0,0.65);">
                  ${e.count.toLocaleString()} (${pct(e.count, total)})
                </div>
              </div>
            </div>
          `;
        })
        .join("");
    }

    // Events list (scrollable)
    const events = Array.isArray(g.events) ? g.events : [];
    const sorted = events.slice().sort((a, b) => b.ts - a.ts);

    const MAX_SHOW = 50;
    const listRows = sorted.slice(0, MAX_SHOW).map((ev) => {
      return `
        <div style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.08);">
          <div style="font-weight:900;">${escapeHtml(ev.type)}</div>
          <div style="font-size:12px;color:rgba(0,0,0,0.70);">${escapeHtml(formatTime(ev.ts))}</div>
          ${ev.addr ? `<div style="font-size:12px;color:rgba(0,0,0,0.70);">${escapeHtml(ev.addr)}</div>` : ""}
        </div>
      `;
    }).join("");

    const moreNote =
      sorted.length > MAX_SHOW
        ? `<div style="font-size:12px;color:rgba(0,0,0,0.65);margin-top:6px;">
             Showing ${MAX_SHOW.toLocaleString()} of ${sorted.length.toLocaleString()} saved details.
           </div>`
        : "";

    return `
      <div style="min-width:260px;max-width:360px;">
        <div style="font-weight:950;font-size:14px;margin-bottom:6px;">
          ${total.toLocaleString()} call${total === 1 ? "" : "s"} at this location
        </div>

        ${summaryRows ? `<div style="margin-bottom:10px;">${summaryRows}</div>` : ""}

        <div style="font-weight:950;margin:6px 0;">Events</div>
        <div style="max-height:220px;overflow:auto;padding-right:6px;">
          ${listRows || `<div style="font-size:12px;color:rgba(0,0,0,0.65);">No event details saved for this point.</div>`}
        </div>
        ${moreNote}
      </div>
    `;
  }

  // ------------------ Incident canvas layer ------------------
  const ICON_SPRITE_PX = 20;


  // Canvas overlay used for dots mode (and pie-cluster rendering).
  // Why custom canvas instead of many Leaflet markers?
  // - tens of thousands of points remain interactive/fast
  // - avoids DOM churn and marker layout costs
  //
  // Pointer events are disabled on the canvas; interactivity is implemented via our
  // click hit-test grid (see buildGroupsGrid/findHitGroup) and Leaflet popups.
  const IncidentCanvasLayer = L.Layer.extend({
    initialize() {
      this._canvas = null;
      this._map = null;
      this._rawGroups = [];
      this._raf = null;
      this._pointCount = 0;
    },

    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create("canvas", "incident-canvas-layer");
      this._canvas.style.position = "absolute";
      this._canvas.style.pointerEvents = "none";
      map.getPanes().overlayPane.appendChild(this._canvas);

      map.on("move zoom resize", this._reset, this);
      this._reset();
    },

    onRemove(map) {
      map.off("move zoom resize", this._reset, this);
      if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
      this._canvas = null;
      this._map = null;
    },

    setGroups(groups) {
      this._rawGroups = groups || [];
      this._queueRedraw();
    },

    setVisible(isVisible) {
      if (this._canvas) this._canvas.style.display = isVisible ? "block" : "none";
      if (isVisible) this._queueRedraw();
    },

    setPointCount(n) {
      this._pointCount = n || 0;
      this._queueRedraw();
    },


    _reset() {
      if (!this._map || !this._canvas) return;
      const size = this._map.getSize();
      const topLeft = this._map.containerPointToLayerPoint([0, 0]);

      this._canvas.width = size.x;
      this._canvas.height = size.y;

      L.DomUtil.setPosition(this._canvas, topLeft);
      this._queueRedraw();
    },

    _queueRedraw() {
      if (!this._map || !this._canvas) return;
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => this._redraw());
    },

    _redraw() {
      if (!this._map || !this._canvas) return;
      const ctx = this._canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

      const zoom = this._map.getZoom();
      let groups = this._rawGroups;

      const pointCount = this._pointCount || 0;
      const isSmall = pointCount < SMALL_POINT_COUNT;

      const isZoomedIn = zoom >= ZOOM_IN_MIN;
      const isMidZoom = zoom >= ZOOM_MID_MIN && zoom < ZOOM_IN_MIN;
      const isFarZoom = zoom < ZOOM_MID_MIN;

      const pointsOnly = isFarZoom && !isSmall;

      const allowIcons = (isZoomedIn || isSmall) && groups.length < 20000;


      // Icons are only drawn when we're zoomed in enough AND the number of groups is reasonable.
      // Drawing many sprites is more expensive than circles, so we gate it to protect FPS.
      const bounds = this._map.getBounds();

      // If an insane number of groups exists, do a lightweight pixel-binning (by cell)
      // to keep UI responsive. Merge totals + breakdown maps.

      // Safety valve: when the number of groups is huge, we bin in pixel-space to keep
      // the draw loop bounded. We merge totals + breakdown maps, and keep a small event sample.
      const MAX_DRAW = 200000;
      if (groups.length > MAX_DRAW) {
        const cell = zoom <= 12 ? 24 : zoom <= 13 ? 18 : 14;
        const m = new Map();

        for (const g of groups) {
          if (!bounds.contains([g.lat, g.lon])) continue;

          const pt = this._map.latLngToContainerPoint([g.lat, g.lon]);
          const cx = Math.round(pt.x / cell);
          const cy = Math.round(pt.y / cell);
          const key = `${cx}|${cy}`;

          const existing = m.get(key);
          if (!existing) {
            const bd = new Map();
            if (g.breakdown instanceof Map) {
              for (const [t, meta] of g.breakdown.entries()) {
                bd.set(t, { count: meta.count, category: meta.category });
              }
            }

            m.set(key, {
              lat: g.lat,
              lon: g.lon,
              x: pt.x,
              y: pt.y,
              total: g.total ?? g.count ?? 1,
              breakdown: bd,
              events: Array.isArray(g.events) ? g.events.slice(0, 30) : [],
              _preProjected: true, // x/y already in container pixels; skip latLngToContainerPoint
            });
          } else {
            const addTotal = g.total ?? g.count ?? 1;
            existing.total += addTotal;

            if (g.breakdown instanceof Map) {
              for (const [t, meta] of g.breakdown.entries()) {
                const cur = existing.breakdown.get(t);
                if (!cur) existing.breakdown.set(t, { count: meta.count, category: meta.category });
                else cur.count += meta.count;
              }
            }

            // Keep a small sample of events in binned mode
            if (Array.isArray(g.events) && existing.events.length < 30) {
              for (const ev of g.events) {
                if (existing.events.length >= 30) break;
                existing.events.push(ev);
              }
            }
          }
        }

        groups = Array.from(m.values());
      }

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      for (const g of groups) {
        if (!g._preProjected && !bounds.contains([g.lat, g.lon])) continue;

        const pt = g._preProjected
          ? { x: g.x, y: g.y }
          : this._map.latLngToContainerPoint([g.lat, g.lon]);

        const x = pt.x;
        const y = pt.y;

        const total = g.total ?? g.count ?? 1;
        const breakdown = g.breakdown instanceof Map ? g.breakdown : null;

        const r = groupRadiusPx(total);

        if (pointsOnly) {
            // Render as a small dot (no pies, no numbers, no icons)
            const fill = colorForCategory(g.category);
            ctx.beginPath();
            ctx.arc(x, y, 2.0, 0, Math.PI * 2);
            ctx.fillStyle = fill;
            ctx.globalAlpha = 0.9;
            ctx.fill();
            ctx.globalAlpha = 1;
            continue;
        }


        // MULTI-TYPE => PIE
        if (breakdown && breakdown.size > 1) {
          const entries = Array.from(breakdown.entries())
            .map(([type, meta]) => ({ type, count: meta.count, category: meta.category }))
            .sort((a, b) => b.count - a.count);

          let start = -Math.PI / 2; // 12 o'clock

          for (const e of entries) {
            const frac = e.count / (total || 1);
            const end = start + frac * Math.PI * 2;

            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.arc(x, y, r, start, end);
            ctx.closePath();

            const fill =
              typeof shadeForType === "function"
                ? shadeForType(e.type, e.category)
                : colorForCategory(e.category);

            ctx.fillStyle = fill;
            ctx.globalAlpha = 0.92;
            ctx.fill();
            ctx.globalAlpha = 1;

            start = end;
          }

          // outline ring
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.lineWidth = 1.25;
          ctx.strokeStyle = "rgba(0,0,0,0.25)";
          ctx.stroke();

          // total label
          ctx.font = `900 ${total >= 100 ? 12 : 12}px system-ui, -apple-system, Segoe UI, sans-serif`;

          // halo for contrast
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(0,0,0,0.35)";
          ctx.strokeText(String(total), x, y);

          ctx.fillStyle = "#fff";
          ctx.fillText(String(total), x, y);

          continue;
        }

        // SINGLE-TYPE => bubble / icon / dot
        let cat = g.category;
        if (breakdown && breakdown.size === 1) {
          const onlyMeta = Array.from(breakdown.values())[0];
          cat = onlyMeta?.category || cat;
        }
        const fill = colorForCategory(cat);

        if (total > 1) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = fill;
          ctx.globalAlpha = 0.92;
          ctx.fill();
          ctx.globalAlpha = 1;

          ctx.lineWidth = 1;
          ctx.strokeStyle = "rgba(0,0,0,0.18)";
          ctx.stroke();

          ctx.fillStyle = "#fff";
          ctx.font = `700 ${total >= 100 ? 11 : 12}px system-ui, -apple-system, Segoe UI, sans-serif`;
          ctx.fillText(String(total), x, y);
        } else if (allowIcons && iconFontReadyRef()) {
          const sprite = spriteForCategory(cat);
          const half = ICON_SPRITE_PX / 2;
          ctx.drawImage(sprite, x - half, y - half);
        } else {
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = fill;
          ctx.fill();
        }
      }
    },
  });

  // ------------------ Region helpers ------------------

  // Region helpers
  // --------------
  // We support a single active region shape (rectangle or polygon) used as a filter predicate.
  // For polygons, we use a ray-casting point-in-polygon test on the outer ring.
  function pointInPolygon(lat, lon, latlngs) {
    // ray casting
    let inside = false;
    for (let i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++) {
      const xi = latlngs[i].lng, yi = latlngs[i].lat;
      const xj = latlngs[j].lng, yj = latlngs[j].lat;

      const intersect =
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-9) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }


  // Fast predicate used by higher-level app filtering:
  // - bounds check first (cheap)
  // - rectangles short-circuit to bounds (since rectangle == its bounds)
  // - polygons fall back to point-in-polygon for the outer ring
  function passesRegionFilter(p) {
    if (!regionLayer || !regionBounds) return true;
    if (!regionBounds.contains([p.lat, p.lon])) return false;

    if (regionLayer instanceof L.Rectangle) return true;

    if (Array.isArray(regionLatLngs) && regionLatLngs.length >= 3) {
      return pointInPolygon(p.lat, p.lon, regionLatLngs);
    }
    return true;
  }

  function hasRegion() {
    return !!regionLayer;
  }

  // ------------------ Map init ------------------

  // Initialize Leaflet map + all mode layers + region draw tools.
  // NOTE: This function should only be called once per controller instance.
  function initMap() {
    map = L.map(mapDiv, { preferCanvas: true }).setView([35.0844, -106.6504], 12);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    dotsCanvasLayer = new IncidentCanvasLayer();
    dotsCanvasLayer.addTo(map);

    heatLayer = L.heatLayer([], { radius: 18, blur: 14, maxZoom: 17 });

    // Leaflet Draw (region filter)
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    drawControl = new L.Control.Draw({
      edit: { featureGroup: drawnItems, edit: false, remove: false },
      draw: {
        polygon: { allowIntersection: false, showArea: true },
        rectangle: true,
        polyline: false,
        circle: false,
        marker: false,
        circlemarker: false,
      },
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, (e) => {
      drawnItems.clearLayers();
      drawnItems.addLayer(e.layer);

      regionLayer = e.layer;
      regionBounds = e.layer.getBounds ? e.layer.getBounds() : null;

      if (e.layer instanceof L.Polygon && !(e.layer instanceof L.Rectangle)) {
        regionLatLngs = e.layer.getLatLngs()?.[0] || null;
      } else {
        regionLatLngs = null;
      }

      closeMapOverlay();
      if (typeof onRegionChanged === "function") onRegionChanged();
    });

    overlayEl?.addEventListener("click", closeMapOverlay);

    drawRegionBtn?.addEventListener("click", () => {
      openMapOverlay();
      setStatus("Draw a region using the map draw tools (polygon/rectangle).");
    });

    clearRegionBtn?.addEventListener("click", () => {
      regionLayer = null;
      regionBounds = null;
      regionLatLngs = null;
      drawnItems?.clearLayers();
      invalidateZipCache();
      if (typeof onRegionChanged === "function") onRegionChanged();
    });

    // Rebuild hit-test grid when map moves/zooms (screen-space cells shift)
    map.on("move zoom", () => {
      if (currentMode === "dots" && lastDotGroups?.length) {
        lastDotGroupsGrid = buildGroupsGrid(lastDotGroups);
      }
    });

    // Click popups for dots/pies
    map.on("click", (e) => {
      if (currentMode !== "dots") return;
      if (!lastDotGroups?.length) return;

      const containerPt = map.latLngToContainerPoint(e.latlng);
      const hit = findHitGroup(containerPt);
      if (!hit) return;

      L.popup({ maxWidth: 380, closeButton: true, autoPan: true })
        .setLatLng([hit.lat, hit.lon])
        .setContent(buildPopupHtmlForGroup(hit))
        .openOn(map);
    });
  }

  // ------------------ Overlay expand / collapse ------------------

  // Overlay controls:
  // When expanded, we invalidateSize so Leaflet recomputes pixel transforms for the new layout.
  function openMapOverlay() {
    if (overlayEl) overlayEl.style.display = "block";
    if (topCardEl) topCardEl.classList.add("map-expanded");
    setTimeout(() => map?.invalidateSize?.(), 60);
  }

  function closeMapOverlay() {
    if (overlayEl) overlayEl.style.display = "none";
    if (topCardEl) topCardEl.classList.remove("map-expanded");
    setTimeout(() => map?.invalidateSize?.(), 60);
  }

  // ------------------ Layers + opacity ------------------

  // Remove visual layers for the currently inactive modes and clear any derived state.
  // Caller is responsible for re-drawing after data/filter changes.
  function clearMapLayers() {
    if (map && heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
    if (map && zipLayer && map.hasLayer(zipLayer)) map.removeLayer(zipLayer);
    dotsCanvasLayer?.setGroups([]);

    lastDotGroups = [];
    lastDotGroupsGrid = null;
  }


  // Leaflet.heat does not expose an official opacity API, so we adjust the underlying canvas.
  // This relies on internal properties (_heat/_canvas) and may need updating on plugin upgrades.
  function applyHeatOpacity(opacity) {
    try {
      const canvas = heatLayer?._heat?._canvas || heatLayer?._canvas;
      if (canvas?.style) canvas.style.opacity = String(opacity);
    } catch {}
  }

  // ------------------ Mode UI ------------------

  // Keeps UI buttons/panels in sync with the current mode.
  // Also increments drawGen so any pending async work can be treated as stale by future guards.
  function setModeUI(mode) {
    currentMode = mode;
    drawGen++;

    modeDotsBtn?.classList.toggle("btn-on", mode === "dots");
    modeHeatBtn?.classList.toggle("btn-on", mode === "heat");
    modeZipBtn?.classList.toggle("btn-on", mode === "zips");

    if (heatOpacityPanel) heatOpacityPanel.style.display = mode === "heat" ? "block" : "none";
    if (mode === "heat" && heatOpacityEl && heatOpacityValEl) {
      heatOpacityValEl.textContent = `${Math.round(+heatOpacityEl.value || 75)}%`;
    }
  }

  // ------------------ Dots drawing (aggregates by location + stores event details) ------------------

  // Groups points by (lat,lon) rounded to 6 decimals (~0.11m lat; lon varies by latitude).
  // This reduces overplotting and enables per-location breakdown + popup event lists.
  // If the upstream data already clusters points, consider lowering precision or providing a stable key.
  function buildDotGroups(filteredPoints) {
    const m = new Map();
    const MAX_DETAILS_PER_LOCATION = 120;

    for (const p of filteredPoints) {
      const locKey = `${p.lat.toFixed(6)}|${p.lon.toFixed(6)}`;
      let g = m.get(locKey);

      if (!g) {
        g = {
          lat: p.lat,
          lon: p.lon,
          total: 0,
          breakdown: new Map(), // type -> { count, category }
          events: [],           // capped list of { ts, type, addr }
        };
        m.set(locKey, g);
      }

      g.total += 1;

      const cur = g.breakdown.get(p.type);
      if (!cur) g.breakdown.set(p.type, { count: 1, category: p.category });
      else cur.count += 1;

      if (g.events.length < MAX_DETAILS_PER_LOCATION) {
        g.events.push({ ts: p.ts, type: p.type, addr: p.addr || "" });
      }
    }

    return Array.from(m.values());
  }

  // Render points in dots mode.
  // At low zoom we render single dots per point and disable popups/hit-testing for speed.
  // At higher zoom we aggregate into location-groups to enable pie rendering and detailed popups.
  function drawDots(filteredPoints) {
    if (map && heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
    if (map && zipLayer && map.hasLayer(zipLayer)) map.removeLayer(zipLayer);

    dotsCanvasLayer?.setVisible(true);

    const zoom = map?.getZoom?.() ?? 0;
    const pointCount = filteredPoints?.length ?? 0;
    dotsCanvasLayer?.setPointCount(pointCount);
    const simpleDots = zoom <= SIMPLE_DOTS_MAX_ZOOM;

    const isSmall = pointCount < SMALL_POINT_COUNT;
    const isFarZoom = zoom < ZOOM_MID_MIN;

    const pointsOnly = isFarZoom && !isSmall;

    const groups = pointsOnly
      ? filteredPoints.map((p) => ({
          lat: p.lat,
          lon: p.lon,
          category: p.category,
          total: 1,
        }))
      : buildDotGroups(filteredPoints);

    dotsCanvasLayer?.setGroups(groups);

    // Only enable hit-testing + popups when NOT in simple-dots mode
    if (!pointsOnly) {
      lastDotGroups = groups;
      lastDotGroupsGrid = buildGroupsGrid(groups);
    } else {
      lastDotGroups = [];
      lastDotGroupsGrid = null;
    }

  }


  // ------------------ Heat drawing ------------------

  // Heat mode: delegates rendering to Leaflet.heat.
  // Note that weights are currently uniform (=1); adjust the 3rd element to use per-point intensity.
  function drawHeat(filteredPoints, heatOpacity) {
    const myGen = ++drawGen;

    // Ensure the heat layer exists
    if (!heatLayer) {
      heatLayer = L.heatLayer([], heatOptions);
    }

    // Ensure it is attached before calling setLatLngs (prevents _map being null)
    if (!heatLayer._map) {
      heatLayer.addTo(map);
    } else if (!map.hasLayer(heatLayer)) {
      heatLayer.addTo(map);
    }

    
    if (map && zipLayer && map.hasLayer(zipLayer)) map.removeLayer(zipLayer);

    dotsCanvasLayer?.setVisible(false);


    const latlngs = filteredPoints.map((p) => [p.lat, p.lon, 1]);
    heatLayer.setLatLngs(latlngs);
    if (map && !map.hasLayer(heatLayer)) heatLayer.addTo(map);

    applyHeatOpacity(heatOpacity);
  }

  // ------------------ ZIP mode ------------------

  // ZIP mode notes
  // --------------
  // We compute counts by testing each point against each ZIP polygon until a match is found.
  // Complexity is roughly O(points * zips) but reduced by per-ring bounding boxes + early breaks.
  // Caching via lastZipKey/lastZipCounts avoids recomputation when filters haven't changed.
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function bboxForRing(ring) {
    let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
    for (const pt of ring) {
      const lon = pt[0], lat = pt[1];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    return { minLat, minLon, maxLat, maxLon };
  }

  function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];

      const intersect =
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-9) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInPolygonRings(lat, lon, rings) {
    if (!rings?.length) return false;
    if (!pointInRing(lat, lon, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(lat, lon, rings[i])) return false;
    }
    return true;
  }


  // Fetches ZIP boundary GeoJSON from an ArcGIS REST endpoint.
  // Assumes properties include ZIP_CODE and geometry is in WGS84 (outSR=4326).
  async function fetchZipGeoJSONIfNeeded() {
    if (zipGeoJSON && zipFeatureMeta) return;

    const url =
      ZIP_QUERY_URL +
      "?" +
      new URLSearchParams({
        where: "1=1",
        outFields: "ZIP_CODE,PO_NAME",
        returnGeometry: "true",
        outSR: "4326",
        f: "geojson",
        resultRecordCount: "2000",
      }).toString();

    const data = await arcgisFetch(url, "Loading ZIP code boundaries…");

    zipGeoJSON = data;
    zipFeatureMeta = [];

    for (const f of zipGeoJSON.features || []) {
      const zip = f.properties?.ZIP_CODE ?? "—";
      const geom = f.geometry;
      const ringsList = [];

      if (geom?.type === "Polygon") {
        ringsList.push(geom.coordinates);
      } else if (geom?.type === "MultiPolygon") {
        for (const poly of geom.coordinates) ringsList.push(poly);
      }

      const bboxes = ringsList.map((rings) => bboxForRing(rings[0]));

      zipFeatureMeta.push({
        zip,
        ringsList,
        bboxes,
        leafletLayer: null,
      });
    }

    zipLayer = L.geoJSON(zipGeoJSON, {
      style: () => ({
        weight: 1,
        color: "rgba(43,38,34,0.45)",
        fillColor: "rgba(42,157,143,0.12)",
        fillOpacity: 0.55,
      }),
      onEachFeature: (feature, layer) => {
        const zip = feature?.properties?.ZIP_CODE ?? "—";
        layer.bindPopup(`ZIP ${zip}`);

        const meta = zipFeatureMeta.find((m) => m.zip === zip);
        if (meta) meta.leafletLayer = layer;
      },
    });
  }

  function zipColor(count, maxCount) {
    if (!maxCount || maxCount <= 0) return "rgba(42,157,143,0.12)";
    const t = clamp(count / maxCount, 0, 1);
    const a = 0.10 + t * 0.55; // 0.10..0.65
    return `rgba(42,157,143,${a})`;
  }

  function getChoroplethColor(intensity) {
      // intensity is 0 to 1
      // Stop colors: Green (#2a9d8f) -> Yellow (#e9c46a) -> Red (#dd1616)
      if (intensity > 0.8) return '#dd1616'; // High (Red)
      if (intensity > 0.6) return '#f4a261'; // Mid-High (Orange)
      if (intensity > 0.4) return '#e9c46a'; // Mid (Yellow)
      if (intensity > 0.2) return '#8ab17d'; // Mid-Low (Lime)
      return '#2a9d8f';                      // Low (Green)
  }

  function buildZipKey(state) {
    // state: {min,max,dow,hour,regionKey,legendKey,showAllTypes}
    return [
      state.min,
      state.max,
      state.dow ?? "x",
      state.hour ?? "x",
      state.regionKey ?? "R:0",
      state.legendKey ?? "L:0",
      state.showAllTypes ? "all" : "top",
    ].join("::");
  }


  // Compute ZIP counts for the provided points.
  // We precompute bboxes per outer ring and do:
  //   bbox reject -> point-in-polygon with holes -> increment -> break out.
  // If performance becomes an issue, consider:
  // - spatial index (R-tree) for ZIP bboxes
  // - mapping points to ZIPs server-side
  function computeZipCounts(points) {
    const counts = new Map();
    if (!zipFeatureMeta?.length) return counts;

    for (const p of points) {
      for (const meta of zipFeatureMeta) {
        let matched = false;
        for (let i = 0; i < meta.ringsList.length; i++) {
          const bb = meta.bboxes[i];
          if (
            p.lat < bb.minLat || p.lat > bb.maxLat ||
            p.lon < bb.minLon || p.lon > bb.maxLon
          ) continue;

          if (pointInPolygonRings(p.lat, p.lon, meta.ringsList[i])) {
            counts.set(meta.zip, (counts.get(meta.zip) || 0) + 1);
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    }
    return counts;
  }

  function invalidateZipCache() {
    lastZipKey = null;
    lastZipCounts = null;
  }


  // ------------------ Public draw() ------------------
  async function draw(mode, filteredPoints, heatOpacity) {
    if (mode === "dots") await ensureIconFontReady();

    if (mode === "dots") return drawDots(filteredPoints);
    if (mode === "heat") return drawHeat(filteredPoints, heatOpacity);

    // For zips, caller provides cache key parts via getZipStateKeyObj()
    throw new Error("ZIP mode requires drawZipswithKey(filteredPoints, zipStateKeyObj)");
  }

  // ZIP draw is separate so app can provide a stable cache-key object

  // ZIP draw is exposed separately so the caller can supply a stable cache-key object.
  async function drawZipsWithKey(filteredPoints, zipStateKeyObj) {
    const myGen = ++drawGen;
    // If we ever add async cancellation, compare a captured generation value (myGen) to drawGen
    // before applying results. For now we keep myGen as a placeholder for that pattern.
    await fetchZipGeoJSONIfNeeded();

    if (myGen !== drawGen || currentMode !== "zips") return;


    if (map && heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
    dotsCanvasLayer?.setVisible(false);

    if (zipLayer && map && !map.hasLayer(zipLayer)) zipLayer.addTo(map);

    const key = buildZipKey(zipStateKeyObj);
    if (key !== lastZipKey) {
      lastZipKey = key;
      lastZipCounts = computeZipCounts(filteredPoints);
    }

    const counts = lastZipCounts || new Map();
    let maxCount = 0;
    for (const c of counts.values()) maxCount = Math.max(maxCount, c);

    for (const meta of zipFeatureMeta) {
        const c = counts.get(meta.zip) || 0;
        
        // Normalize count to a 0.0 - 1.0 scale
        const intensity = maxCount > 0 ? c / maxCount : 0;
        const fill = getChoroplethColor(intensity);

        if (meta.leafletLayer) {
            meta.leafletLayer.setStyle({
                fillColor: fill,
                fillOpacity: 0.5,      // Semi-transparent as requested
                color: "white",       // Border color
                weight: 1.5,          // Border thickness
                opacity: 0.8          // Border opacity
            });
            
            // Update the popup with more detail
            meta.leafletLayer.setPopupContent(`
                <div style="text-align:center;">
                    <strong style="font-size:14px;">ZIP ${meta.zip}</strong><br/>
                    <span style="font-size:18px; font-weight:900;">${c.toLocaleString()}</span><br/>
                    <span style="color:var(--muted); font-size:11px;">INCIDENTS</span>
                </div>
            `);
        }
    }
}

  return {
    initMap,
    clearMapLayers,
    setModeUI,
    applyHeatOpacity,
    passesRegionFilter,
    hasRegion,
    invalidateZipCache,
    draw,
    drawZipsWithKey,
    get regionKey() {
      if (!regionBounds) return "R:0";
      return `R:${regionBounds.getSouthWest().lat.toFixed(3)},${regionBounds.getSouthWest().lng.toFixed(3)}:${regionBounds.getNorthEast().lat.toFixed(3)},${regionBounds.getNorthEast().lng.toFixed(3)}`;
    },
    set onRegionChanged(fn) { onRegionChanged = fn; },
    get onRegionChanged() { return onRegionChanged; },
    openMapOverlay,
    closeMapOverlay,
  };
}
