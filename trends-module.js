// trends-module.js
// Owns: legend (category mode vs all types), charts (timeline/dow/hour), KPIs, and DOW/hour filter state.
//
// Data model assumptions:
// - "points" are objects with at least: { ts: <ms epoch>, type: <string>, category: <string> }
// - categoryForType(type) must be stable (same input => same output) for legend/type mapping.
//
// External deps:
// - Chart.js must be globally available as `Chart` (or imported elsewhere in the app bundle).
//
// Design notes:
// - Legend has two modes:
//   * Category mode: shows top N categories + "Other" bucket (computed per current time slice).
//   * All-types mode: shows all call types, grouped under their category.
// - Selections are stored as Sets. Changing selections invalidates the ZIP cache and triggers an app redraw
//   via `onFiltersChanged`.
//

/**
 * Factory for the "Trends" UI controller.
 *
 * The controller is intentionally stateful: it owns chart instances and the current filter state
 * (legend selection, day-of-week/hour filters, and UI toggle state).
 *
 * @param {Object} deps - All DOM elements and helpers needed to render charts/legend/KPIs.
 * @returns {Object} controller API used by the app to render and query state.
 */

export function createTrendsController({
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
}) {
  // ------------------ Controller state ------------------
  // Filters
  let didInitLegendSelection = false;
  let selectedDOW = null;   // 0..6
  let selectedHour = null;  // 0..23

  // Types / legend
  // Note: In category mode, activeCategorySet stores *legend keys* (top categories + 'Other').
  // In all-types mode, activeTypeSet stores *individual types*.
  let showAllTypes = false;
  let visibleCategories = [];
  let visibleTypes = [];
  let activeCategorySet = new Set();
  let activeTypeSet = new Set();
  let topCategorySet = new Set();
  let didInitTypeSelection = false;

  // Chart.js instances
  // We keep references so we can destroy/recreate charts when the data or configuration changes.
  let timelineChart = null;
  let dowChart = null;
  let hourChart = null;

  // Hook for app redraw
  let onFiltersChanged = null;

  // ZIP cache invalidation hook
  // Some downstream parts of the app build expensive, derived structures (e.g. a ZIP cache key)
  // based on current filters. When any filter changes, we call this hook to force a rebuild.
  let invalidateZipCacheHook = null;
  function invalidateZipCache() {
    if (typeof invalidateZipCacheHook === "function") invalidateZipCacheHook();
  }

  // ------------------ Legend utilities ------------------
  // Map a point's category to a legend key. Categories outside the current top-N collapse into 'Other'.
  // This ensures the legend stays compact while still allowing aggregate visibility.
  function effectiveCategoryKey(p) {
    if (topCategorySet.has(p.category)) return p.category;
    return "Other";
  }

  // Predicate used by upstream filtering logic: does this point pass the current legend selection?
  function legendAllowsPoint(p) {
    if (showAllTypes) return activeTypeSet.has(p.type);
    return activeCategorySet.has(effectiveCategoryKey(p));
  }

  // Utility: count occurrences of keyFn(point) across a list.
  function countBy(points, keyFn) {
    const m = new Map();
    for (const p of points) {
      const k = keyFn(p);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }

  function topNFromCounts(counts, n) {
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k]) => k);
  }

  // Keep active selections valid as the visible legend entries change.
  // Important: this function *only prunes* invalid selections; it does NOT auto-select
  // anything when the selection becomes empty. This allows the UI to intentionally show
  // 'nothing selected' states without surprising the user.
  function ensureDefaultSelections() {
  if (showAllTypes) {
    // Only prune selections that no longer exist, don't auto-fill when empty.
    const visibleSet = new Set(visibleTypes);
    for (const t of Array.from(activeTypeSet)) {
      if (!visibleSet.has(t)) activeTypeSet.delete(t);
    }
    return;
  }

  // Category mode: prune only; don't auto-fill when empty.
  const visibleSet = new Set(visibleCategories);
  for (const c of Array.from(activeCategorySet)) {
    if (!visibleSet.has(c)) activeCategorySet.delete(c);
  }
}


  // Reset legend selection to the current visible universe (categories or types depending on mode).
  function resetLegendSelection() {
    if (showAllTypes) activeTypeSet = new Set(visibleTypes);
    else activeCategorySet = new Set(visibleCategories);
    if (typeof onFiltersChanged === "function") onFiltersChanged();
  }

  // Cmd/Ctrl click is treated as a 'solo' action: select only this item/group.
  function isModClick(e) {
    return !!(e && (e.metaKey || e.ctrlKey));
  }

  // Build legend UI for category mode based on points currently in view.
  // We compute top categories by count (default top 10) and bucket the rest into 'Other'.
  function renderLegendCategoryMode(pointsInSlice) {
    const total = pointsInSlice.length;
    const counts = countBy(pointsInSlice, (p) => p.category);
    const top = new Set(topNFromCounts(counts, 10));
    topCategorySet = top;

    const countsForLegend = new Map();
    let other = 0;
    for (const [cat, c] of counts.entries()) {
      if (top.has(cat)) countsForLegend.set(cat, c);
      else other += c;
    }
    const existingOther = countsForLegend.get("Other") || 0;
    countsForLegend.set("Other", existingOther + other);
    if ((countsForLegend.get("Other") || 0) === 0) countsForLegend.delete("Other");

    visibleCategories = Array.from(countsForLegend.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);

    if (!didInitLegendSelection) {
        didInitLegendSelection = true;
        activeCategorySet = new Set(visibleCategories);
    }

    ensureDefaultSelections();

    legendItemsEl.innerHTML = "";
    for (const cat of visibleCategories) {
      const row = document.createElement("div");
      row.className = "legend-item legend-item--category";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = activeCategorySet.has(cat);

      const dot = document.createElement("span");
      dot.className = `color-dot bi ${iconClassForCategory(cat)}`;
      dot.style.background = colorForCategory(cat);

      const text = document.createElement("span");
      const c = countsForLegend.get(cat) || 0;
      const percent = total > 0 ? ((c / total) * 100).toFixed(1) : 0;
      text.textContent = `${cat} (${c.toLocaleString()}) ${percent}%`;

      row.appendChild(cb);
      row.appendChild(dot);
      row.appendChild(text);

      row.addEventListener("click", (e) => {
        if (e.target === cb) return;
        e.preventDefault();

        if (isModClick(e)) {
          activeCategorySet = new Set([cat]);
        } else {
          if (activeCategorySet.has(cat)) activeCategorySet.delete(cat);
          else activeCategorySet.add(cat);
        }
        cb.checked = activeCategorySet.has(cat);
        invalidateZipCache();
        if (typeof onFiltersChanged === "function") onFiltersChanged();
      });

      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isModClick(e)) {
          activeCategorySet = new Set([cat]);
        } else {
          if (cb.checked) activeCategorySet.add(cat);
          else activeCategorySet.delete(cat);
        }
        invalidateZipCache();
        if (typeof onFiltersChanged === "function") onFiltersChanged();
      });

      legendItemsEl.appendChild(row);
    }
  }

  // Build legend UI for all-types mode.
  // Types are grouped under their category header and can be toggled individually.
  function renderLegendAllTypesMode(pointsInSlice) {
    const total = pointsInSlice.length;
    const countsByType = countBy(pointsInSlice, (p) => p.type);
    visibleTypes = Array.from(countsByType.keys()).sort(
      (a, b) => (countsByType.get(b) || 0) - (countsByType.get(a) || 0)
    );
    if (!didInitTypeSelection) {
        didInitTypeSelection = true;
        if (activeTypeSet.size === 0) activeTypeSet = new Set(visibleTypes);
    }

    const catTotals = new Map();
    const catToTypes = new Map();
    for (const [type, c] of countsByType.entries()) {
      const cat = categoryForType(type);
      catTotals.set(cat, (catTotals.get(cat) || 0) + c);
      if (!catToTypes.has(cat)) catToTypes.set(cat, []);
      catToTypes.get(cat).push({ type, count: c });
    }

    const sortedCats = Array.from(catTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c);

    ensureDefaultSelections();
    legendItemsEl.innerHTML = "";

    for (const cat of sortedCats) {
      const group = document.createElement("div");
      group.className = "legend-group";

      const header = document.createElement("div");
      header.className = "legend-item legend-item--category";

      const catCb = document.createElement("input");
      catCb.type = "checkbox";

      const types = catToTypes.get(cat) || [];
      const selectedCount = types.reduce((acc, t) => acc + (activeTypeSet.has(t.type) ? 1 : 0), 0);
      catCb.checked = selectedCount === types.length && types.length > 0;
      catCb.indeterminate = selectedCount > 0 && selectedCount < types.length;

      const dot = document.createElement("span");
      dot.className = `color-dot bi ${iconClassForCategory(cat)}`;
      dot.style.background = colorForCategory(cat);

      const headerText = document.createElement("span");
      const catTotal = catTotals.get(cat) || 0;
      const catPercent = total > 0 ? ((catTotal / total) * 100).toFixed(1) : 0;
      headerText.textContent = `${cat} (${catTotal.toLocaleString()}) ${catPercent}%`;

      header.appendChild(catCb);
      header.appendChild(dot);
      header.appendChild(headerText);
      group.appendChild(header);

      const sub = document.createElement("div");
      sub.className = "legend-subitems";
      types.sort((a, b) => b.count - a.count);

      header.addEventListener("click", (e) => {
        if (e.target === catCb) return;
        if (isModClick(e)) {
          const only = new Set();
          for (const t of types) only.add(t.type);
          activeTypeSet = only;
        } else {
          const turnOn = !(selectedCount === types.length);
          for (const t of types) {
            if (turnOn) activeTypeSet.add(t.type);
            else activeTypeSet.delete(t.type);
          }
        }
        invalidateZipCache();
        if (typeof onFiltersChanged === "function") onFiltersChanged();
      });

      catCb.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isModClick(e)) {
          const only = new Set();
          for (const t of types) only.add(t.type);
          activeTypeSet = only;
        } else {
          const turnOn = catCb.checked;
          for (const t of types) {
            if (turnOn) activeTypeSet.add(t.type);
            else activeTypeSet.delete(t.type);
          }
        }
        invalidateZipCache();
        if (typeof onFiltersChanged === "function") onFiltersChanged();
      });

      for (const item of types) {
        const row = document.createElement("div");
        row.className = "legend-item legend-item--type";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = activeTypeSet.has(item.type);

        const tdot = document.createElement("span");
        tdot.className = `color-dot bi ${iconClassForCategory(cat)}`;
        tdot.style.background = shadeForType(item.type, cat);

        const text = document.createElement("span");
        const typePercent = total > 0 ? ((item.count / total) * 100).toFixed(1) : 0;
        text.textContent = `${item.type} (${item.count.toLocaleString()}) ${typePercent}%`;

        row.appendChild(cb);
        row.appendChild(tdot);
        row.appendChild(text);

        row.addEventListener("click", (e) => {
          if (e.target === cb) return;
          e.preventDefault();
          if (isModClick(e)) {
            activeTypeSet = new Set([item.type]);
          } else {
            if (activeTypeSet.has(item.type)) activeTypeSet.delete(item.type);
            else activeTypeSet.add(item.type);
          }
          cb.checked = activeTypeSet.has(item.type);
          invalidateZipCache();
          if (typeof onFiltersChanged === "function") onFiltersChanged();
        });

        cb.addEventListener("click", (e) => {
          e.stopPropagation();
          if (isModClick(e)) {
            activeTypeSet = new Set([item.type]);
          } else {
            if (cb.checked) activeTypeSet.add(item.type);
            else activeTypeSet.delete(item.type);
          }
          invalidateZipCache();
          if (typeof onFiltersChanged === "function") onFiltersChanged();
        });

        sub.appendChild(row);
      }

      group.appendChild(sub);
      legendItemsEl.appendChild(group);
    }
  }

  function renderLegend(pointsInSlice) {
    const hint = document.querySelector(".legend-hint");
    if (hint) hint.textContent = showAllTypes ? "All call types (grouped)" : "Top 10 categories (+ Other)";
    if (showAllTypes) renderLegendAllTypesMode(pointsInSlice);
    else renderLegendCategoryMode(pointsInSlice);
  }

  // Whether legend selection currently excludes any visible entries.
  // Used for KPI 'filters applied' summary.
  function legendIsNarrowed() {
    if (showAllTypes) return activeTypeSet.size && visibleTypes.length && activeTypeSet.size !== visibleTypes.length;
    return activeCategorySet.size && visibleCategories.length && activeCategorySet.size !== visibleCategories.length;
  }

  // ------------------ Charts ------------------
  // Chart.js doesn't like multiple instances bound to the same canvas.
  // Always destroy before recreating to avoid memory leaks and duplicate event handlers.
  function destroyChartIfExists(ch) {
    try { ch?.destroy?.(); } catch {}
  }

  // Normalize a timestamp into a bucket key based on the selected grouping.
  // Keys are stable strings used for sorting and label generation.
  function groupKey(ts, grouping) {
    const d = new Date(ts);
    if (grouping === "month") {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    if (grouping === "week") {
      const day = d.getDay();
      const diffToMon = (day + 6) % 7;
      const mon = new Date(d);
      mon.setDate(d.getDate() - diffToMon);
      mon.setHours(0, 0, 0, 0);
      return `Wk ${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, "0")}-${String(mon.getDate()).padStart(2, "0")}`;
    }
    const sd = new Date(d);
    sd.setHours(0, 0, 0, 0);
    return sd.toISOString().slice(0, 10);
  }

  function keyLabel(key, grouping) {
    if (grouping === "month") {
      const [y, m] = key.split("-");
      const d = new Date(Number(y), Number(m) - 1, 1);
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
    }
    if (grouping === "week") {
      const parts = key.split(" ");
      const iso = parts[1];
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
    const d = new Date(key);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function colorForSeriesKey(key) {
    if (showAllTypes) return shadeForType(key, categoryForType(key));
    return colorForCategory(key);
  }

  // Convert raw points into Chart.js datasets for the timeline.
  // - aggregate=true: a single series (total incidents)
  // - aggregate=false: multiple series (top categories/types)
  function buildTimeline(points, grouping, aggregate) {
    const buckets = new Map();
    const seriesKeyOf = (p) => (showAllTypes ? p.type : effectiveCategoryKey(p));

    if (aggregate) {
      for (const p of points) {
        const k = groupKey(p.ts, grouping);
        buckets.set(k, (buckets.get(k) || 0) + 1);
      }
    } else {
      for (const p of points) {
        const k = groupKey(p.ts, grouping);
        if (!buckets.has(k)) buckets.set(k, new Map());
        const m = buckets.get(k);
        const s = seriesKeyOf(p);
        m.set(s, (m.get(s) || 0) + 1);
      }
    }

    const keys = Array.from(buckets.keys()).sort((a, b) => (a < b ? -1 : 1));
    const labels = keys.map((k) => keyLabel(k, grouping));

    if (aggregate) {
      return {
        labels,
        datasets: [{
          label: "Incidents",
          data: keys.map((k) => buckets.get(k) || 0),
          borderColor: "#2a9d8f",
          backgroundColor: "transparent",
          pointBackgroundColor: "#2a9d8f",
          pointRadius: 0,
          tension: 0.25,
          borderWidth: 2,
        }],
      };
    }

    const counts = countBy(points, seriesKeyOf);
    let seriesKeys = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);

    if (seriesKeys.length > 12) seriesKeys = seriesKeys.slice(0, 12);

    const datasets = seriesKeys.map((s) => ({
      label: s,
      data: keys.map((k) => (buckets.get(k)?.get(s) || 0)),
      borderColor: colorForSeriesKey(s),
      backgroundColor: "transparent",
      pointBackgroundColor: colorForSeriesKey(s),
      pointRadius: 0,
      tension: 0.25,
      borderWidth: 2,
    }));

    return { labels, datasets };
  }

  function renderTimelineChart(points) {
    const grouping = groupingEl?.value || "day";
    const aggregate = aggregateEl ? !!aggregateEl.checked : true;
    const data = buildTimeline(points, grouping, aggregate);

    destroyChartIfExists(timelineChart);
    timelineChart = new Chart(timelineCanvas.getContext("2d"), {
      type: "line",
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } },
      },
    });
  }

  // Day-of-week chart uses *average incidents per day* to avoid bias toward longer ranges.
  // We compute how many times each weekday occurs in the current range, then divide totals by that count.
  function renderDowChart(pointsForDow, currentMinTime, currentMaxTime) {
    const baseColor = '#2a9d8f';
    const fadedColor = 'rgba(42, 157, 143, 0.2)';

    const totals = new Array(7).fill(0);
    const dayCounts = new Array(7).fill(0);

    for (let t = startOfDay(currentMinTime); t <= startOfDay(currentMaxTime); t += DAY_MS) {
      dayCounts[new Date(t).getDay()] += 1;
    }
    for (const p of pointsForDow) totals[new Date(p.ts).getDay()] += 1;

    const avg = totals.map((c, i) => (dayCounts[i] ? c / dayCounts[i] : 0));
    const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    destroyChartIfExists(dowChart);
    dowChart = new Chart(dowCanvas.getContext("2d"), {
      type: "bar",
      data: { labels, datasets: [{ 
        label: "Avg / day", 
        data: avg,
        backgroundColor: avg.map((_, i) => {
          if (selectedDOW === null) return baseColor;
          return i === selectedDOW ? baseColor : fadedColor;
        }),
        borderColor: baseColor,
        borderWidth: 1
      }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        onClick: (_evt, els) => {
          if (!els?.length) return;
          const idx = els[0].index;
          selectedDOW = selectedDOW === idx ? null : idx;
          invalidateZipCache();
          if (typeof onFiltersChanged === "function") onFiltersChanged();
        },
        scales: { y: { beginAtZero: true } },
      },
    });
  }

  // Hour-of-day chart also normalizes by number of days in the range.
  // Note: numDays is inclusive of both endpoints after truncating to start-of-day.
  function renderHourChart(pointsForHour, currentMinTime, currentMaxTime) {
    const baseColor = '#2a9d8f';
    const fadedColor = 'rgba(42, 157, 143, 0.2)';

    const totals = new Array(24).fill(0);
    const numDays = Math.max(
      1,
      Math.round((startOfDay(currentMaxTime) - startOfDay(currentMinTime)) / DAY_MS) + 1
    );

    for (const p of pointsForHour) totals[new Date(p.ts).getHours()] += 1;

    const avg = totals.map((c) => c / numDays);
    const labels = Array.from({ length: 24 }, (_, i) => String(i));

    destroyChartIfExists(hourChart);
    hourChart = new Chart(hourCanvas.getContext("2d"), {
      type: "bar",
      data: { labels, datasets: [{ 
        label: "Avg / day", 
        data: avg,
        backgroundColor: avg.map((_, i) => {
          if (selectedHour === null) return baseColor;
          return i === selectedHour ? baseColor : fadedColor;
        }),
        borderColor: baseColor,
        borderWidth: 1
       }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        onClick: (_evt, els) => {
          if (!els?.length) return;
          const idx = els[0].index;
          selectedHour = selectedHour === idx ? null : idx;
          invalidateZipCache();
          if (typeof onFiltersChanged === "function") onFiltersChanged();
        },
        scales: { y: { beginAtZero: true } },
      },
    });
  }

  // ------------------ KPIs + chips ------------------
  // Small UI chips that reflect current DOW/hour filters.
  function updateMiniFilterChipsUI() {
    dowFilterChip.textContent = selectedDOW == null ? "Filter: none" : `Filter: ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][selectedDOW]}`;
    hourFilterChip.textContent = selectedHour == null ? "Filter: none" : `Filter: ${selectedHour}:00`;
  }

  // KPI computation is derived from *already filtered* points.
  // Keep this side-effect-free except for updating the DOM.
  function updateKPIs({ filtered, currentMinTime, currentMaxTime, hasRegion, legendIsNarrowed }) {
    kpiTotalEl.textContent = filtered.length.toLocaleString();
    kpiRangeEl.textContent = formatRange(currentMinTime, currentMaxTime);

    const typeCounts = countBy(filtered, (p) => p.type);
    let topType = "—";
    let topTypeCount = 0;
    for (const [t, c] of typeCounts.entries()) {
      if (c > topTypeCount) {
        topType = t;
        topTypeCount = c;
      }
    }
    kpiTopTypeEl.textContent = topTypeCount ? topType : "—";
    kpiTopTypeSubEl.textContent = topTypeCount ? `${topTypeCount.toLocaleString()} in range` : "—";

    const dayCounts = new Map();
    for (const p of filtered) {
      const d = new Date(p.ts);
      d.setHours(0, 0, 0, 0);
      const k = d.getTime();
      dayCounts.set(k, (dayCounts.get(k) || 0) + 1);
    }
    let peakDay = null;
    let peakCount = 0;
    for (const [k, c] of dayCounts.entries()) {
      if (c > peakCount) {
        peakCount = c;
        peakDay = k;
      }
    }
    kpiPeakEl.textContent = peakDay ? formatDate(peakDay) : "—";
    kpiPeakSubEl.textContent = peakDay ? `${peakCount.toLocaleString()} incidents` : "—";

    let filterCount = 0;
    const details = [];

    if (hasRegion) { filterCount++; details.push("region"); }
    if (selectedDOW != null) { filterCount++; details.push("day-of-week"); }
    if (selectedHour != null) { filterCount++; details.push("hour"); }
    if (legendIsNarrowed) { filterCount++; details.push(showAllTypes ? "call types" : "categories"); }

    kpiFiltersEl.textContent = filterCount.toString();
    kpiFiltersSubEl.textContent = details.length ? details.join(", ") : "none";
  }

  // ------------------ Time helpers ------------------
  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // ------------------ Filters API ------------------
  // Stateless predicates used when building the filtered point set upstream.
  function passesDOWFilter(ts) {
    if (selectedDOW == null) return true;
    return new Date(ts).getDay() === selectedDOW;
  }

  function passesHourFilter(ts) {
    if (selectedHour == null) return true;
    return new Date(ts).getHours() === selectedHour;
  }

  // ------------------ UI wiring ------------------
  // Source of truth for showAllTypes is the checkbox; sync it into controller state.
  function syncShowAllTypesFromUI() {
    showAllTypes = !!showAllTypesEl.checked;
  }

  showAllTypesEl.addEventListener("change", () => {
  // Switching modes is tricky because the selection sets mean different things.
  // The goal is to preserve *intent*:
  // - When going Category -> All Types, we expand selected categories into the types they contain.
  // - When going All Types -> Category, we keep category selection as-is (renderLegend will recompute top-N).
    // activeTypeSet = new Set();
    // activeCategorySet = new Set();

    const wasAllTypes = showAllTypes;
    syncShowAllTypesFromUI();
    
   // Switching Category -> All Types: keep the category selection
    if (!wasAllTypes && showAllTypes) {
      // If nothing selected (or "Other" is selected), treat as "show everything"
      const wantsAll =
        activeCategorySet.size === 0 ||
        activeCategorySet.has("Other") ||
        (visibleCategories.length && activeCategorySet.size === visibleCategories.length);
    
     if (wantsAll) {
        activeTypeSet = new Set(visibleTypes);
      } else {
        activeTypeSet = new Set(
          visibleTypes.filter((t) => activeCategorySet.has(categoryForType(t)))
        );
      }
    }
    invalidateZipCache();
    if (typeof onFiltersChanged === "function") onFiltersChanged();
  });

  resetTypesBtn.addEventListener("click", () => resetLegendSelection());

  groupingEl?.addEventListener("change", () => {
    if (typeof onFiltersChanged === "function") onFiltersChanged();
  });

  aggregateEl?.addEventListener("change", () => {
    if (typeof onFiltersChanged === "function") onFiltersChanged();
  });

  dowClearBtn.addEventListener("click", () => {
    selectedDOW = null;
    invalidateZipCache();
    if (typeof onFiltersChanged === "function") onFiltersChanged();
  });

  hourClearBtn.addEventListener("click", () => {
    selectedHour = null;
    invalidateZipCache();
    if (typeof onFiltersChanged === "function") onFiltersChanged();
  });

  // Convenience wrapper called by the app whenever the data slice changes.
  // Keeps the three charts in sync with the same filtered dataset and time range.
  function renderAllCharts({ filtered, pointsForDow, pointsForHour, currentMinTime, currentMaxTime }) {
    renderTimelineChart(filtered);
    renderDowChart(pointsForDow, currentMinTime, currentMaxTime);
    renderHourChart(pointsForHour, currentMinTime, currentMaxTime);
  }

  return {
    // state sync
    syncShowAllTypesFromUI,

    // legend
    renderLegend,
    resetLegendSelection,
    legendAllowsPoint,
    legendIsNarrowed,

    // charts
    renderAllCharts,

    // KPIs
    updateKPIs,
    updateMiniFilterChipsUI,

    // filters
    passesDOWFilter,
    passesHourFilter,

    // zip cache invalidation hook
    invalidateZipCache,
    set invalidateZipCacheHook(fn) { invalidateZipCacheHook = fn; },

    // app redraw hook
    set onFiltersChanged(fn) { onFiltersChanged = fn; },
    get onFiltersChanged() { return onFiltersChanged; },

    // Expose filter values for building cache keys.
    // Sort ensures stable keys regardless of insertion order.
    get selectedDOW() { return selectedDOW; },
    get selectedHour() { return selectedHour; },

    // expose legend sets for ZIP key building
    get showAllTypes() { return showAllTypes; },
    get activeCategoryKey() { return `C:${Array.from(activeCategorySet).sort().join("|")}`; },
    get activeTypeKey() { return `T:${Array.from(activeTypeSet).sort().join("|")}`; },
  };
}
