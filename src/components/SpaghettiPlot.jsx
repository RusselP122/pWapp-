import React, { useEffect, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import html2canvas from "html2canvas";
import GIF from "gif.js";
import gifWorkerUrl from "gif.js/dist/gif.worker.js?url";
import EnsembleFilter from "./EnsembleFilter";
import SpaghettiCanvasLayer from "./spaghetti/SpaghettiCanvasLayer";
import DisturbanceCard from "./spaghetti/DisturbanceCard";
import MeanDetailsCard from "./spaghetti/MeanDetailsCard";
import TrendsPanel from "./spaghetti/TrendsPanel";
import AnimationControls from "./spaghetti/AnimationControls";
import ExportOverlay from "./spaghetti/ExportOverlay";
import { useSpaghettiData } from "./spaghetti/useSpaghettiData";
import { useTrendsCycles } from "./spaghetti/useTrendsCycles";
import {
    PAR,
    BASINS,
    DATASET_LIST,
    WIND_LEGEND,
    windColor,
    getAssetUrl,
    getDatasetConfig,
    resolveDatasetId,
    formatCycleLabel,
    formatManilaShortDateTime,
    formatDisturbanceDisplayName,
} from "../utils/spaghettiConfig";
import { splitAntimeridianSegment } from "../utils/spaghettiAnalysis";
import "./SpaghettiPlot.css";

function getInitialUrlState() {
    if (typeof window === "undefined") {
        return { dataset: "fnv3p2", horizon: "5day", basin: "wpac", view: "tracker" };
    }
    const params = new URLSearchParams(window.location.search);
    const dataset = resolveDatasetId(params.get("dataset"));
    const cfg = getDatasetConfig(dataset);
    const horizonParam = params.get("horizon");
    const horizon = horizonParam === "15day" ? "15day" : "5day";
    const basinParam = params.get("basin");
    const basin = BASINS.some((b) => b.id === basinParam) ? basinParam : "wpac";
    const viewParam = params.get("view");

    let view = "tracker";
    if (viewParam === "animation" || viewParam === "filter") {
        view = viewParam;
    } else if (viewParam === "trends" && cfg.supportsTrends) {
        view = "trends";
    }

    return { dataset, horizon, basin, view };
}

export default function SpaghettiPlot() {
    const initialState = useRef(getInitialUrlState()).current;

    const mapRef = useRef(null);
    const mapInstanceRef = useRef(null);
    const spaghettiLayerRef = useRef(null);
    const meanLayerGroupRef = useRef(null);
    const trendLayerGroupRef = useRef(null);
    const selectedMarkerRef = useRef(null);
    const tileLayerRef = useRef(null);
    const parLayerRef = useRef(null);
    const provincesLayerRef = useRef(null);
    const meanRendererRef = useRef(null);
    const exportWrapperRef = useRef(null);

    const [horizon, setHorizon] = useState(initialState.horizon);
    const [dataset, setDataset] = useState(initialState.dataset);
    const [basin, setBasin] = useState(initialState.basin);
    const [leafletReady, setLeafletReady] = useState(false);
    const [provincesGeoJson, setProvincesGeoJson] = useState(null);
    const [showProvinces, setShowProvinces] = useState(true);
    const showProvincesRef = useRef(true);

    const [activeDisturbanceId, setActiveDisturbanceId] = useState(null);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
    const [showEnsembleMean, setShowEnsembleMean] = useState(false);
    const [meanOnlyIds, setMeanOnlyIds] = useState(new Set());
    const [showPlotPoints, setShowPlotPoints] = useState(true);
    const [showAllSystems, setShowAllSystems] = useState(false);
    const [selectedMeanPoint, setSelectedMeanPoint] = useState(null);

    const [viewModeState, setViewModeState] = useState(initialState.view);
    const viewModeRef = useRef(initialState.view);
    const setViewMode = useCallback((mode) => {
        viewModeRef.current = mode;
        setViewModeState(mode);
    }, []);
    const viewMode = viewModeState;

    const [animHour, setAnimHour] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [exportTitle, setExportTitle] = useState("Exporting Map");
    const [exportProgress, setExportProgress] = useState(0);
    const [exportStatusText, setExportStatusText] = useState("");

    const [filteredTrackIds, setFilteredTrackIds] = useState(null);
    const [filterStats, setFilterStats] = useState(null);

    const handleDatasetLoaded = useCallback((result) => {
        setIsPlaying(false);
        setAnimHour(0);
        setShowEnsembleMean(false);
        setMeanOnlyIds(new Set());
        setFilteredTrackIds(null);
        setFilterStats(null);
        if (viewModeRef.current !== "trends") {
            setActiveDisturbanceId(null);
        }
        if (spaghettiLayerRef.current) {
            spaghettiLayerRef.current.setTracks(result.allTracks, result.trackDistIds);
        }
    }, []);

    const {
        status,
        statusMsg,
        runLabel,
        runInitDate,
        disturbances,
        allTracks,
        trackDistIds,
        maxAnimHour,
        isAigefsOutdated,
        fetchManifest,
        callWorker,
        refreshData,
    } = useSpaghettiData({
        dataset,
        horizon,
        basin,
        leafletReady,
        onDatasetLoaded: handleDatasetLoaded,
    });

    const {
        loadingTrends,
        selectedTrendSystem,
        setSelectedTrendSystem,
        isTrendsCollapsed,
        setIsTrendsCollapsed,
        handleSelectTrendSystem,
        chartData,
    } = useTrendsCycles({
        viewMode,
        dataset,
        basin,
        horizon,
        fetchManifest,
        callWorker,
        activeDisturbanceId,
        setActiveDisturbanceId,
    });

    const datasetCfg = getDatasetConfig(dataset);

    // Sync selection state to URL query parameters without reloading
    useEffect(() => {
        if (typeof window === "undefined") return;
        const url = new URL(window.location.href);
        url.searchParams.set("view", viewMode);
        url.searchParams.set("dataset", dataset);
        url.searchParams.set("horizon", horizon);
        url.searchParams.set("basin", basin);
        window.history.replaceState(null, "", url.toString());
    }, [viewMode, dataset, horizon, basin]);

    // ── Handle Mean Track Click ──────────────────────────────────────────
    const handleMeanPointClick = useCallback(
        (pt, distId, distRegion) => {
            const map = mapInstanceRef.current;
            if (!map) return;

            if (selectedMarkerRef.current) {
                map.removeLayer(selectedMarkerRef.current);
                selectedMarkerRef.current = null;
            }

            const distObj = disturbances.find((d) => d.id === distId);
            const displayName = distObj
                ? formatDisturbanceDisplayName(distObj)
                : `Disturbance ${distId}`;

            setSelectedMeanPoint({
                distId,
                displayName,
                h: pt.h,
                lat: pt.lat,
                lon: pt.lon,
                windKmh: pt.windKmh,
                p: pt.p || NaN,
                activeMembers: pt.activeMembers,
                totalMembers: pt.totalMembers,
                stepAgreementPct: pt.stepAgreementPct,
                region: distRegion,
                modelLabel: datasetCfg.modelLabel,
            });

            const marker = L.circleMarker([pt.lat, pt.lon], {
                pane: "meanPane",
                renderer: meanRendererRef.current,
                radius: 9,
                color: "#00f0ff",
                weight: 2,
                fillColor: "#00f0ff",
                fillOpacity: 0.15,
                className: "mean-selected-pulse",
            }).addTo(map);

            selectedMarkerRef.current = marker;
            map.panTo([pt.lat, pt.lon]);
        },
        [datasetCfg.modelLabel, disturbances]
    );

    // Clear selected mean point on parameter change
    useEffect(() => {
        setSelectedMeanPoint(null);
        if (selectedMarkerRef.current && mapInstanceRef.current) {
            mapInstanceRef.current.removeLayer(selectedMarkerRef.current);
            selectedMarkerRef.current = null;
        }
    }, [dataset, activeDisturbanceId, horizon, basin]);

    // ── Initialize Leaflet map once (using bundled npm leaflet) ────────────
    useEffect(() => {
        if (mapInstanceRef.current || !mapRef.current) return;

        const map = L.map(mapRef.current, {
            zoomControl: false,
            worldCopyJump: false,
            maxBounds: [
                [-85, -180],
                [85, 180],
            ],
            maxBoundsViscosity: 1.0,
            minZoom: 3,
            preferCanvas: true,
            renderer: L.canvas({ padding: 0.5 }),
        }).setView([18, 130], 4);

        L.control.zoom({ position: "bottomright" }).addTo(map);

        tileLayerRef.current = L.tileLayer(
            "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
            {
                attribution: "Tiles © Esri",
                maxZoom: 16,
                noWrap: true,
                crossOrigin: true,
            }
        ).addTo(map);

        // Place Philippine provincial borders & PAR above the spaghetti plume (overlayPane=400)
        // and keep Ensemble Mean / lock-on markers above borders.
        const boundariesPane = map.createPane("boundariesPane");
        boundariesPane.style.zIndex = "430";
        boundariesPane.style.pointerEvents = "none";
        const boundariesRenderer = L.canvas({ pane: "boundariesPane", padding: 0.5 });

        const meanPane = map.createPane("meanPane");
        meanPane.style.zIndex = "460";
        meanRendererRef.current = L.canvas({ pane: "meanPane", padding: 0.5 });

        parLayerRef.current = L.polyline(PAR, {
            pane: "boundariesPane",
            renderer: boundariesRenderer,
            color: "#ef4444",
            weight: 2,
            interactive: false,
        }).addTo(map);

        const provincesController = new AbortController();
        fetch(getAssetUrl("/data/ph_provinces.json"), { signal: provincesController.signal })
            .then((r) => (r.ok ? r.json() : null))
            .then((geo) => {
                if (!geo || provincesController.signal.aborted || !mapInstanceRef.current) return;
                setProvincesGeoJson(geo);
                const layer = L.geoJSON(geo, {
                    pane: "boundariesPane",
                    renderer: boundariesRenderer,
                    interactive: false,
                    style: {
                        color: "rgba(255, 255, 255, 0.72)",
                        weight: 0.9,
                        opacity: 1,
                        fillOpacity: 0,
                    },
                });
                provincesLayerRef.current = layer;
                if (showProvincesRef.current) {
                    layer.addTo(mapInstanceRef.current);
                }
            })
            .catch((err) => {
                if (err?.name !== "AbortError") {
                    console.warn("Could not load ph_provinces.json:", err);
                }
            });

        spaghettiLayerRef.current = new SpaghettiCanvasLayer().addTo(map);
        meanLayerGroupRef.current = L.layerGroup();
        trendLayerGroupRef.current = L.layerGroup();
        mapInstanceRef.current = map;

        const def = BASINS.find((b) => b.id === initialState.basin) || BASINS[0];
        map.setView(def.center, def.zoom);
        map.invalidateSize({ animate: false });

        let raf = requestAnimationFrame(() => {
            map.invalidateSize({ animate: false });
            setLeafletReady(true);
        });

        return () => {
            provincesController.abort();
            cancelAnimationFrame(raf);
            map.remove();
            mapInstanceRef.current = null;
            provincesLayerRef.current = null;
            meanRendererRef.current = null;
            spaghettiLayerRef.current = null;
            meanLayerGroupRef.current = null;
            trendLayerGroupRef.current = null;
        };
    }, [initialState.basin]);

    // Toggle Philippine provincial borders visibility
    useEffect(() => {
        showProvincesRef.current = showProvinces;
        const map = mapInstanceRef.current;
        const layer = provincesLayerRef.current;
        if (!map || !layer) return;
        if (showProvinces) {
            if (!map.hasLayer(layer)) layer.addTo(map);
        } else if (map.hasLayer(layer)) {
            map.removeLayer(layer);
        }
    }, [showProvinces]);

    // Handle map resize when sidebar toggles
    useEffect(() => {
        if (!mapInstanceRef.current) return;
        mapInstanceRef.current.invalidateSize();
        const timeoutId = setTimeout(() => {
            if (mapInstanceRef.current) {
                mapInstanceRef.current.invalidateSize({ animate: true });
            }
        }, 300);
        return () => clearTimeout(timeoutId);
    }, [desktopSidebarOpen, sidebarOpen]);

    const prevBasinRef = useRef(basin);
    // Fly map to basin when basin selection changes
    useEffect(() => {
        if (!mapInstanceRef.current || prevBasinRef.current === basin) return;
        prevBasinRef.current = basin;
        const b = BASINS.find((opt) => opt.id === basin);
        if (b) mapInstanceRef.current.flyTo(b.center, b.zoom, { duration: 1 });
    }, [basin]);

    // ── Rebuild Ensemble Mean & Cone layers when disturbances change ──────
    useEffect(() => {
        const meanGroup = meanLayerGroupRef.current;
        if (!meanGroup) return;

        meanGroup.clearLayers();
        const initDateMs =
            runInitDate && !isNaN(runInitDate.getTime()) ? runInitDate.getTime() : null;

        for (const dist of disturbances) {
            if (!dist.hasEnsembleMean || !dist.meanPoints || dist.meanPoints.length < 2) {
                continue;
            }

            if (dist.coneGeoJson) {
                const envGroup = L.geoJSON(dist.coneGeoJson, {
                    pane: "meanPane",
                    renderer: meanRendererRef.current,
                    style: {
                        color: "rgba(255, 255, 255, 0.6)",
                        weight: 1,
                        dashArray: "5 5",
                        fillColor: "rgba(255, 255, 255, 0.15)",
                        fillOpacity: 1,
                        lineCap: "round",
                        lineJoin: "round",
                        interactive: false,
                    },
                });

                envGroup.eachLayer((layer) => {
                    layer.distId = dist.id;
                    layer.isEnvelope = true;
                    layer.addTo(meanGroup);
                });
            }

            const meanPts = dist.meanPoints;
            for (let i = 1; i < meanPts.length; i++) {
                const p1 = meanPts[i - 1];
                const p2 = meanPts[i];
                const splitParts = splitAntimeridianSegment(p1, p2);
                for (const [s1, s2] of splitParts) {
                    const outline = L.polyline(
                        [
                            [s1.lat, s1.lon],
                            [s2.lat, s2.lon],
                        ],
                        {
                            pane: "meanPane",
                            renderer: meanRendererRef.current,
                            color: "#ffffff",
                            weight: 6,
                            opacity: 0.3,
                            lineCap: "round",
                            lineJoin: "round",
                            noClip: true,
                        }
                    );
                    outline.distId = dist.id;
                    outline.isOutline = true;
                    outline.addTo(meanGroup);

                    const meanSeg = L.polyline(
                        [
                            [s1.lat, s1.lon],
                            [s2.lat, s2.lon],
                        ],
                        {
                            pane: "meanPane",
                            renderer: meanRendererRef.current,
                            color: windColor(p2.windKmh),
                            weight: 4,
                            opacity: 0.95,
                            lineCap: "round",
                            lineJoin: "round",
                            noClip: true,
                        }
                    );
                    meanSeg.distId = dist.id;
                    meanSeg.on("click", () => {
                        handleMeanPointClick(p2, dist.id, dist.region);
                    });
                    meanSeg.addTo(meanGroup);
                }
            }

            for (const pt of meanPts) {
                const windColorVal = windColor(pt.windKmh);
                const mk = L.circleMarker([pt.lat, pt.lon], {
                    pane: "meanPane",
                    renderer: meanRendererRef.current,
                    radius: 5,
                    color: windColorVal,
                    weight: 2.5,
                    fillColor: "transparent",
                    fillOpacity: 0,
                    opacity: 1,
                });
                mk.distId = dist.id;

                const { date: dateStr, time: hr } = formatManilaShortDateTime(initDateMs, pt.h);
                const windVal = isNaN(pt.windKmh) ? "N/A" : `${pt.windKmh.toFixed(0)} km/h`;

                const tooltipHtml = `
                    <div style="display: flex; flex-direction: column; gap: 4px; font-family: 'Inter', sans-serif;">
                        <div style="font-size: 11px; font-weight: 800; color: #ffffff; display: flex; align-items: center; gap: 6px; line-height: 1.2;">
                            <span>${dateStr}</span>
                            <span style="color: rgba(255, 255, 255, 0.35); font-weight: 400;">|</span>
                            <span>${hr}</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 6px; margin-top: 2px; line-height: 1.2;">
                            <span style="width: 8px; height: 8px; border-radius: 50%; background-color: ${windColorVal}; box-shadow: 0 0 6px ${windColorVal}80; display: inline-block;"></span>
                            <span style="font-size: 11px; font-weight: 700; color: ${windColorVal};">
                                ${windVal}
                            </span>
                            <span style="font-size: 9px; color: rgba(255, 255, 255, 0.4); font-family: monospace;">(+${pt.h}h)</span>
                        </div>
                    </div>
                `;

                mk.bindTooltip(tooltipHtml, {
                    direction: "top",
                    offset: [0, -8],
                    className: "mean-dot-tooltip",
                    permanent: false,
                    sticky: false,
                    opacity: 0.95,
                });

                mk.on("click", () => {
                    handleMeanPointClick(pt, dist.id, dist.region);
                });

                mk.addTo(meanGroup);
            }
        }
    }, [disturbances, runInitDate, handleMeanPointClick]);

    // ── Push render state to batched Canvas layer ────────────────────────
    useEffect(() => {
        if (spaghettiLayerRef.current) {
            spaghettiLayerRef.current.setRenderState({
                mode: viewMode,
                animHour,
                activeDisturbanceId,
                meanOnlyIds,
                filteredTrackIds,
                showPlotPoints,
            });
        }

        if (meanLayerGroupRef.current) {
            meanLayerGroupRef.current.eachLayer((layer) => {
                const isSelected =
                    activeDisturbanceId === null || layer.distId === activeDisturbanceId;
                if (layer.isEnvelope) {
                    layer.setStyle({
                        fillOpacity: isSelected ? 1 : 0,
                        opacity: isSelected ? 1 : 0,
                    });
                } else if (layer instanceof L.Polyline && !(layer instanceof L.CircleMarker)) {
                    const baseOpacity = layer.isOutline ? 0.3 : 0.95;
                    layer.setStyle({ opacity: isSelected ? baseOpacity : 0.05 });
                } else if (layer instanceof L.CircleMarker) {
                    const alpha = showPlotPoints ? (isSelected ? 1 : 0.05) : 0;
                    layer.setStyle({ fillOpacity: alpha, opacity: alpha });
                }
            });
        }
    }, [
        viewMode,
        animHour,
        activeDisturbanceId,
        meanOnlyIds,
        filteredTrackIds,
        showPlotPoints,
        disturbances,
    ]);

    // ── Manage View Mode & Ensemble Mean Layer Group Attachment ──────────
    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map || !meanLayerGroupRef.current || !trendLayerGroupRef.current) return;

        if (viewMode === "tracker") {
            map.removeLayer(trendLayerGroupRef.current);
            if (showEnsembleMean) {
                meanLayerGroupRef.current.addTo(map);
            } else {
                map.removeLayer(meanLayerGroupRef.current);
            }
        } else if (viewMode === "trends") {
            map.removeLayer(meanLayerGroupRef.current);
            trendLayerGroupRef.current.addTo(map);
        } else {
            map.removeLayer(meanLayerGroupRef.current);
            map.removeLayer(trendLayerGroupRef.current);
        }
    }, [viewMode, showEnsembleMean]);

    // ── Render Multi-Cycle Trends on Map ──────────────────────────────────
    useEffect(() => {
        const map = mapInstanceRef.current;
        const trendGroup = trendLayerGroupRef.current;
        if (!map || !trendGroup || viewMode !== "trends") return;

        trendGroup.clearLayers();
        map.removeLayer(trendGroup);

        if (!selectedTrendSystem || selectedTrendSystem.length === 0) return;

        const cycleColors = ["#38bdf8", "#34d399", "#fbbf24", "#f87171"];
        const hasAnyPaired = selectedTrendSystem.some(
            (item) => item.disturbance && item.disturbance.pairedTrackName
        );

        trendGroup.addTo(map);

        const allLatLngs = [];
        for (let i = selectedTrendSystem.length - 1; i >= 0; i--) {
            const item = selectedTrendSystem[i];
            const dist = item.disturbance;
            if (!dist || !dist.meanPoints || dist.meanPoints.length < 2) continue;
            if (hasAnyPaired && !dist.pairedTrackName) continue;

            const runColor = cycleColors[item.cycleIndex] || "#cbd5e1";
            const pts = dist.meanPoints;
            const lineColor = item.cycleIndex === 0 ? "#000000" : runColor;
            let lineOpacity = 1.0;
            if (item.cycleIndex === 1) lineOpacity = 0.6;
            else if (item.cycleIndex === 2) lineOpacity = 0.4;
            else if (item.cycleIndex >= 3) lineOpacity = 0.2;

            const cycleLabel = `${formatCycleLabel(item.cycleTime)} Run`;

            for (let k = 1; k < pts.length; k++) {
                const splitParts = splitAntimeridianSegment(pts[k - 1], pts[k]);
                for (const [s1, s2] of splitParts) {
                    const segCoords = [
                        [s1.lat, s1.lon],
                        [s2.lat, s2.lon],
                    ];
                    L.polyline(segCoords, {
                        pane: "meanPane",
                        renderer: meanRendererRef.current,
                        color: "#ffffff",
                        weight: 6,
                        opacity: 0.4 * lineOpacity,
                        lineCap: "round",
                        lineJoin: "round",
                    }).addTo(trendGroup);

                    const poly = L.polyline(segCoords, {
                        pane: "meanPane",
                        renderer: meanRendererRef.current,
                        color: lineColor,
                        weight: 3.5,
                        opacity: lineOpacity,
                        lineCap: "round",
                        lineJoin: "round",
                    });
                    poly.bindTooltip(
                        `<div style="font-family: 'Inter', sans-serif; font-size: 11px; font-weight: 700; color: ${runColor}; padding: 2px 4px;">
                            ${cycleLabel} (${dist.pairedTrackName ? "Official Paired" : "Ensemble Mean"})
                        </div>`,
                        { sticky: true }
                    );
                    poly.addTo(trendGroup);
                }
            }

            pts.forEach((pt, ptIdx) => {
                allLatLngs.push([pt.lat, pt.lon]);
                const isStart = ptIdx === 0;
                const isEnd = ptIdx === pts.length - 1;
                const radius = isEnd ? 6 : isStart ? 4.5 : 4;
                const ptColor = windColor(pt.windKmh) || runColor;

                const ptTooltipHtml = `
                    <div style="font-family: 'Inter', sans-serif; font-size: 11px; font-weight: 700; color: ${ptColor}; padding: 2px 4px;">
                        ${cycleLabel} (+${pt.h}h)<br/>
                        ${!isNaN(pt.windKmh) ? `${pt.windKmh.toFixed(0)} km/h` : ""} ${
                    !isNaN(pt.p) ? `(${pt.p.toFixed(0)} hPa)` : ""
                }
                    </div>
                `;

                L.circleMarker([pt.lat, pt.lon], {
                    pane: "meanPane",
                    renderer: meanRendererRef.current,
                    radius,
                    color: ptColor,
                    weight: 2,
                    fillColor: isEnd ? ptColor : "transparent",
                    fillOpacity: isEnd ? 0.35 * lineOpacity : 0,
                    opacity: lineOpacity,
                })
                    .bindTooltip(ptTooltipHtml, { direction: "top" })
                    .addTo(trendGroup);
            });
        }

        if (allLatLngs.length > 0) {
            const bounds = L.latLngBounds(allLatLngs);
            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 6, animate: true });
        }
    }, [selectedTrendSystem, viewMode]);

    // ── Animation playback timer ──────────────────────────────────────────
    useEffect(() => {
        if (!isPlaying) return undefined;
        const interval = setInterval(() => {
            setAnimHour((prev) => {
                if (prev >= maxAnimHour) {
                    setIsPlaying(false);
                    return prev;
                }
                return prev + 6;
            });
        }, 200);
        return () => clearInterval(interval);
    }, [isPlaying, maxAnimHour]);

    // ── Interaction handlers ──────────────────────────────────────────────
    const handleToggleMeanOnly = useCallback(
        (distId) => {
            setMeanOnlyIds((prev) => {
                const next = new Set(prev);
                if (next.has(distId)) {
                    next.delete(distId);
                } else {
                    next.add(distId);
                    setShowEnsembleMean(true);
                }
                return next;
            });
        },
        []
    );

    const handleFocusSystem = useCallback(
        (dist) => {
            const map = mapInstanceRef.current;
            if (!map || !dist) return;

            const pts = [];
            if (allTracks && trackDistIds) {
                for (let i = 0; i < allTracks.length; i++) {
                    if (trackDistIds[i] !== dist.id) continue;
                    for (const p of allTracks[i]) {
                        pts.push([p.lat, p.lon]);
                    }
                }
            }
            if (pts.length === 0 && dist.meanPoints && dist.meanPoints.length >= 2) {
                for (const p of dist.meanPoints) {
                    pts.push([p.lat, p.lon]);
                }
            }

            if (pts.length >= 2) {
                let minLon = 180;
                let maxLon = -180;
                for (const [, lon] of pts) {
                    if (lon < minLon) minLon = lon;
                    if (lon > maxLon) maxLon = lon;
                }
                const crossesAntimeridian = maxLon - minLon > 180;
                const safePts = crossesAntimeridian
                    ? pts.map(([lat, lon]) => [lat, lon < 0 ? lon + 360 : lon])
                    : pts;

                map.fitBounds(L.latLngBounds(safePts), {
                    padding: [48, 48],
                    maxZoom: 6,
                    animate: true,
                });
            } else {
                map.flyTo([dist.lat, dist.lon], 5, { duration: 1 });
            }
            setSidebarOpen(false);
        },
        [allTracks, trackDistIds]
    );

    const handleFilterChange = useCallback((ids, stats) => {
        setFilteredTrackIds(ids);
        setFilterStats(stats);
    }, []);

    // ── Export Snapshot PNG ───────────────────────────────────────────────
    const exportScreenshot = async () => {
        if (!exportWrapperRef.current) return;
        setIsExporting(true);
        setExportTitle("Exporting Map Snapshot");
        setExportProgress(0);
        setExportStatusText("Capturing high-resolution map snapshot...");

        try {
            spaghettiLayerRef.current?.redrawSync();
            const mapEl = exportWrapperRef.current;
            const dpr = window.devicePixelRatio || 2;

            const canvas = await html2canvas(mapEl, {
                useCORS: true,
                allowTaint: false,
                scale: dpr,
                backgroundColor: "#0f172a",
                logging: false,
                ignoreElements: (node) =>
                    node.classList &&
                    (node.classList.contains("leaflet-control-container") ||
                        node.classList.contains("no-export")),
            });

            const ctx = canvas.getContext("2d");
            ctx.resetTransform();

            const fontSize = Math.max(16, Math.min(32, canvas.width * 0.015));
            ctx.font = `900 ${fontSize}px "Inter", system-ui, -apple-system, sans-serif`;
            ctx.fillStyle = "rgba(255, 255, 255, 1)";
            ctx.textAlign = "right";
            ctx.textBaseline = "bottom";

            ctx.shadowColor = "rgba(0, 0, 0, 1)";
            ctx.shadowBlur = Math.max(2, fontSize * 0.2);
            ctx.shadowOffsetX = 1;
            ctx.shadowOffsetY = 1;

            const paddingX = Math.max(16, canvas.width * 0.015);
            const paddingY = Math.max(16, canvas.width * 0.015);

            ctx.lineWidth = Math.max(2, fontSize * 0.15);
            ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
            ctx.strokeText("@ Philippine Typhoon/Weather", canvas.width - paddingX, canvas.height - paddingY);
            ctx.fillText("@ Philippine Typhoon/Weather", canvas.width - paddingX, canvas.height - paddingY);
            ctx.shadowColor = "transparent";

            await new Promise((resolve) => {
                canvas.toBlob((blob) => {
                    if (blob) {
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${datasetCfg.exportPrefix}-Snapshot-${new Date()
                            .toISOString()
                            .replace(/[:.]/g, "-")}.png`;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }
                    resolve();
                }, "image/png");
            });
        } catch (err) {
            console.error("Screenshot failed:", err);
        } finally {
            setIsExporting(false);
        }
    };

    // ── Export Animation GIF ──────────────────────────────────────────────
    const exportGif = async () => {
        if (!mapInstanceRef.current || !exportWrapperRef.current) return;
        const map = mapInstanceRef.current;
        setIsExporting(true);
        setExportTitle("Exporting Animation GIF");
        setExportProgress(0);
        setExportStatusText("Initializing GIF capture...");
        setIsPlaying(false);

        const mapEl = exportWrapperRef.current;
        const rect = mapEl.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 2;
        const renderScale = dpr;

        let captureWidth = Math.floor(rect.width * dpr);
        let captureHeight = Math.floor(rect.height * dpr);
        const maxGifWidth = 1600;
        if (captureWidth > maxGifWidth) {
            const ratio = maxGifWidth / captureWidth;
            captureWidth = maxGifWidth;
            captureHeight = Math.floor(captureHeight * ratio);
        }

        const gif = new GIF({
            workers: 2,
            quality: 2,
            workerScript: gifWorkerUrl,
            width: captureWidth,
            height: captureHeight,
        });

        const restoreControls = () => {
            map.dragging.enable();
            map.scrollWheelZoom.enable();
            if (map.keyboard) map.keyboard.enable();
        };

        map.dragging.disable();
        map.scrollWheelZoom.disable();
        if (map.keyboard) map.keyboard.disable();

        const nextTwoFrames = () =>
            new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            );

        try {
            const exportFilename = `${datasetCfg.exportPrefix}-Ensemble-${new Date()
                .toISOString()
                .replace(/[:.]/g, "-")}.gif`;

            for (let h = 0; h <= maxAnimHour; h += 6) {
                setAnimHour(h);
                spaghettiLayerRef.current?.setRenderState({ animHour: h });
                spaghettiLayerRef.current?.redrawSync();
                setExportStatusText(`Capturing animation frame at hour +${h}h...`);
                await nextTwoFrames();

                setExportProgress((h / maxAnimHour) * 0.5);

                const canvas = await html2canvas(mapEl, {
                    useCORS: true,
                    allowTaint: false,
                    scale: renderScale,
                    backgroundColor: "#0f172a",
                    logging: false,
                    ignoreElements: (node) =>
                        node.classList &&
                        (node.classList.contains("leaflet-control-container") ||
                            node.classList.contains("no-export")),
                });

                if (canvas.width !== captureWidth || canvas.height !== captureHeight) {
                    const downscaledCanvas = document.createElement("canvas");
                    downscaledCanvas.width = captureWidth;
                    downscaledCanvas.height = captureHeight;
                    const ctx = downscaledCanvas.getContext("2d");
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = "high";
                    ctx.drawImage(canvas, 0, 0, captureWidth, captureHeight);
                    gif.addFrame(downscaledCanvas, { delay: 200 });
                } else {
                    gif.addFrame(canvas, { delay: 200 });
                }
            }

            gif.on("progress", (p) => {
                setExportProgress(0.5 + p * 0.5);
                setExportStatusText(`Encoding GIF animation (${Math.round(p * 100)}%)...`);
            });

            gif.on("finished", (blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = exportFilename;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setIsExporting(false);
                setExportProgress(0);
                restoreControls();
            });

            gif.on("abort", () => {
                setIsExporting(false);
                setExportProgress(0);
                restoreControls();
            });

            gif.render();
        } catch (err) {
            console.error("GIF Export failed:", err);
            setIsExporting(false);
            setExportProgress(0);
            restoreControls();
        }
    };

    const animationControlsNode = viewMode === "animation" && (
        <AnimationControls
            animHour={animHour}
            maxAnimHour={maxAnimHour}
            runInitDate={runInitDate}
            isPlaying={isPlaying}
            isExporting={isExporting}
            exportProgress={exportProgress}
            onTogglePlay={() => {
                if (animHour >= maxAnimHour) setAnimHour(0);
                setIsPlaying((p) => !p);
            }}
            onChangeHour={(val) => {
                setAnimHour(val);
                if (isPlaying) setIsPlaying(false);
            }}
            onExportGif={exportGif}
        />
    );

    const sidebarContent = (
        <div className="spaghetti-sidebar">
            <a href="/" className="back-to-forecast">
                <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back to Forecast
            </a>

            <div className="spaghetti-header">
                <div className="spaghetti-header-top">
                    <h1 className="spaghetti-title">
                        {viewMode === "animation"
                            ? "Animation mode"
                            : viewMode === "filter"
                            ? "Ensemble filter"
                            : viewMode === "trends"
                            ? "Run Cycle trend"
                            : "Ensemble Tracker"}
                    </h1>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        <span
                            className={`spaghetti-status-badge ${
                                status === "ok"
                                    ? "status-ok"
                                    : status === "loading"
                                    ? "status-loading"
                                    : status === "error"
                                    ? "status-error"
                                    : "status-none"
                            }`}
                        >
                            {status === "ok"
                                ? "Live"
                                : status === "loading"
                                ? "…"
                                : status === "none"
                                ? "Quiet"
                                : status === "error"
                                ? "Err"
                                : "–"}
                        </span>
                        <button
                            type="button"
                            className="desktop-sidebar-close-btn"
                            onClick={() => setDesktopSidebarOpen(false)}
                            title="Hide Sidebar"
                            aria-label="Hide Sidebar"
                        >
                            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                            </svg>
                        </button>
                    </div>
                </div>
                <p className="spaghetti-subtitle">
                    {status === "loading" || status === "error" || status === "none"
                        ? statusMsg
                        : status === "ok"
                        ? `Init: ${runLabel.split("·")[1]?.trim() || runLabel}`
                        : "Select a horizon to load."}
                </p>
            </div>

            {/* Region */}
            <div>
                <h2 className="spaghetti-section-title">
                    <svg className="spaghetti-section-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Region
                </h2>
                <div className="spaghetti-region-grid">
                    {BASINS.map((opt) => (
                        <button
                            key={opt.id}
                            type="button"
                            onClick={() => {
                                setBasin(opt.id);
                                setSidebarOpen(false);
                            }}
                            className={`region-btn ${basin === opt.id ? "active" : ""}`}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Display Mode */}
            <div>
                <h2 className="spaghetti-section-title">
                    <svg className="spaghetti-section-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                    Display Mode
                </h2>
                <div className="segmented-control grid-4">
                    {[
                        { id: "tracker", label: "Tracker" },
                        { id: "animation", label: "Animation" },
                        { id: "filter", label: "Filter" },
                        { id: "trends", label: "Trends" },
                    ].map((opt) => {
                        const isTrendsLocked = opt.id === "trends" && !datasetCfg.supportsTrends;
                        return (
                            <button
                                key={opt.id}
                                type="button"
                                onClick={() => {
                                    if (isTrendsLocked) return;
                                    setViewMode(opt.id);
                                    setSelectedMeanPoint(null);
                                    if (opt.id === "animation" && !isPlaying && animHour === 0) {
                                        setIsPlaying(true);
                                    }
                                }}
                                className={`segment-btn ${viewMode === opt.id ? "active primary" : ""} ${
                                    isTrendsLocked ? "opacity-35 cursor-not-allowed" : ""
                                }`}
                                title={
                                    isTrendsLocked
                                        ? "Trends are only available for WNC Base and Large datasets"
                                        : ""
                                }
                                disabled={isTrendsLocked}
                            >
                                <span className="segment-label">
                                    {opt.label} {isTrendsLocked && "🔒"}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Plot Style */}
            {viewMode !== "animation" && (
                <div>
                    <h2 className="spaghetti-section-title">
                        <svg className="spaghetti-section-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                        </svg>
                        Plot Style
                    </h2>
                    <div className="segmented-control grid-2">
                        <button
                            type="button"
                            onClick={() => setShowPlotPoints(true)}
                            className={`segment-btn ${showPlotPoints ? "active primary" : ""}`}
                        >
                            <span className="segment-label">With Plot</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setShowPlotPoints(false)}
                            className={`segment-btn ${!showPlotPoints ? "active primary" : ""}`}
                        >
                            <span className="segment-label">Line Only</span>
                        </button>
                    </div>
                </div>
            )}

            <EnsembleFilter
                isActive={viewMode === "filter"}
                isLocked={!datasetCfg.supportsFilter}
                tracks={allTracks}
                trackDistIds={trackDistIds}
                disturbances={disturbances}
                provincesGeoJson={provincesGeoJson}
                onFilterChange={handleFilterChange}
            />

            <div className="sidebar-animation-panel">{animationControlsNode}</div>

            {/* Dataset */}
            <div>
                <h2 className="spaghetti-section-title">
                    <svg className="spaghetti-section-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                    </svg>
                    Dataset
                </h2>
                <div className="segmented-control grid-dataset">
                    {DATASET_LIST.map((opt) => {
                        const isTrendsLocked = viewMode === "trends" && !opt.supportsTrends;
                        return (
                            <button
                                key={opt.id}
                                type="button"
                                onClick={() => {
                                    if (!isTrendsLocked) setDataset(opt.id);
                                }}
                                className={`segment-btn ${dataset === opt.id ? "active" : ""} ${
                                    isTrendsLocked ? "opacity-30 cursor-not-allowed" : ""
                                }`}
                                title={
                                    isTrendsLocked
                                        ? "Trends are only available for WNC Base and Large datasets. Switch mode to Tracker to select other datasets."
                                        : ""
                                }
                                disabled={isTrendsLocked}
                            >
                                <span className="segment-label">
                                    {opt.label} {isTrendsLocked && "🔒"}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Horizon */}
            <div>
                <h2 className="spaghetti-section-title">
                    <svg className="spaghetti-section-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Forecast Horizon
                </h2>
                <div className="segmented-control grid-2">
                    {[
                        { id: "5day", label: "5-Day" },
                        { id: "15day", label: "15-Day" },
                    ].map((opt) => (
                        <button
                            key={opt.id}
                            type="button"
                            onClick={() => setHorizon(opt.id)}
                            className={`segment-btn ${horizon === opt.id ? "active primary" : ""}`}
                        >
                            <span className="segment-label">{opt.label}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Refresh */}
            <button
                type="button"
                onClick={refreshData}
                disabled={status === "loading"}
                className="refresh-btn"
            >
                {status === "loading" ? (
                    <div className="spinner" />
                ) : (
                    <svg className="spaghetti-section-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                )}
                {status === "loading" ? "Fetching..." : "Refresh Data"}
            </button>

            {/* Map Layers */}
            {provincesGeoJson && (
                <div>
                    <h2 className="spaghetti-section-title">
                        <svg className="spaghetti-section-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                        </svg>
                        Map Boundaries
                    </h2>
                    <button
                        type="button"
                        onClick={() => setShowProvinces((prev) => !prev)}
                        className={`ensemble-mean-toggle ${showProvinces ? "active" : ""}`}
                    >
                        <span
                            className="ensemble-mean-indicator"
                            style={{
                                background: showProvinces ? "#e2e8f0" : "#555",
                                boxShadow: showProvinces ? "0 0 6px rgba(226, 232, 240, 0.6)" : "none",
                            }}
                        />
                        <span className="ensemble-mean-label">
                            {showProvinces ? "PH Provinces Visible" : "PH Provinces Hidden"}
                        </span>
                        <span className="ensemble-mean-status">
                            {showProvinces ? "ON" : "OFF"}
                        </span>
                    </button>
                </div>
            )}

            {/* Ensemble Mean Toggle */}
            {viewMode !== "filter" && disturbances.some((d) => d.hasEnsembleMean) && (
                <div
                    style={{
                        opacity: viewMode === "animation" ? 0.4 : 1,
                        pointerEvents: viewMode === "animation" ? "none" : "auto",
                        transition: "all 0.2s",
                    }}
                >
                    <h2 className="spaghetti-section-title">
                        <svg className="spaghetti-section-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                        </svg>
                        Ensemble Mean
                    </h2>
                    <button
                        type="button"
                        onClick={() => setShowEnsembleMean((prev) => !prev)}
                        className={`ensemble-mean-toggle ${showEnsembleMean ? "active" : ""}`}
                    >
                        <span className="ensemble-mean-indicator" />
                        <span className="ensemble-mean-label">
                            {showEnsembleMean ? "Mean Track Visible" : "Mean Track Hidden"}
                        </span>
                        <span className="ensemble-mean-status">
                            {showEnsembleMean ? "ON" : "OFF"}
                        </span>
                    </button>
                </div>
            )}

            {/* Systems List */}
            {viewMode !== "filter" && disturbances.length > 0 && (
                <div
                    style={{
                        opacity: viewMode === "animation" ? 0.4 : 1,
                        pointerEvents: viewMode === "animation" ? "none" : "auto",
                        transition: "all 0.2s",
                    }}
                >
                    <h2 className="spaghetti-section-title">
                        <svg className="spaghetti-section-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        Systems ({disturbances.length})
                    </h2>
                    <div className="systems-list">
                        {(showAllSystems ? disturbances : disturbances.slice(0, 3)).map((d) => (
                            <DisturbanceCard
                                key={d.id}
                                disturbance={d}
                                isActive={activeDisturbanceId === d.id}
                                isMeanOnly={meanOnlyIds.has(d.id)}
                                onSelect={(dist) => {
                                    if (viewMode === "trends") {
                                        handleSelectTrendSystem(dist);
                                    } else {
                                        setActiveDisturbanceId((prev) =>
                                            prev === dist.id ? null : dist.id
                                        );
                                    }
                                    setSidebarOpen(false);
                                }}
                                onToggleMeanOnly={handleToggleMeanOnly}
                                onFocusSystem={handleFocusSystem}
                            />
                        ))}
                        {disturbances.length > 3 && (
                            <button
                                type="button"
                                className="see-more-systems-btn"
                                onClick={() => setShowAllSystems((prev) => !prev)}
                            >
                                {showAllSystems
                                    ? "See Less"
                                    : `See More (${disturbances.length - 3} more)`}
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Global Intensity Legend */}
            <div className="spaghetti-legend">
                <div className="spaghetti-legend-title">Wind Intensity Scale (km/h)</div>
                <div className="spaghetti-legend-grid">
                    {WIND_LEGEND.map(({ label, color }) => (
                        <div key={label} className="spaghetti-legend-item">
                            <span
                                className="spaghetti-legend-color"
                                style={{ background: color, boxShadow: `0 0 6px ${color}60` }}
                            />
                            <span className="spaghetti-legend-label">{label}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );

    const filterDenominator = filterStats?.scopedTotal || allTracks.length;

    return (
        <div className="spaghetti-layout">
            <div
                className={`mobile-overlay ${sidebarOpen ? "open" : ""}`}
                onClick={() => setSidebarOpen(false)}
            />

            <aside
                className={`spaghetti-sidebar-container ${sidebarOpen ? "open" : ""} ${
                    !desktopSidebarOpen ? "desktop-collapsed" : ""
                }`}
            >
                <div className="mobile-close-header">
                    <div className="bottom-sheet-handle" />
                    <div className="mobile-close-header-content">
                        <div className="mobile-close-title-wrap">
                            <span className="mobile-close-title">Controls & Filters</span>
                            <span className="mobile-close-subtitle">
                                Spaghetti Parameters & Layers
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={() => setSidebarOpen(false)}
                            className="mobile-close-btn"
                            aria-label="Close controls sheet"
                            title="Done"
                        >
                            <span>Done</span>
                            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>
                {sidebarContent}
            </aside>

            <main className="spaghetti-main">
                {!desktopSidebarOpen && (
                    <button
                        type="button"
                        className="desktop-sidebar-toggle-btn"
                        onClick={() => setDesktopSidebarOpen(true)}
                        title="Show Sidebar"
                        aria-label="Show Sidebar"
                    >
                        <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                        </svg>
                    </button>
                )}

                {!sidebarOpen && viewMode !== "animation" && (
                    <button
                        type="button"
                        className="mobile-bottom-sheet-trigger"
                        onClick={() => setSidebarOpen(true)}
                        title="Open Controls & Layers"
                    >
                        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                        </svg>
                        <span>Controls & Layers</span>
                    </button>
                )}

                <div
                    className="mobile-topbar"
                    onClick={() => setSidebarOpen(true)}
                    style={{ cursor: "pointer" }}
                >
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            setSidebarOpen(true);
                        }}
                        className="mobile-menu-btn"
                        aria-label="Open controls"
                        title="Open controls"
                    >
                        <svg
                            className="spaghetti-section-icon"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            style={{ width: "16px", height: "16px" }}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                        </svg>
                    </button>
                    <span className="mobile-title">
                        {datasetCfg.shortLabel} · {horizon === "5day" ? "5-Day" : "15-Day"} Spaghetti
                    </span>
                    <span className="mobile-topbar-hint">Controls ▾</span>
                </div>

                {status === "loading" && (
                    <div className="map-loading-overlay">
                        <div className="map-spinner" />
                        <span className="map-loading-text">{statusMsg}</span>
                    </div>
                )}

                <div
                    ref={exportWrapperRef}
                    style={{ width: "100%", height: "100%", position: "relative" }}
                >
                    <div
                        ref={mapRef}
                        className="map-container"
                        style={{ width: "100%", height: "100%", minHeight: "400px" }}
                    />

                    {isAigefsOutdated && (
                        <div className="outdated-warning-banner no-export">
                            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                            </svg>
                            <span style={{ fontSize: "12px", fontWeight: 600 }}>
                                AI-GEFS data is more than 24 hours old.
                            </span>
                        </div>
                    )}

                    <MeanDetailsCard
                        selectedMeanPoint={selectedMeanPoint}
                        disturbances={disturbances}
                        runInitDate={runInitDate}
                        onSelectPoint={handleMeanPointClick}
                        onClose={() => {
                            setSelectedMeanPoint(null);
                            if (selectedMarkerRef.current && mapInstanceRef.current) {
                                mapInstanceRef.current.removeLayer(selectedMarkerRef.current);
                                selectedMarkerRef.current = null;
                            }
                        }}
                        onZoom={() => {
                            if (mapInstanceRef.current && selectedMeanPoint) {
                                mapInstanceRef.current.flyTo(
                                    [selectedMeanPoint.lat, selectedMeanPoint.lon],
                                    6,
                                    { duration: 1 }
                                );
                            }
                        }}
                    />

                    {viewMode === "trends" && (
                        <TrendsPanel
                            dataset={dataset}
                            loadingTrends={loadingTrends}
                            selectedTrendSystem={selectedTrendSystem}
                            chartData={chartData}
                            isTrendsCollapsed={isTrendsCollapsed}
                            setIsTrendsCollapsed={setIsTrendsCollapsed}
                            onClose={() => {
                                setSelectedTrendSystem(null);
                                setActiveDisturbanceId(null);
                                setIsTrendsCollapsed(false);
                            }}
                        />
                    )}

                    {(viewMode === "tracker" || viewMode === "filter") && (
                        <button
                            type="button"
                            className="no-export spaghetti-screenshot-btn"
                            onClick={exportScreenshot}
                            disabled={isExporting}
                            title="Screenshot Map"
                            aria-label="Screenshot Map"
                        >
                            {isExporting ? (
                                <div
                                    className="map-spinner"
                                    style={{ width: "22px", height: "22px", borderWidth: "2px" }}
                                />
                            ) : (
                                <svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                            )}
                        </button>
                    )}

                    {(viewMode === "animation" || (isExporting && viewMode !== "trends")) && (
                        <div className="gif-watermark">
                            <h3 className="gif-watermark-title">{datasetCfg.watermarkTitle}</h3>
                            <div className="gif-watermark-row">
                                <strong>Init:</strong>{" "}
                                {runInitDate
                                    ? `${runInitDate
                                          .toISOString()
                                          .replace("T", " ")
                                          .substring(0, 19)} UTC`
                                    : "Loading..."}
                            </div>
                            <div className="gif-watermark-valid">
                                <strong>Valid:</strong>{" "}
                                {runInitDate
                                    ? `${new Date(runInitDate.getTime() + animHour * 3600000)
                                          .toISOString()
                                          .replace("T", " ")
                                          .substring(0, 19)} UTC`
                                    : "Loading..."}{" "}
                                <span style={{ color: "#38bdf8", marginLeft: "4px" }}>
                                    (+{animHour}h)
                                </span>
                            </div>

                            <div className="gif-watermark-legend">
                                {WIND_LEGEND.map(({ label, acronym, color }) => (
                                    <div key={label} className="gif-watermark-legend-item">
                                        <div
                                            className="gif-watermark-legend-color"
                                            style={{ backgroundColor: color }}
                                        />
                                        <span>{acronym}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {viewMode === "filter" && filterStats && (
                        <div className="gif-watermark filter-watermark">
                            <h3 className="gif-watermark-title" style={{ color: "#d946ef" }}>
                                Filter Active
                            </h3>
                            <div
                                className="gif-watermark-row"
                                style={{
                                    fontSize: "15px",
                                    marginBottom: "8px",
                                    borderBottom: "1px solid rgba(255,255,255,0.1)",
                                    paddingBottom: "8px",
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                }}
                            >
                                <div>
                                    <strong>Matched:</strong>{" "}
                                    <span style={{ color: "#00d4ff" }}>
                                        {filteredTrackIds ? filteredTrackIds.size : 0} /{" "}
                                        {filterDenominator}
                                    </span>
                                </div>
                                {filterDenominator > 0 && filteredTrackIds && (
                                    (() => {
                                        const pct = Math.round(
                                            (filteredTrackIds.size / filterDenominator) * 100
                                        );
                                        const color =
                                            pct >= 70 ? "#10b981" : pct >= 40 ? "#f59e0b" : "#ef4444";
                                        const label =
                                            pct >= 70 ? "HIGH" : pct >= 40 ? "MEDIUM" : "LOW";
                                        return (
                                            <div
                                                style={{
                                                    background: `${color}25`,
                                                    border: `1px solid ${color}50`,
                                                    color,
                                                    padding: "2px 6px",
                                                    borderRadius: "4px",
                                                    fontSize: "11px",
                                                    fontWeight: "bold",
                                                    marginLeft: "12px",
                                                }}
                                            >
                                                {pct}% {label}
                                            </div>
                                        );
                                    })()
                                )}
                            </div>
                            {filterStats.systemName && (
                                <div
                                    className="gif-watermark-valid"
                                    style={{ fontSize: "13px", marginTop: "6px" }}
                                >
                                    <span style={{ color: "#94a3b8" }}>System:</span>{" "}
                                    {filterStats.systemName}
                                </div>
                            )}
                            {filterStats.intensities && (
                                <div
                                    className="gif-watermark-valid"
                                    style={{ fontSize: "13px", marginTop: "6px" }}
                                >
                                    <span style={{ color: "#94a3b8" }}>Intensity:</span>{" "}
                                    {filterStats.intensities}
                                </div>
                            )}
                            {filterStats.region && (
                                <div
                                    className="gif-watermark-valid"
                                    style={{ fontSize: "13px", marginTop: "4px" }}
                                >
                                    <span style={{ color: "#94a3b8" }}>Landfall Region:</span>{" "}
                                    {filterStats.region}
                                </div>
                            )}
                            {filterStats.province && (
                                <div
                                    className="gif-watermark-valid"
                                    style={{ fontSize: "13px", marginTop: "4px" }}
                                >
                                    <span style={{ color: "#94a3b8" }}>Province:</span>{" "}
                                    {filterStats.province}
                                </div>
                            )}
                            {filterStats.trajectory && (
                                <div
                                    className="gif-watermark-valid"
                                    style={{ fontSize: "13px", marginTop: "4px" }}
                                >
                                    <span style={{ color: "#94a3b8" }}>Path:</span>{" "}
                                    {filterStats.trajectory}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="map-animation-panel">{animationControlsNode}</div>
            </main>

            <ExportOverlay
                isExporting={isExporting}
                exportTitle={exportTitle}
                exportStatusText={exportStatusText}
                exportProgress={exportProgress}
            />
        </div>
    );
}
