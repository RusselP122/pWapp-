import { getAssetUrl } from "./spaghettiConfig.js";

export const CYCLE_ORDER = ["00Z", "06Z", "12Z", "18Z"];
export const CYCLE_LATEST_FIRST = ["18Z", "12Z", "06Z", "00Z"];

export const CYCLE_OPTIONS = [
  { code: "00Z", label: "00", pht: "08:00 AM PHT", hourUtc: 0 },
  { code: "06Z", label: "06", pht: "02:00 PM PHT", hourUtc: 6 },
  { code: "12Z", label: "12", pht: "08:00 PM PHT", hourUtc: 12 },
  { code: "18Z", label: "18", pht: "02:00 AM PHT", hourUtc: 18 }
];

export const MODEL_CONFIGS = {
  gdm_wncv3: {
    id: "gdm_wncv3",
    name: "GDM WNCv3",
    fullName: "Google DeepMind WeatherNext Cyclone V3",
    members: 64,
    badgeColor: "from-cyan-500 to-blue-600",
    borderGlow: "border-cyan-500/40",
    desc: "Operational 64-member high-resolution deep-learning trajectory ensemble."
  },
  gdm_wnc_large: {
    id: "gdm_wnc_large",
    name: "GDM WNC",
    fullName: "DeepMind Nazca 1,000-Member Ensemble",
    members: 1000,
    badgeColor: "from-purple-500 to-indigo-600",
    borderGlow: "border-purple-500/40",
    desc: "Massive 1,000-member ensemble providing extreme-dispersion risk envelopes."
  }
};

export const MODEL_LIST = Object.values(MODEL_CONFIGS);

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

const BASIN_TO_LETTER = {
  WP: "W",
  CP: "C",
  EP: "E",
  AL: "L",
  IO: "B",
  SH: "S"
};

const LETTER_TO_BASIN = {
  W: "WP",
  C: "CP",
  E: "EP",
  L: "AL",
  B: "IO",
  A: "IO",
  I: "IO",
  S: "SH",
  P: "SH"
};

// Historical 2026 fallback names used strictly when 2026 manifest/index lacks an official name.
const LEGACY_2026_STORM_NAMES = {
  CP04: "PENA",
  "04C": "PENA",
  WP31: "CEMPAKA",
  "31W": "CEMPAKA"
};

const GENERIC_STORM_NAME_RE = /^(?:TC\s*\d+[A-Z]?|TROPICAL\s+(?:SYSTEM|CYCLONE|DEPRESSION)|UNKNOWN|NONAME|NONE|NULL|LPA)$/i;

export function getModelConfig(modelId) {
  return MODEL_CONFIGS[modelId] || MODEL_CONFIGS.gdm_wncv3;
}

export function matchesModelId(entryModel, selectedModel) {
  const m = String(entryModel || "").toLowerCase();
  const target = String(selectedModel || "").toLowerCase();
  if (!m || !target) return false;
  if (target === "gdm_wncv3") {
    return m === "gdm_wncv3" || m === "gdm_wnc" || m === "wncv3";
  }
  return m === target;
}

export function isMonitoringEntry(entry) {
  if (!entry) return false;
  if (entry.is_monitoring) return true;
  const stormId = String(entry.storm_id || "").toUpperCase();
  return stormId.startsWith("MONITORING_") || stormId.startsWith("LPA");
}

export function formatDateLabel(ymdStr) {
  if (typeof ymdStr !== "string" || !/^\d{8}$/.test(ymdStr)) {
    return ymdStr || "";
  }
  const year = ymdStr.slice(0, 4);
  const monthIdx = parseInt(ymdStr.slice(4, 6), 10) - 1;
  const day = parseInt(ymdStr.slice(6, 8), 10);
  if (monthIdx < 0 || monthIdx >= MONTH_NAMES.length || day < 1 || day > 31) {
    return ymdStr;
  }
  return `${MONTH_NAMES[monthIdx]} ${day}, ${year}`;
}

export function sanitizeFilenamePart(value, fallback = "PLOT") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

export function getAvailableDates(entries, maxDays = 2) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  const dates = Array.from(
    new Set(
      entries
        .map((e) => e?.init_date)
        .filter((d) => typeof d === "string" && /^\d{8}$/.test(d))
    )
  ).sort((a, b) => b.localeCompare(a));

  return dates.slice(0, maxDays);
}

export function getCyclesForDateAndModel(dateEntries, selectedModel) {
  if (!Array.isArray(dateEntries) || dateEntries.length === 0) {
    return new Set();
  }
  const cycles = new Set();
  for (const entry of dateEntries) {
    if (!matchesModelId(entry?.model, selectedModel)) continue;
    const cycle = String(entry?.cycle || "").trim().toUpperCase();
    if (CYCLE_ORDER.includes(cycle)) {
      cycles.add(cycle);
    }
  }
  return cycles;
}

export function getBestAvailableCycle(cyclesSet) {
  if (!cyclesSet || cyclesSet.size === 0) return null;
  for (const candidate of CYCLE_LATEST_FIRST) {
    if (cyclesSet.has(candidate)) return candidate;
  }
  return null;
}

