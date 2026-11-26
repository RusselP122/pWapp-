import { getStormDisplayName } from "./stormNaming.js";

export const PAR = [
    [5, 115],
    [15, 115],
    [21, 120],
    [25, 120],
    [25, 135],
    [5, 135],
    [5, 115],
];

export const BASINS = [
    { id: "wpac", label: "Western Pacific", center: [18, 130], zoom: 4, latMin: -5, latMax: 45, lonMin: 100, lonMax: 180 },
    { id: "spac", label: "South Pacific", center: [-15, 170], zoom: 4, latMin: -50, latMax: 0, lonMin: 130, lonMax: 230 },
    { id: "cpac", label: "Central Pacific", center: [20, -155], zoom: 4, latMin: 0, latMax: 45, lonMin: -180, lonMax: -120 },
    { id: "epac", label: "Eastern Pacific", center: [15, -100], zoom: 4, latMin: 0, latMax: 45, lonMin: -140, lonMax: -60 },
    { id: "nio", label: "North Indian Ocean", center: [14, 75], zoom: 4, latMin: 0, latMax: 35, lonMin: 40, lonMax: 100 },
    { id: "sio", label: "Southern Indian", center: [-20, 75], zoom: 4, latMin: -50, latMax: 0, lonMin: 30, lonMax: 115 },
    { id: "natl", label: "North Atlantic", center: [25, -60], zoom: 4, latMin: 0, latMax: 60, lonMin: -100, lonMax: -10 },
];

export const DATASETS = {
    fnv3p2: {
        id: "fnv3p2",
        label: "WNC Base",
        shortLabel: "GDM WNC Base",
        modelLabel: "GDM WNC",
        exportPrefix: "GDM-WNC-Base",
        watermarkTitle: "Google Deepmind WNC Base Ensemble Track",
        csvPath: "/data/fnv3p2_latest.dat",
        pairedPath: "/data/fnv3p2_paired_latest.dat",
        xorKey: 0xAA,
        totalMembers: 50,
        minRequiredMembers: 25,
        usesCyclesManifest: true,
        manifestKey: "base",
        supportsTrends: true,
        supportsFilter: true,
    },
    fnv3p1: {
        id: "fnv3p1",
        label: "WNCP1",
        shortLabel: "GDM WNCP1",
        modelLabel: "GDM WNC",
        exportPrefix: "GDM-WNCP1",
        watermarkTitle: "Google Deepmind WNCP1 Ensemble Track",
        csvPath: "/data/fnv3p1_latest.dat",
        pairedPath: "/data/fnv3p1_paired_latest.dat",
        xorKey: 0xAA,
        totalMembers: 50,
        minRequiredMembers: 25,
        usesCyclesManifest: false,
        supportsTrends: false,
        supportsFilter: true,
    },
    oper: {
        id: "oper",
        label: "WNCv3",
        shortLabel: "GDM WNCv3",
        modelLabel: "GDM WNC",
        exportPrefix: "GDM-WNCv3",
        watermarkTitle: "Google Deepmind WNCv3 Ensemble Track",
        csvPath: "/data/wnv3_latest.dat",
        pairedPath: "/data/wnv3_paired_latest.dat",
        xorKey: 0xAA,
        totalMembers: 50,
        minRequiredMembers: 25,
        usesCyclesManifest: false,
        supportsTrends: false,
        supportsFilter: true,
    },
    large: {
        id: "large",
        label: "WNC Large",
        shortLabel: "GDM WNC Large",
        modelLabel: "WNC Large Ens",
        exportPrefix: "GDM-WNC-Large",
        watermarkTitle: "Google Deepmind WNC 1000 Ensemble Track",
        csvPath: "/data/fnv3_large_latest.dat",
        pairedPath: "/data/fnv3_large_paired_latest.dat",
        xorKey: 0xAA,
        totalMembers: 1000,
        minRequiredMembers: 100,
        usesCyclesManifest: true,
        manifestKey: "large",
        supportsTrends: true,
        supportsFilter: true,
    },
    ifs: {
        id: "ifs",
        label: "ECMWF IFS",
        shortLabel: "ECMWF IFS",
        modelLabel: "ECMWF IFS Ens",
        exportPrefix: "ECMWF",
        watermarkTitle: "ECMWF IFS Ensemble Track",
        csvPath: "/data/ifs_tc_latest.dat",
        pairedPath: null,
        xorKey: 0xAA,
        totalMembers: 51,
        minRequiredMembers: 25,
        usesCyclesManifest: false,
        supportsTrends: false,
        supportsFilter: true,
    },
    aifs: {
        id: "aifs",
        label: "ECMWF AIFS",
        shortLabel: "ECMWF AIFS",
        modelLabel: "ECMWF AIFS Ens",
        exportPrefix: "ECMWF-AIFS",
        watermarkTitle: "ECMWF AIFS Ensemble Track",
        csvPath: "/data/aifs_tc_latest.dat",
        pairedPath: null,
        xorKey: 0xAA,
        totalMembers: 52,
        minRequiredMembers: 25,
        usesCyclesManifest: false,
        supportsTrends: false,
        supportsFilter: true,
    },
    aigefs: {
        id: "aigefs",
        label: "AI-GEFS",
        shortLabel: "NOAA AI-GEFS",
        modelLabel: "NOAA AI-GEFS Ens",
        exportPrefix: "NOAA-AIGEFS",
        watermarkTitle: "AI-GEFS Ensemble Track",
        csvPath: "/data/aigefs_tc_latest.dat",
        pairedPath: null,
        xorKey: "CalauanWeather2026",
        totalMembers: 31,
        minRequiredMembers: 8,
        usesCyclesManifest: false,
        supportsTrends: false,
        supportsFilter: true,
    },
};

