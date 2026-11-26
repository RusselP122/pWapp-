import React, { useState, useEffect, useMemo } from "react";
import * as turf from "@turf/turf";
import { formatDisturbanceDisplayName } from "../utils/spaghettiConfig";

// Fallback bounding polygons for Luzon, Visayas, and Mindanao when ph_provinces.json is loading
const REGIONS = {
    Luzon: turf.polygon([[
        [117.0, 12.1],
        [117.0, 21.0],
        [126.5, 21.0],
        [126.5, 12.1],
        [117.0, 12.1],
    ]]),
    Visayas: turf.polygon([[
        [121.0, 9.0],
        [121.0, 12.1],
        [126.5, 12.1],
        [126.5, 9.0],
        [121.0, 9.0],
    ]]),
    Mindanao: turf.polygon([[
        [119.0, 5.0],
        [119.0, 9.0],
        [126.8, 9.0],
        [126.8, 5.0],
        [119.0, 5.0],
    ]]),
};

const REGION_TO_ISLAND_GROUP = {
    "Cordillera Administrative Region (CAR)": "Luzon",
    "Ilocos Region (Region I)": "Luzon",
    "Cagayan Valley (Region II)": "Luzon",
    "Central Luzon (Region III)": "Luzon",
    "CALABARZON (Region IV-A)": "Luzon",
    "MIMAROPA (Region IV-B)": "Luzon",
    "Bicol Region (Region V)": "Luzon",
    "Metropolitan Manila": "Luzon",
    "Western Visayas (Region VI)": "Visayas",
    "Central Visayas (Region VII)": "Visayas",
    "Eastern Visayas (Region VIII)": "Visayas",
    "Zamboanga Peninsula (Region IX)": "Mindanao",
    "Northern Mindanao (Region X)": "Mindanao",
    "Davao Region (Region XI)": "Mindanao",
    "SOCCSKSARGEN (Region XII)": "Mindanao",
    "Caraga (Region XIII)": "Mindanao",
    "Autonomous Region of Muslim Mindanao (ARMM)": "Mindanao",
};

const INTENSITIES = [
    { id: "STY", label: "Super Typhoon (≥185 km/h)", min: 185, max: Infinity },
    { id: "TY", label: "Typhoon (118-184 km/h)", min: 118, max: 184 },
    { id: "STS", label: "Severe TS (89-117 km/h)", min: 89, max: 117 },
    { id: "TS", label: "Tropical Storm (62-88 km/h)", min: 62, max: 88 },
    { id: "TD", label: "Tropical Dep (39-61 km/h)", min: 39, max: 61 },
    { id: "LPA", label: "Low Pressure (<39 km/h)", min: 0, max: 38 },
];

// Fallback bounding polygon for the Philippines to determine Landfall / Graze
const PH_BOX = turf.polygon([[
    [117.0, 5.0],
    [117.0, 19.5],
    [122.5, 19.5],
    [126.5, 10.0],
    [126.5, 5.0],
    [117.0, 5.0],
]]);

// Precompute buffer and bounding boxes once at module load instead of inside per-track loops
const GRAZE_BOX = turf.buffer(PH_BOX, 150, { units: "miles" });
const PH_BBOX = turf.bbox(PH_BOX);
const GRAZE_BBOX = turf.bbox(GRAZE_BOX);
const REGION_BBOXES = Object.fromEntries(
    Object.entries(REGIONS).map(([name, poly]) => [name, turf.bbox(poly)])
);

function getTrackBbox(track) {
    let tMinLat = 90;
    let tMaxLat = -90;
    let tMinLon = 180;
    let tMaxLon = -180;
    for (let i = 0; i < track.length; i++) {
        const { lat, lon } = track[i];
        if (lat < tMinLat) tMinLat = lat;
        if (lat > tMaxLat) tMaxLat = lat;
        if (lon < tMinLon) tMinLon = lon;
        if (lon > tMaxLon) tMaxLon = lon;
    }
    return [tMinLon, tMinLat, tMaxLon, tMaxLat];
}

function bboxesOverlap(a, b) {
    return !(a[3] < b[1] || a[1] > b[3] || a[2] < b[0] || a[0] > b[2]);
}

