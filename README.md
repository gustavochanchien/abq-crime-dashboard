# ABQ Incidents Dashboard

A client-side, map-driven dashboard for exploring Albuquerque 911 incident history from CABQ Open Data (ArcGIS MapServer).

* **Live demo:** [https://gustavochanchien.github.io/abq-crime-dashboard/](https://gustavochanchien.github.io/abq-crime-dashboard/)
* **Primary data source:** CABQ Incidents MapServer layer 0
  `https://coageo.cabq.gov/cabqgeo/rest/services/Incidents/MapServer/0` 

---

## High-level features

* **Interactive map with three render modes**

  * **Dots:** fast canvas overlay with hit-tested clusters and detail popups.
  * **Heat:** Leaflet.heat density layer with adjustable opacity.
  * **ZIP Codes:** choropleth by ZIP, colored by incident count. 

* **Time slider over incident history**

  * Initial view shows ~30 days for fast first paint.
  * Background backfill up to 2 years (but API only provides 6 months). 

* **Call-type legend & filters**

  * Category mode: top N categories + “Other”.
  * All-types mode: every call type grouped under its category.
  * Cmd/Ctrl+click “solo” selection for quick focus. 

* **Trend summaries & KPIs**

  * Timeline chart (day/week/month, aggregate vs split by category/type).
  * Average incidents by day-of-week and by hour-of-day with mini-filters.
  * KPIs: total incidents, date range, top call type, peak period, active filters. 

* **Region selection filtering**

  * Optional polygon drawing via Leaflet.draw; map, charts, and KPIs re-compute on region changes. 

---

## Architecture overview

The dashboard is a **single-page, static web app**:

* **`index.html`**

  * Declares the UI layout (map, filters, legend, KPIs, charts).
  * Loads third-party libraries from CDNs:

    * Leaflet, Leaflet.heat, Leaflet.draw
    * noUiSlider (time range control)
    * Chart.js (trend charts)
    * Bootstrap Icons (category glyphs) 
  * Boots the ES module entrypoint `app.js`. 

* **`app.js`**

  * Orchestrator and “application layer”.
  * Responsibilities:

    * Fetching & normalizing incident data from ArcGIS.
    * Fetching ZIP polygons.
    * Managing global filter state (time window, region, legend, DOW/hour filters).
    * Wiring events between UI, map controller, and trends controller. 

* **`map-module.js`**

  * “MapController”: owns Leaflet `L.Map` plus the three render modes (dots, heat, ZIP choropleth).
  * Manages region geometry, hit testing, and map overlay UI.
  * Caches ZIP polygons and counts for performance. 

* **`trends-module.js`**

  * “TrendsController”: owns legend, charts, KPI cards, and DOW/hour filter state.
  * Built on Chart.js and plain DOM updates.
  * Notifies the app when filters change so the pipeline can re-run. 

---

## Data model & pipeline

### Data model

Incidents are normalized to a lightweight `point` structure in `app.js`:

* **Per-incident fields** (after normalization):

  * `ts`: timestamp in **epoch milliseconds** (UTC).
  * `lat`, `lon`: numeric coordinates.
  * `type`: call type string from the CAD/incident dataset.
  * `category`: derived from `type` via a stable `categoryForType` helper.
  * `addr`: human-readable address (used only in popups). 

All internal time calculations use epoch ms; day-level queries snap to `startOfDay` / `endOfDay` helpers to align with ArcGIS `time=` semantics. 

### Time range loading strategy

To keep the app snappy while still supporting larger history:

* **Configuration knobs:**

  * `INITIAL_DAYS`: days of data requested for first render.
  * `DEFAULT_VIEW_DAYS`: default slider window.
  * `MAX_YEARS_BACK`: hard cap on how far back history can go.
  * `BACKFILL_STEP_DAYS`: chunk size for background backfill.
  * `PAGE_SIZE`: ArcGIS page size. 

* **Boot sequence:**

  * Fetch layer metadata (`/layer?f=pjson`) to detect the time extent.
  * Compute `absoluteMinAllowed` / `absoluteMaxAllowed` by combining:

    * Browser “now”
    * Layer min/max time extent
    * `MAX_YEARS_BACK`
  * Fetch `INITIAL_DAYS` ending at `absoluteMaxAllowed`.
  * Normalize, sort, and store into `pointsSorted`.
  * Initialize slider & controllers.
  * Start `loadAllHistoryInBackground()` to walk backwards in `BACKFILL_STEP_DAYS` and append older incidents. 

### Filtering pipeline

At any time, the currently displayed set is computed as:

1. **Time window filter**

   * Controlled by the noUiSlider (`#slider`).
   * Maps slider handles → `[currentMinTime, currentMaxTime]` in ms.
   * Applied by binary searching `pointsSorted` to slice the active window (efficient even for large histories).

2. **Region filter (optional)**

   * MapController exposes `passesRegionFilter(point)` and `hasRegion`.
   * A point is kept only if it lies inside the drawn region polygon (if present). 

3. **Legend filter**

   * Two modes:

     * Category mode: uses `activeCategorySet` against an “effective” category key (`Other` bucket for non-top categories).
     * All-types mode: uses `activeTypeSet` of individual call types.
   * Both selections are stored as `Set`s; pruning logic ensures selections stay valid when the visible legend changes without silently adding new items. 

4. **Day-of-week & hour filters**

   * Trend charts allow clicking on bars to filter to specific DOW or hour.
   * State is kept as `selectedDOW` (0–6) and `selectedHour` (0–23).
   * Chips (“Filter: none / Mon / 14:00”) reflect current mini-filters. 

The **same filtered array** feeds:

* Map rendering (`mapCtl.draw` / `drawZipsWithKey`)
* Timeline chart
* DOW/hour charts
* KPI computation

This keeps all views in sync while keeping the logic centralized.

---

## Map subsystem (`map-module.js`)

### Responsibilities

The MapController is constructed with DOM hooks, callbacks, and helpers:

* DOM elements: `mapDiv`, mode buttons, heat opacity slider panel.
* Status and fetch helpers: `setStatus`, `arcgisFetch`, `ZIP_QUERY_URL`.
* Styling helpers: `colorForCategory`, `spriteForCategory`, `shadeForType`, `iconGlyphForCategory`.
* Icon-font readiness hooks so the custom canvas layer can render glyphs correctly. 

### Render modes

1. **Dots mode (default)**

   * Uses a custom canvas overlay (`dotsCanvasLayer`) rather than thousands of Leaflet markers.
   * Two sub-modes based on zoom:

     * **Simple dots** (low zoom): one dot per incident, no hit testing.
     * **Clustered locations** (higher zoom): incidents are aggregated by `(lat, lon)` rounded to 6 decimals and represented as “location groups”. 
   * Each group stores:

     * `total` incidents
     * `breakdown: Map<type, {count, category}>`
     * `events`: capped list of `{ ts, type, addr }` for popup details. 
   * Click handling:

     * Screen-space grid (`GRID_CELL_PX` sized cells) indexes groups.
     * On click, only groups in a 3x3 neighborhood of cells are distance-checked to find the closest hit.
     * Popups show a breakdown (with percentages) and a scrollable event list (time, type, address). 
   * Care is taken to **escape HTML** for untrusted strings (type, address) before building popup HTML. 

2. **Heat mode**

   * Uses `L.heatLayer` with `[lat, lon, weight]` tuples.
   * Weight is currently uniform (`1` per incident) but the third field is ready for intensity weighting.
   * MapController ensures the heat layer is attached before calling `setLatLngs` to avoid `_map` null issues.
   * Heat opacity is controlled by a simple `<input type="range">` in `#heat-opacity-panel`. 

3. **ZIP choropleth mode**

   * ZIP polygons fetched on demand via `ZIP_QUERY_URL` as GeoJSON.
   * For each polygon:

     * Precomputes per-ring bounding boxes.
     * Stores `{ zip, ringsList, bboxes, leafletLayer }` metadata in `zipFeatureMeta`.
   * Counting algorithm:

     * For each point, test against ring bounding boxes and then point-in-polygon until the containing ZIP is found.
     * Complexity is nominally O(points × zips) but reduced by the bounding boxes and early exits. 
   * Caching:

     * `lastZipKey` summarises the “filter state” (time window, legend selection, region).
     * `lastZipCounts` stores computed counts per ZIP.
     * If the key matches, only styles are updated; counts are not recomputed. 

### Region drawing & overlay

* Uses Leaflet.draw to manage:

  * Editable layer group (`drawnItems`).
  * Draw controls (`drawControl`) with polygon mode enabled.
* Keeps:

  * `regionBounds` (Leaflet bounds)
  * `regionLatLngs` (lat/lon sequence for point-in-polygon tests)
* Exposes:

  * `passesRegionFilter(point)`
  * `hasRegion`
  * `regionKey` (approximate, rounded bounds string used in cache keys). 

---

## Trends subsystem (`trends-module.js`)

### Controller responsibilities

The TrendsController takes DOM elements and helpers and returns an API used by `app.js`. It owns:

* Chart instances (`timelineChart`, `dowChart`, `hourChart`).
* Legend state (category vs all-types, selected categories/types).
* Mini-filters (selected day of week / hour).
* KPI elements and formatting helpers (`formatRange`, `formatDate`, `DAY_MS`). 

### Legend modes

1. **Category mode**

   * Computes counts by `p.category` for the current time slice.
   * Picks top N (default 10) categories by count; all others are aggregated under `"Other"`.
   * Visible legend entries are sorted by count descending; each shows a colored dot, category name, and count.
   * Selection:

     * `activeCategorySet` tracks which categories are “on”.
     * Cmd/Ctrl+click “solo” selects only that category.
     * Selection changes trigger `invalidateZipCache()` and `onFiltersChanged()`. 

2. **All-types mode**

   * Computes counts by `p.type`.
   * Groups types under their `categoryForType(type)` header.
   * Category rows have tri-state checkboxes (checked / indeterminate / unchecked) depending on how many of their types are selected.
   * Individual type rows use `shadeForType(type, category)` to generate per-type color variants. 

The controller also exposes a `resetLegendSelection()` method used at boot to “select all” once the initial legend has been built. 

### Charts

* **Timeline chart**

  * Grouping:

    * `day`: each day
    * `week`: Monday-based weekly buckets (compute Monday, zero out time, use as key)
    * `month`: year-month key.
  * Label formatting uses `toLocaleDateString` with contextual options for each grouping. 
  * Two modes:

    * Aggregate (single series “Incidents”).
    * Split series by category or call type, with colors derived from category/type.

* **Day-of-week chart**

  * Normalized to **average per day** across the current time window.
  * Click toggles a `selectedDOW`; non-selected bars fade, selected bar stays bold.
  * Clicking again clears the filter. 

* **Hour-of-day chart**

  * Similar pattern to DOW chart; counts binned by `new Date(p.ts).getHours()`, then normalized by number of days in range.
  * Selected hour is stored in `selectedHour`, with faded vs highlighted bars. 

### KPIs & chips

* `updateKPIs` takes the filtered incident list plus context (`currentMinTime`, `currentMaxTime`, `hasRegion`, `legendIsNarrowed`) and updates:

  * **Total incidents** in range.
  * **Range label** via `formatRange`.
  * **Top call type** and its count.
  * **Peak period** (by DOW/hour summary).
  * **Active filters** descriptor (e.g. “Region + Legend filters”). 

* `updateMiniFilterChipsUI` keeps the DOW/hour chips in sync with the current selection. 

---

## Orchestration (`app.js`)

At a high level, `app.js`:

* Grabs all required DOM elements via a small `requireEl` helper (throws if missing). 

* Constructs:

  * `mapCtl = createMapController({ … })`
  * `trendsCtl = createTrendsController({ … })`

* Defines:

  * Global filtering state (time window, legend, region, DOW/hour).
  * A central `redrawAll()` that:

    * Applies the filter pipeline.
    * Invokes `mapCtl.draw(..)` / `drawZipsWithKey(..)`.
    * Updates charts and KPIs via `trendsCtl`.

* Wires UI events:

  * Mode buttons (`#mode-dots`, `#mode-heat`, `#mode-zip`) switch `viewMode` and call `mapCtl.setModeUI(viewMode)` then `redrawAll()`. 
  * Slider change callback updates the current time window and triggers redraw.
  * TrendsController’s `onFiltersChanged` callback is set to `redrawAll`.
  * MapController’s `onRegionChanged` callback also calls `redrawAll` and updates the “Active filters” KPI.

Boot code takes care to:

* Bring the map up first (`mapCtl.initMap()`).
* Load a small initial range to minimize first-paint latency.
* Initialize slider and default chart settings.
* Ensure the icon font is loaded before the first map render to avoid blank glyphs. 

---

## Technology stack

* **Language & platform**

  * Vanilla JavaScript (ES modules).
  * Static HTML + CSS.

* **Libraries**

  * [Leaflet](https://leafletjs.com/) – basemap, interaction.
  * [Leaflet.heat](https://github.com/Leaflet/Leaflet.heat) – client-side heatmap.
  * [Leaflet.draw](https://github.com/Leaflet/Leaflet.draw) – polygon drawing tools.
  * [noUiSlider](https://refreshless.com/nouislider/) – date range slider.
  * [Chart.js](https://www.chartjs.org/) – charts & mini-filters.
  * [Bootstrap Icons](https://icons.getbootstrap.com/) – glyphs in legend & map popups. 