export const DATASET_LIST = [
    DATASETS.fnv3p2,
    DATASETS.fnv3p1,
    DATASETS.oper,
    DATASETS.large,
    DATASETS.ifs,
    DATASETS.aifs,
    DATASETS.aigefs,
];

const DATASET_ALIASES = {
    base: "fnv3p2",
    wnv3: "oper",
};

export function resolveDatasetId(id) {
    if (!id) return "fnv3p2";
    const lower = id.toLowerCase();
    const resolved = DATASET_ALIASES[lower] || lower;
    return DATASETS[resolved] ? resolved : "fnv3p2";
}

export function getDatasetConfig(id) {
    return DATASETS[resolveDatasetId(id)];
}

export const WIND_LEGEND = [
    { label: "≥ 185 km/h", category: "Super Typhoon", acronym: "STY", minWind: 185, color: "#FF007F" },
    { label: "118–184 km/h", category: "Typhoon", acronym: "TY", minWind: 118, color: "#A83232" },
    { label: "89–117 km/h", category: "Sev. Tropical Storm", acronym: "STS", minWind: 89, color: "#E67E22" },
    { label: "62–88 km/h", category: "Tropical Storm", acronym: "TS", minWind: 62, color: "#F1C40F" },
    { label: "39–61 km/h", category: "Tropical Depression", acronym: "TD", minWind: 39, color: "#2ECC71" },
    { label: "< 39 km/h", category: "LPA", acronym: "LPA", minWind: 0, color: "#3498DB" },
];

export function windColor(w) {
    if (isNaN(w)) return "#3498DB";
    if (w >= 185) return "#FF007F";
    if (w >= 118) return "#A83232";
    if (w >= 89) return "#E67E22";
    if (w >= 62) return "#F1C40F";
    if (w >= 39) return "#2ECC71";
    return "#3498DB";
}

export function windCategory(w) {
    if (isNaN(w)) return "Unknown";
    if (w >= 185) return "Super Typhoon";
    if (w >= 118) return "Typhoon";
    if (w >= 89) return "Sev. Tropical Storm";
    if (w >= 62) return "Tropical Storm";
    if (w >= 39) return "Tropical Depression";
    return "LPA";
}