export default function EnsembleFilter({
    tracks,
    trackDistIds = null,
    disturbances = [],
    provincesGeoJson = null,
    onFilterChange,
    isActive,
    isLocked = false,
}) {
    const [selectedIntensities, setSelectedIntensities] = useState(new Set());
    const [selectedRegion, setSelectedRegion] = useState("");
    const [selectedProvince, setSelectedProvince] = useState("");
    const [trajectory, setTrajectory] = useState(""); // "landfall", "graze", "recurve"
    const [selectedDistId, setSelectedDistId] = useState("");

    const provinceIndex = useMemo(() => {
        if (!provincesGeoJson || !Array.isArray(provincesGeoJson.features)) {
            return null;
        }
        const entries = provincesGeoJson.features.map((feature) => {
            const name = feature.properties?.PROVINCE || feature.properties?.NAME_1 || "";
            const regionName = feature.properties?.REGION || "";
            return {
                name,
                islandGroup: REGION_TO_ISLAND_GROUP[regionName] || "Luzon",
                bbox: turf.bbox(feature),
                feature,
            };
        });
        const names = entries
            .map((e) => e.name)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));
        const byName = new Map(entries.map((e) => [e.name, e]));
        const byGroup = {
            Luzon: entries.filter((e) => e.islandGroup === "Luzon"),
            Visayas: entries.filter((e) => e.islandGroup === "Visayas"),
            Mindanao: entries.filter((e) => e.islandGroup === "Mindanao"),
        };
        const phBbox = provincesGeoJson.bbox || PH_BBOX;
        return { entries, names, byName, byGroup, phBbox };
    }, [provincesGeoJson]);

    useEffect(() => {
        if (selectedDistId && !disturbances.some((d) => String(d.id) === selectedDistId)) {
            setSelectedDistId("");
        }
    }, [disturbances, selectedDistId]);

    useEffect(() => {
        if (!isActive || !tracks || tracks.length === 0) {
            onFilterChange(null, null);
            return;
        }

        const hasScope = Boolean(selectedDistId);
        const hasFilters =
            selectedIntensities.size > 0 ||
            Boolean(selectedRegion) ||
            Boolean(selectedProvince) ||
            Boolean(trajectory);

        if (!hasScope && !hasFilters) {
            onFilterChange(null, null);
            return;
        }

        const targetDistNum = hasScope ? parseInt(selectedDistId, 10) : null;
        let scopedTotal = 0;
        const filteredIds = new Set();

        const trackMeetsIntensity = (track) => {
            if (selectedIntensities.size === 0) return true;
            let maxWind = 0;
            for (const p of track) {
                if (!isNaN(p.windKmh) && p.windKmh > maxWind) maxWind = p.windKmh;
            }
            for (const intensityId of selectedIntensities) {
                const category = INTENSITIES.find((i) => i.id === intensityId);
                if (category && maxWind >= category.min && maxWind <= category.max) {
                    return true;
                }
            }
            return false;
        };

        const getLine = (track, cache) =>
            cache.line || (cache.line = turf.lineString(track.map((p) => [p.lon, p.lat])));

        const trackHitsPolygons = (track, entries, trackBbox, lineCache) => {
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                if (!bboxesOverlap(trackBbox, entry.bbox)) continue;
                try {
                    if (turf.booleanIntersects(getLine(track, lineCache), entry.feature)) {
                        return true;
                    }
                } catch {
                    // Ignore malformed ring
                }
            }
            return false;
        };

        const trackHitsRegion = (track, trackBbox, lineCache) => {
            if (!selectedRegion) return true;
            if (track.length < 2) return false;
            if (provinceIndex) {
                const entries = provinceIndex.byGroup[selectedRegion];
                if (!entries || entries.length === 0) return true;
                if (!bboxesOverlap(trackBbox, provinceIndex.phBbox)) return false;
                return trackHitsPolygons(track, entries, trackBbox, lineCache);
            }

            const regionPolygon = REGIONS[selectedRegion];
            const bbox = REGION_BBOXES[selectedRegion];
            if (!regionPolygon) return true;
            if (!bboxesOverlap(trackBbox, bbox)) return false;
            try {
                return turf.booleanIntersects(getLine(track, lineCache), regionPolygon);
            } catch {
                return false;
            }
        };

        const trackHitsProvince = (track, trackBbox, lineCache) => {
            if (!selectedProvince || !provinceIndex) return true;
            if (track.length < 2) return false;
            const entry = provinceIndex.byName.get(selectedProvince);
            if (!entry) return true;
            if (!bboxesOverlap(trackBbox, entry.bbox)) return false;
            try {
                return turf.booleanIntersects(getLine(track, lineCache), entry.feature);
            } catch {
                return false;
            }
        };

        const trackMatchesTrajectory = (track, trackBbox, lineCache) => {
            if (!trajectory) return true;
            if (track.length < 2) return false;

            if (trajectory === "recurve") {
                let minLon = Infinity;
                let minLonIdx = 0;
                for (let i = 0; i < track.length; i++) {
                    if (track[i].lon < minLon) {
                        minLon = track[i].lon;
                        minLonIdx = i;
                    }
                }
                const finalLon = track[track.length - 1].lon;
                const finalLat = track[track.length - 1].lat;
                const initialLat = track[0].lat;
                return (
                    finalLon > minLon + 2 &&
                    finalLat > initialLat + 5 &&
                    minLonIdx < track.length - 2
                );
            }

            try {
                if (!bboxesOverlap(trackBbox, GRAZE_BBOX)) return false;

                const intersectsPH = provinceIndex
                    ? bboxesOverlap(trackBbox, provinceIndex.phBbox) &&
                      trackHitsPolygons(track, provinceIndex.entries, trackBbox, lineCache)
                    : bboxesOverlap(trackBbox, PH_BBOX) &&
                      turf.booleanIntersects(getLine(track, lineCache), PH_BOX);

                if (trajectory === "landfall") return intersectsPH;

                const intersectsGraze = turf.booleanIntersects(
                    getLine(track, lineCache),
                    GRAZE_BOX
                );
                if (trajectory === "graze") return intersectsGraze && !intersectsPH;
            } catch {
                return false;
            }
            return true;
        };

        for (let index = 0; index < tracks.length; index++) {
            const track = tracks[index];
            if (targetDistNum !== null && (!trackDistIds || trackDistIds[index] !== targetDistNum)) {
                continue;
            }
            scopedTotal++;

            if (!trackMeetsIntensity(track)) continue;

            const trackBbox = getTrackBbox(track);
            const lineCache = {};
            if (
                trackHitsRegion(track, trackBbox, lineCache) &&
                trackHitsProvince(track, trackBbox, lineCache) &&
                trackMatchesTrajectory(track, trackBbox, lineCache)
            ) {
                filteredIds.add(index);
            }
        }

        const trajLabels = {
            landfall: "PH Landfall",
            graze: "Graze",
            recurve: "Recurve",
        };

        const scopedDist =
            targetDistNum !== null ? disturbances.find((d) => d.id === targetDistNum) : null;

        onFilterChange(filteredIds, {
            intensities: Array.from(selectedIntensities).join(", "),
            region: selectedRegion,
            province: selectedProvince,
            trajectory: trajectory ? trajLabels[trajectory] : "",
            systemName: scopedDist ? formatDisturbanceDisplayName(scopedDist) : "",
            scopedTotal,
        });
    }, [
        tracks,
        trackDistIds,
        disturbances,
        provinceIndex,
        selectedIntensities,
        selectedRegion,
        selectedProvince,
        trajectory,
        selectedDistId,
        isActive,
        onFilterChange,
    ]);

    if (!isActive) return null;

    const toggleIntensity = (id) => {
        setSelectedIntensities((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const hasAnySelection =
        selectedIntensities.size > 0 ||
        selectedRegion ||
        selectedProvince ||
        trajectory ||
        selectedDistId;

    return (
        <div className="mt-4 animate-fade-in relative">
            <h2 className="spaghetti-section-title">
                <svg className="spaghetti-section-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
                Ensemble Filter
            </h2>

            {isLocked && (
                <div className="absolute top-[28px] inset-x-0 bottom-0 z-10 flex flex-col items-center justify-center bg-slate-900/60 backdrop-blur-[2px] rounded-xl border border-slate-700/50 mt-2">
                    <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24" className="text-slate-400 mb-2">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">
                        Filter Unavailable
                    </span>
                </div>
            )}

            <div className={`bg-[#1e293b] p-3 rounded-xl border border-[rgba(255,255,255,0.1)] shadow-lg mt-2 ${isLocked ? "opacity-40 pointer-events-none" : ""}`}>
                {disturbances.length > 0 && (
                    <div className="mb-3">
                        <div className="text-[10px] text-slate-400 mb-1.5 uppercase font-bold tracking-wider">
                            Scope System
                        </div>
                        <select
                            className="w-full bg-[rgba(0,0,0,0.3)] border border-[rgba(255,255,255,0.1)] rounded-lg p-2 text-slate-200 text-xs font-semibold outline-none focus:border-[#00d4ff] transition-colors cursor-pointer"
                            value={selectedDistId}
                            onChange={(e) => setSelectedDistId(e.target.value)}
                        >
                            <option value="">All Systems in Basin ({tracks.length} trks)</option>
                            {disturbances.map((d) => (
                                <option key={d.id} value={String(d.id)}>
                                    {formatDisturbanceDisplayName(d)} ({d.trackCount} trks)
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                <div className="mb-3">
                    <div className="text-[10px] text-slate-400 mb-1.5 uppercase font-bold tracking-wider">
                        Peak Intensity Reached
                    </div>
                    <div
                        className="segmented-control"
                        style={{ display: "flex", flexDirection: "column", gap: "4px", background: "rgba(0,0,0,0.3)", padding: "6px" }}
                    >
                        {INTENSITIES.map((int) => (
                            <button
                                key={int.id}
                                type="button"
                                onClick={() => toggleIntensity(int.id)}
                                className={`segment-btn ${selectedIntensities.has(int.id) ? "active primary" : ""}`}
                                style={{
                                    padding: "6px 10px",
                                    width: "100%",
                                    textAlign: "left",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                }}
                            >
                                <span className="segment-label" style={{ fontSize: "10.5px" }}>
                                    {int.label}
                                </span>
                                {selectedIntensities.has(int.id) && (
                                    <span style={{ fontSize: "10px", fontWeight: "bold" }}>✓</span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-2">
                    <div className="flex flex-col justify-between">
                        <div className="text-[10px] text-slate-400 mb-1.5 uppercase font-bold tracking-wider">
                            PH Landfall Region
                        </div>
                        <select
                            className="w-full bg-[rgba(0,0,0,0.3)] border border-[rgba(255,255,255,0.1)] rounded-lg p-2 text-slate-200 text-xs font-semibold outline-none focus:border-[#00d4ff] transition-colors cursor-pointer"
                            value={selectedRegion}
                            onChange={(e) => setSelectedRegion(e.target.value)}
                        >
                            <option value="">Any / No Filter</option>
                            {Object.keys(REGIONS).map((rName) => (
                                <option key={rName} value={rName}>
                                    {rName}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="flex flex-col justify-between">
                        <div className="text-[10px] text-slate-400 mb-1.5 uppercase font-bold tracking-wider">
                            Trajectory
                        </div>
                        <select
                            className="w-full bg-[rgba(0,0,0,0.3)] border border-[rgba(255,255,255,0.1)] rounded-lg p-2 text-slate-200 text-xs font-semibold outline-none focus:border-[#00d4ff] transition-colors cursor-pointer"
                            value={trajectory}
                            onChange={(e) => setTrajectory(e.target.value)}
                        >
                            <option value="">Any Trajectory</option>
                            <option value="landfall">Direct PH Landfall</option>
                            <option value="graze">Graze (Near PH)</option>
                            <option value="recurve">Recurve</option>
                        </select>
                    </div>
                </div>

                {provinceIndex && (
                    <div className="mb-1">
                        <div className="text-[10px] text-slate-400 mb-1.5 uppercase font-bold tracking-wider">
                            Target Province
                        </div>
                        <select
                            className="w-full bg-[rgba(0,0,0,0.3)] border border-[rgba(255,255,255,0.1)] rounded-lg p-2 text-slate-200 text-xs font-semibold outline-none focus:border-[#00d4ff] transition-colors cursor-pointer"
                            value={selectedProvince}
                            onChange={(e) => setSelectedProvince(e.target.value)}
                        >
                            <option value="">Any Province</option>
                            {provinceIndex.names.map((prov) => (
                                <option key={prov} value={prov}>
                                    {prov}
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                {hasAnySelection && (
                    <div className="mt-3 text-right">
                        <button
                            type="button"
                            onClick={() => {
                                setSelectedIntensities(new Set());
                                setSelectedRegion("");
                                setSelectedProvince("");
                                setTrajectory("");
                                setSelectedDistId("");
                            }}
                            className="text-[10px] font-bold text-rose-400 hover:text-rose-300 bg-rose-900/20 hover:bg-rose-900/40 border border-rose-900/50 px-3 py-1.5 rounded-lg transition-all cursor-pointer"
                        >
                            Clear Filters
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