export function getAdjacentAvailableCycle(availableCycles, currentCycle, direction) {
  if (!availableCycles || availableCycles.size === 0) return null;
  const availableOrdered = CYCLE_ORDER.filter((c) => availableCycles.has(c));
  if (availableOrdered.length === 0) return null;

  const upperCurrent = String(currentCycle || "").toUpperCase();
  const curIdx = availableOrdered.indexOf(upperCurrent);
  if (curIdx !== -1) {
    const targetIdx = direction === "prev" ? curIdx - 1 : curIdx + 1;
    return targetIdx >= 0 && targetIdx < availableOrdered.length
      ? availableOrdered[targetIdx]
      : null;
  }

  const rawIdx = CYCLE_ORDER.indexOf(upperCurrent);
  if (rawIdx === -1) {
    return availableOrdered[availableOrdered.length - 1];
  }
  if (direction === "prev") {
    const earlier = availableOrdered.filter((c) => CYCLE_ORDER.indexOf(c) < rawIdx);
    return earlier.length > 0 ? earlier[earlier.length - 1] : null;
  }
  const later = availableOrdered.filter((c) => CYCLE_ORDER.indexOf(c) > rawIdx);
  return later.length > 0 ? later[0] : null;
}

export function getEntryImageUrls(entry) {
  if (!entry?.filename) {
    return { primaryUrl: null, altUrl: null };
  }
  const primaryUrl = getAssetUrl(`assets/${entry.filename}`);
  const altUrl =
    entry.alt_filename && entry.alt_filename !== entry.filename
      ? getAssetUrl(`assets/${entry.alt_filename}`)
      : null;
  return { primaryUrl, altUrl };
}

export function formatClusterLabel(dId, index = 0, entry = null) {
  let baseNum = String(index + 1).padStart(2, "0");
  if (dId) {
    const match = String(dId).match(/\d+/);
    if (match) {
      baseNum = match[0].padStart(2, "0");
    }
  }

  const stormName = entry?.storm_name ? String(entry.storm_name).trim() : "";
  if (stormName && stormName.toUpperCase() !== "INVEST") {
    return `Cluster ${baseNum} • ${stormName}`;
  }
  return `Cluster ${baseNum}`;
}

export function parseAtcfParts(idStr) {
  const clean = String(idStr || "").trim().toUpperCase();
  if (!clean) return null;

  const fullMatch = clean.match(/^([A-Z]{2})(\d{2,3})(\d{4})$/);
  if (fullMatch) {
    const [, basin, rawNum, year] = fullMatch;
    const num = rawNum.padStart(2, "0");
    const letter = BASIN_TO_LETTER[basin] || "";
    return {
      raw: clean,
      basin,
      num,
      year,
      letter,
      shortAtcf: letter ? `${num}${letter}` : clean,
      shortTrackId: `${basin}${num}`
    };
  }

  const basinNumMatch = clean.match(/^([A-Z]{2})(\d{2,3})$/);
  if (basinNumMatch) {
    const [, basin, rawNum] = basinNumMatch;
    const num = rawNum.padStart(2, "0");
    const letter = BASIN_TO_LETTER[basin] || "";
    return {
      raw: clean,
      basin,
      num,
      year: null,
      letter,
      shortAtcf: letter ? `${num}${letter}` : clean,
      shortTrackId: `${basin}${num}`
    };
  }

  const numLetterMatch = clean.match(/^(\d{2,3})([A-Z])$/);
  if (numLetterMatch) {
    const [, rawNum, letter] = numLetterMatch;
    const num = rawNum.padStart(2, "0");
    const basin = LETTER_TO_BASIN[letter] || null;
    return {
      raw: clean,
      basin,
      num,
      year: null,
      letter,
      shortAtcf: `${num}${letter}`,
      shortTrackId: basin ? `${basin}${num}` : clean
    };
  }

  return null;
}

export function toShortAtcfId(idStr) {
  const parts = parseAtcfParts(idStr);
  if (parts?.shortAtcf) return parts.shortAtcf;
  return String(idStr || "").trim().toUpperCase();
}

export function findStormIndexEntry(stormId, stormsIndex, referenceDate = "") {
  if (!stormId || !Array.isArray(stormsIndex) || stormsIndex.length === 0) {
    return null;
  }

  const targetUpper = String(stormId).trim().toUpperCase();
  const targetParts = parseAtcfParts(targetUpper);
  const refYear =
    typeof referenceDate === "string" && /^\d{8}$/.test(referenceDate)
      ? referenceDate.slice(0, 4)
      : targetParts?.year || null;

  let bestCandidate = null;
  let bestScore = 0;

  for (const item of stormsIndex) {
    if (!item) continue;
    const tid = String(item.track_id || "").trim().toUpperCase();
    const aid = String(item.atcf_id || "").trim().toUpperCase();
    const tidParts = parseAtcfParts(tid);
    const aidParts = parseAtcfParts(aid);
    const itemYear = tidParts?.year || aidParts?.year || null;

    // Never match a different storm year when both sides have an explicit year.
    if (refYear && itemYear && refYear !== itemYear) {
      continue;
    }

    let score = 0;
    if (tid === targetUpper || (aid && aid === targetUpper)) {
      score = 100;
    } else if (
      targetParts &&
      tidParts &&
      targetParts.num === tidParts.num &&
      (!targetParts.basin || !tidParts.basin || targetParts.basin === tidParts.basin)
    ) {
      score = 80;
    } else if (
      targetParts &&
      aidParts &&
      targetParts.num === aidParts.num &&
      (!targetParts.basin || !aidParts.basin || targetParts.basin === aidParts.basin)
    ) {
      score = 75;
    }

    if (score > 0) {
      if (refYear && itemYear === refYear) score += 10;
      if (item.storm_name && !GENERIC_STORM_NAME_RE.test(item.storm_name)) score += 5;
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = item;
      }
    }
  }

  return bestCandidate;
}