export const getAssetUrl = (path) => {
    const base =
        typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL
            ? import.meta.env.BASE_URL
            : "/";
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;
    return `${base}${cleanPath}`;
};

export function isPointInPar(lat, lon) {
    let inside = false;
    for (let i = 0, j = PAR.length - 1; i < PAR.length; j = i++) {
        const yi = PAR[i][0];
        const xi = PAR[i][1];
        const yj = PAR[j][0];
        const xj = PAR[j][1];
        const intersect =
            yi > lat !== yj > lat &&
            lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-7) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

export function isOriginInBasin(origin, basin) {
    if (!origin || !basin) return false;
    if (origin.lat < basin.latMin || origin.lat > basin.latMax) return false;
    if (basin.lonMax > 180) {
        const lon360 = origin.lon < 0 ? origin.lon + 360 : origin.lon;
        return lon360 >= basin.lonMin && lon360 <= basin.lonMax;
    }
    return origin.lon >= basin.lonMin && origin.lon <= basin.lonMax;
}

export function parseUtcInitDate(initTimeStr) {
    if (!initTimeStr || initTimeStr === "latest") return null;
    let timeStr = String(initTimeStr).trim();
    if (!timeStr.includes("Z") && !timeStr.includes("+")) {
        timeStr = timeStr.replace(" ", "T") + "Z";
    }
    const d = new Date(timeStr);
    return isNaN(d.getTime()) ? null : d;
}

export function formatManilaShortDateTime(initDateMs, leadHours = 0) {
    if (!initDateMs || isNaN(initDateMs)) return { date: "N/A", time: "N/A", full: "Unknown" };
    const d = new Date(initDateMs + leadHours * 3600000);
    const date = d.toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        timeZone: "Asia/Manila",
    });
    const time = d.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "Asia/Manila",
    });
    const full = d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Manila",
    });
    return { date, time, full };
}

export function formatCycleLabel(cycleTime) {
    if (!cycleTime) return "N/A";
    const match = String(cycleTime).match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):00/);
    return match ? `${match[2]}/${match[3]} ${match[4]}Z` : cycleTime;
}

export function formatDisturbanceDisplayName(dist) {
    if (!dist) return "Disturbance";

    const checkPar = () => {
        if (dist.meanPoints && dist.meanPoints.length > 0) {
            return dist.meanPoints.some((pt) => isPointInPar(pt.lat, pt.lon));
        }
        return isPointInPar(dist.lat, dist.lon);
    };

    if (dist.pairedTrackName) {
        const insidePar = checkPar();
        const stormNum = parseInt(dist.pairedTrackName, 10);
        if (!isNaN(stormNum) && stormNum >= 90) {
            return `Invest ${dist.pairedTrackName}`;
        }
        const named = getStormDisplayName(dist.pairedTrackName, null, insidePar, dist.pairedTrackName);
        if (
            named?.displayName &&
            named.displayName.toUpperCase() !== dist.pairedTrackName.toUpperCase() &&
            named.displayName !== "Tropical Cyclone" &&
            named.displayName !== "Low Pressure Area"
        ) {
            return `${named.displayName} (${dist.pairedTrackName})`;
        }
        return `TC ${dist.pairedTrackName}`;
    }

    if (dist.stormTrackId) {
        const insidePar = checkPar();
        const raw = dist.stormTrackId;
        const isJustCode = /^\d{2,3}[A-Z]$/i.test(raw) || /^[A-Z]{2}\d{2,3}$/i.test(raw);
        const named = getStormDisplayName(isJustCode ? "" : raw, null, insidePar, raw);
        if (
            named?.displayName &&
            named.displayName !== "Tropical Cyclone" &&
            named.displayName !== "Low Pressure Area"
        ) {
            if (!isJustCode && named.displayName.toUpperCase() !== raw.toUpperCase()) {
                return `${named.displayName} (${raw})`;
            }
            return named.displayName;
        }
        return raw;
    }

    return `Disturbance ${dist.id}`;
}
