import test from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_CONFIGS,
  formatDateLabel,
  sanitizeFilenamePart,
  getAvailableDates,
  getCyclesForDateAndModel,
  getBestAvailableCycle,
  getAdjacentAvailableCycle,
  getEntryImageUrls,
  findStormIndexEntry,
  resolveActiveStormMeta,
  toShortAtcfId,
  isMonitoringEntry,
  formatClusterLabel
} from "./spaghettiViewerUtils.js";

test("MODEL_CONFIGS removes LARGE wording on 1000-member model while keeping key", () => {
  assert.equal(MODEL_CONFIGS.gdm_wnc_large.id, "gdm_wnc_large");
  assert.equal(MODEL_CONFIGS.gdm_wnc_large.members, 1000);
  assert.equal(/\blarge\b/i.test(MODEL_CONFIGS.gdm_wnc_large.name), false);
  assert.equal(/\blarge\b/i.test(MODEL_CONFIGS.gdm_wnc_large.fullName), false);
});

test("getAvailableDates returns empty when no entries exist and caps at 2 days descending", () => {
  assert.deepEqual(getAvailableDates([]), []);
  assert.deepEqual(
    getAvailableDates([
      { init_date: "20261124" },
      { init_date: "20261126" },
      { init_date: "20261125" },
      { init_date: "invalid" }
    ]),
    ["20261126", "20261125"]
  );
});

test("getCyclesForDateAndModel does not fall back across models", () => {
  const dateEntries = [
    { init_date: "20261126", cycle: "00Z", model: "gdm_wncv3" },
    { init_date: "20261126", cycle: "06Z", model: "gdm_wncv3" },
    { init_date: "20261126", cycle: "18Z", model: "gdm_wnc" }
  ];

  assert.deepEqual(
    Array.from(getCyclesForDateAndModel(dateEntries, "gdm_wncv3")).sort(),
    ["00Z", "06Z", "18Z"]
  );
  assert.equal(getCyclesForDateAndModel(dateEntries, "gdm_wnc_large").size, 0);
  assert.equal(getBestAvailableCycle(new Set(["00Z", "06Z", "18Z"])), "18Z");
  assert.equal(getBestAvailableCycle(new Set()), null);
});

test("getAdjacentAvailableCycle steps smoothly across missing cycles", () => {
  const available = new Set(["00Z", "06Z", "18Z"]); // 12Z missing
  assert.equal(getAdjacentAvailableCycle(available, "18Z", "prev"), "06Z");
  assert.equal(getAdjacentAvailableCycle(available, "06Z", "next"), "18Z");
  assert.equal(getAdjacentAvailableCycle(available, "00Z", "prev"), null);
  assert.equal(getAdjacentAvailableCycle(available, "18Z", "next"), null);
  assert.equal(getAdjacentAvailableCycle(available, "12Z", "prev"), "06Z");
  assert.equal(getAdjacentAvailableCycle(available, "12Z", "next"), "18Z");
  assert.equal(getAdjacentAvailableCycle(new Set(), "18Z", "prev"), null);
});

test("findStormIndexEntry avoids year-number substring collisions and enforces season", () => {
  const stormsIndex = [
    { track_id: "WP312026", storm_name: "TC 31W", active: false },
    { track_id: "CP042026", atcf_id: "04C", storm_name: "PENA", basin: "CP" },
    { track_id: "WP202026", storm_name: "NEOGURI", active: false }
  ];

  // WP26 does NOT exist in stormsIndex; must NOT collide with "2026" inside WP312026!
  assert.equal(findStormIndexEntry("WP26", stormsIndex, "20261126"), null);

  // WP20 must match WP202026, not WP312026!
  const wp20 = findStormIndexEntry("WP20", stormsIndex, "20261126");
  assert.equal(wp20?.track_id, "WP202026");

  // Year mismatch must return null (2027 run should not pull 2026 CP042026 PENA)
  assert.equal(findStormIndexEntry("CP04", stormsIndex, "20271126"), null);
});

test("resolveActiveStormMeta respects manifest, avoids cross-year/basin leakage, and derives ATCF IDs", () => {
  const stormsIndex = [
    { track_id: "WP312026", storm_name: "TC 31W" },
    { track_id: "CP042026", atcf_id: "04C", storm_name: "PENA", basin: "CP" }
  ];

  // Future 2027 storms must NEVER receive 2026 names PENA/CEMPAKA
  const futureWp04 = resolveActiveStormMeta({
    stormId: "WP04",
    stormsIndex,
    selectedDate: "20270815"
  });
  assert.equal(futureWp04.shortLabel, "WP04");
  assert.equal(futureWp04.badgeId, "04W");
  assert.equal(futureWp04.isCpac, false);

  const futureCp02 = resolveActiveStormMeta({
    stormId: "CP02",
    stormsIndex,
    selectedDate: "20270901"
  });
  assert.equal(futureCp02.shortLabel, "CP02");
  assert.equal(futureCp02.badgeId, "02C");
  assert.equal(futureCp02.isCpac, true);

  // Authoritative manifest storm_name overrides generic fallback
  const manifestNamed = resolveActiveStormMeta({
    stormId: "CP04",
    currentEntry: { storm_id: "CP04", atcf_id: "04C", storm_name: "KIKO", basin: "CP" },
    stormsIndex,
    selectedDate: "20270901"
  });
  assert.equal(manifestNamed.shortLabel, "KIKO");
  assert.equal(manifestNamed.displayName, "KIKO (04C)");

  // Model-specific selection prefers matching model entry on same date/cycle
  const modelSpecific = resolveActiveStormMeta({
    stormId: "WP31",
    dateEntries: [
      { storm_id: "WP31", cycle: "06Z", model: "gdm_wncv3", storm_name: "ALPHA" },
      { storm_id: "WP31", cycle: "06Z", model: "gdm_wnc_large", storm_name: "BETA" }
    ],
    selectedCycle: "06Z",
    selectedModel: "gdm_wnc_large",
    selectedDate: "20271001"
  });
  assert.equal(modelSpecific.shortLabel, "BETA");

  assert.equal(toShortAtcfId("CP09"), "09C");
  assert.equal(toShortAtcfId("WP122027"), "12W");
});

test("formatting, filename sanitization, monitoring detection, and entry URL resolution", () => {
  assert.equal(formatDateLabel("20261126"), "Nov 26, 2026");
  assert.equal(
    sanitizeFilenamePart("Cluster 01 • INVEST (CENTRAL PACIFIC / DATELINE)"),
    "Cluster_01_INVEST_CENTRAL_PACIFIC_DATELINE"
  );
  assert.equal(isMonitoringEntry({ storm_id: "MONITORING_LPA01", is_monitoring: true }), true);
  assert.equal(isMonitoringEntry({ storm_id: "WP31", is_monitoring: false }), false);
  assert.equal(
    formatClusterLabel("MONITORING_LPA02", 0, { storm_name: "LPA" }),
    "Cluster 02 • LPA"
  );
  assert.deepEqual(getEntryImageUrls(null), { primaryUrl: null, altUrl: null });
  assert.equal(
    getEntryImageUrls({ filename: "MONITORING_LPA01_20261126_06Z_gdm_wncv3.png" }).primaryUrl,
    "/assets/MONITORING_LPA01_20261126_06Z_gdm_wncv3.png"
  );
});