function cleanStormName(rawName) {
  const trimmed = String(rawName || "").trim();
  if (!trimmed) return null;
  if (/^(UNKNOWN|NONAME|NONE|NULL|TROPICAL\s+SYSTEM)$/i.test(trimmed)) {
    return null;
  }
  return trimmed.toUpperCase();
}

export function resolveActiveStormMeta({
  stormId,
  currentEntry = null,
  dateEntries = [],
  allActiveEntries = [],
  stormsIndex = [],
  selectedCycle = "",
  selectedModel = "",
  selectedDate = ""
}) {
  const sidUpper = String(stormId || "").trim().toUpperCase();
  if (!sidUpper) {
    return {
      stormId: "",
      shortLabel: "Active Tropical Cyclone",
      displayName: "Active Tropical Cyclone",
      badgeId: "",
      isCpac: false
    };
  }

  const upperCycle = String(selectedCycle || "").toUpperCase();
  const isSameStorm = (entry) => {
    const esid = String(entry?.storm_id || "").toUpperCase();
    const eaid = String(entry?.atcf_id || "").toUpperCase();
    return esid === sidUpper || (eaid && eaid === sidUpper);
  };

  // Prefer the exact selected model & cycle entry, then selected model on the same date,
  // then any entry on the same date, then global entries.
  const rankedManifestCandidates = [
    currentEntry && isSameStorm(currentEntry) ? currentEntry : null,
    dateEntries.find(
      (e) =>
        isSameStorm(e) &&
        matchesModelId(e.model, selectedModel) &&
        String(e.cycle || "").toUpperCase() === upperCycle
    ),
    dateEntries.find((e) => isSameStorm(e) && matchesModelId(e.model, selectedModel)),
    dateEntries.find((e) => isSameStorm(e)),
    allActiveEntries.find((e) => isSameStorm(e))
  ].filter(Boolean);

  const bestManifest = rankedManifestCandidates[0] || null;
  const bestNamedManifest =
    rankedManifestCandidates.find((e) => cleanStormName(e.storm_name)) || null;

  const stormObj = findStormIndexEntry(sidUpper, stormsIndex, selectedDate);
  const parts = parseAtcfParts(sidUpper);
  const badgeId =
    String(bestManifest?.atcf_id || stormObj?.atcf_id || toShortAtcfId(sidUpper) || sidUpper)
      .trim()
      .toUpperCase();

  const manifestName = cleanStormName(bestNamedManifest?.storm_name);
  const indexName = cleanStormName(stormObj?.storm_name);

  const runYear =
    (typeof selectedDate === "string" && /^\d{8}$/.test(selectedDate) ? selectedDate.slice(0, 4) : null) ||
    parts?.year ||
    null;

  let legacy2026Name = null;
  if (runYear === "2026") {
    legacy2026Name =
      LEGACY_2026_STORM_NAMES[sidUpper] ||
      LEGACY_2026_STORM_NAMES[badgeId] ||
      null;
  }

  // Manifest authoritatively wins. If missing/generic, consult tc_storms_index,
  // and allow known 2026 legacy names only when index only has generic "TC 31W".
  let resolvedName = manifestName;
  if (!resolvedName) {
    if (indexName && !GENERIC_STORM_NAME_RE.test(indexName)) {
      resolvedName = indexName;
    } else if (legacy2026Name) {
      resolvedName = legacy2026Name;
    } else if (indexName) {
      resolvedName = indexName;
    }
  }

  const isCpac = Boolean(
    sidUpper.startsWith("CP") ||
      parts?.basin === "CP" ||
      bestManifest?.basin === "CP" ||
      stormObj?.basin === "CP" ||
      String(bestManifest?.region || "").toUpperCase().includes("CENTRAL PACIFIC")
  );

  const shortLabel = resolvedName || sidUpper;
  const displayName = resolvedName
    ? resolvedName === badgeId
      ? resolvedName
      : `${resolvedName} (${badgeId})`
    : badgeId !== sidUpper
    ? `${sidUpper} (${badgeId})`
    : sidUpper;

  return {
    stormId: sidUpper,
    shortLabel,
    displayName,
    badgeId,
    isCpac
  };
}
