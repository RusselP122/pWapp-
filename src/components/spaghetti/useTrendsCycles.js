import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
    getAssetUrl,
    getDatasetConfig,
    formatCycleLabel,
} from "../../utils/spaghettiConfig";
import {
    haversineKm,
    matchDisturbancesAcrossCycles,
} from "../../utils/spaghettiAnalysis";

/**
 * Fetches and analyzes multi-cycle forecast trends in parallel via the shared Web Worker,
 * guarding against duplicate manifest fetches and stale out-of-order updates.
 */
export function useTrendsCycles({
    viewMode,
    dataset,
    basin,
    horizon,
    fetchManifest,
    callWorker,
    activeDisturbanceId,
    setActiveDisturbanceId,
}) {
    const [allCyclesData, setAllCyclesData] = useState([]);
    const [loadingTrends, setLoadingTrends] = useState(false);
    const [selectedTrendSystem, setSelectedTrendSystem] = useState(null);
    const [isTrendsCollapsed, setIsTrendsCollapsed] = useState(false);

    const selectedTrendSystemRef = useRef(null);
    const activeDisturbanceIdRef = useRef(activeDisturbanceId);
    const abortRef = useRef(null);

    useEffect(() => {
        selectedTrendSystemRef.current = selectedTrendSystem;
    }, [selectedTrendSystem]);

    useEffect(() => {
        activeDisturbanceIdRef.current = activeDisturbanceId;
    }, [activeDisturbanceId]);

    const handleSelectTrendSystem = useCallback(
        (dist) => {
            if (allCyclesData.length === 0) return;
            const chain = matchDisturbancesAcrossCycles(dist, allCyclesData);
            setSelectedTrendSystem(chain);
            setActiveDisturbanceId(dist.id);
        },
        [allCyclesData, setActiveDisturbanceId]
    );

    useEffect(() => {
        const cfg = getDatasetConfig(dataset);
        if (viewMode !== "trends" || !cfg.supportsTrends) {
            setSelectedTrendSystem(null);
            setIsTrendsCollapsed(false);
            return;
        }

        if (abortRef.current) abortRef.current.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        const loadAllCycles = async () => {
            setLoadingTrends(true);
            try {
                const manifest = await fetchManifest(false, controller.signal);
                if (controller.signal.aborted) return;

                const activeCycles = manifest?.[cfg.manifestKey];
                if (!activeCycles || activeCycles.length === 0) {
                    throw new Error("No active cycles found for selected dataset");
                }

                // Fetch all cycle CSVs in parallel (skipping HTTP for cycles already cached in worker)
                const cyclePayloads = await Promise.all(
                    activeCycles.map(async (c) => {
                        const cacheKey = `${cfg.id}|/data/${c.tracks}|${c.paired ? `/data/${c.paired}` : ""}`;
                        const cacheCheck = await callWorker("HAS_CACHE", { cacheKey });
                        if (cacheCheck.hasCache) {
                            return { cycleTime: c.cycle, cacheKey, encryptedCsv: null, encryptedPaired: null };
                        }

                        const bust = `?t=${Date.now()}`;
                        const tracksRes = await fetch(getAssetUrl(`/data/${c.tracks}${bust}`), {
                            signal: controller.signal,
                        });
                        if (!tracksRes.ok) return null;
                        const encryptedCsv = await tracksRes.text();

                        let encryptedPaired = null;
                        if (c.paired) {
                            try {
                                const pairedRes = await fetch(getAssetUrl(`/data/${c.paired}${bust}`), {
                                    signal: controller.signal,
                                });
                                if (pairedRes.ok) encryptedPaired = await pairedRes.text();
                            } catch {
                                // Paired track optional
                            }
                        }

                        return { cycleTime: c.cycle, cacheKey, encryptedCsv, encryptedPaired };
                    })
                );

                if (controller.signal.aborted) return;

                const validPayloads = cyclePayloads.filter(Boolean);
                const workerRes = await callWorker("PROCESS_CYCLES", {
                    cycles: validPayloads,
                    datasetId: cfg.id,
                    basinId: basin,
                    horizon,
                });

                if (controller.signal.aborted) return;

                const parsedCycles = workerRes.parsedCycles || [];
                setAllCyclesData(parsedCycles);

                const prevSelected = selectedTrendSystemRef.current;
                let reselected = false;

                if (prevSelected && prevSelected.length > 0 && parsedCycles.length > 0) {
                    const prevDist = prevSelected[0].disturbance;
                    if (prevDist) {
                        const latestCycle = parsedCycles[0];
                        let bestMatch = null;
                        if (prevDist.pairedTrackName) {
                            bestMatch = latestCycle.disturbances.find(
                                (d) => d.pairedTrackName === prevDist.pairedTrackName
                            );
                        }
                        if (!bestMatch) {
                            let minD = Infinity;
                            for (const d of latestCycle.disturbances) {
                                const dd = haversineKm(prevDist, d);
                                if (dd < 300 && dd < minD) {
                                    minD = dd;
                                    bestMatch = d;
                                }
                            }
                        }
                        if (bestMatch) {
                            setSelectedTrendSystem(matchDisturbancesAcrossCycles(bestMatch, parsedCycles));
                            setActiveDisturbanceId(bestMatch.id);
                            reselected = true;
                        }
                    }
                }

                if (!reselected) {
                    let targetDist = null;
                    const currentActiveId = activeDisturbanceIdRef.current;
                    if (currentActiveId !== null && parsedCycles.length > 0) {
                        targetDist = parsedCycles[0].disturbances.find(
                            (d) => d.id === currentActiveId
                        );
                    }
                    if (!targetDist && parsedCycles.length > 0 && parsedCycles[0].disturbances.length > 0) {
                        targetDist = parsedCycles[0].disturbances[0];
                    }
                    if (targetDist) {
                        setSelectedTrendSystem(matchDisturbancesAcrossCycles(targetDist, parsedCycles));
                        setActiveDisturbanceId(targetDist.id);
                    } else {
                        setSelectedTrendSystem(null);
                        setActiveDisturbanceId(null);
                    }
                }
            } catch (err) {
                if (err?.name === "AbortError" || controller.signal.aborted) return;
                console.error("Error loading trends data:", err);
            } finally {
                if (!controller.signal.aborted) setLoadingTrends(false);
            }
        };

        loadAllCycles();

        return () => {
            controller.abort();
        };
    }, [viewMode, dataset, basin, horizon, fetchManifest, callWorker, setActiveDisturbanceId]);

    const chartData = useMemo(() => {
        if (!selectedTrendSystem) return [];

        const totalEnsembleMembers = getDatasetConfig(dataset).totalMembers;

        return [...selectedTrendSystem]
            .reverse()
            .map((item) => {
                const label = formatCycleLabel(item.cycleTime);
                const dist = item.disturbance;
                if (!dist) {
                    return {
                        name: label,
                        cycleTime: item.cycleTime,
                        probability: 0,
                        memberCount: 0,
                        totalMembers: totalEnsembleMembers,
                        minWind: null,
                        maxWind: null,
                        medianWind: null,
                        computedMeanWind: null,
                        pairedWind: null,
                        windRange: null,
                        detected: false,
                        formationDateStr: null,
                    };
                }

                const cycleData = allCyclesData[item.cycleIndex];
                const distTracks = cycleData?.tracksByDisturbance?.[dist.id] || [];

                const peakWinds = distTracks
                    .map((track) => {
                        let mx = 0;
                        for (const pt of track) {
                            if (!isNaN(pt.windKmh) && pt.windKmh > mx) mx = pt.windKmh;
                        }
                        return mx;
                    })
                    .filter((w) => w > 0);

                let minWind = null;
                let maxWind = null;
                let medianWind = null;
                let windRange = null;

                if (peakWinds.length > 0) {
                    minWind = Math.min(...peakWinds);
                    maxWind = Math.max(...peakWinds);
                    const sorted = [...peakWinds].sort((a, b) => a - b);
                    const mid = Math.floor(sorted.length / 2);
                    medianWind =
                        sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
                    windRange = [minWind, maxWind];
                } else if (dist.peakW > 0) {
                    minWind = dist.peakW;
                    maxWind = dist.peakW;
                    medianWind = dist.peakW;
                    windRange = [dist.peakW, dist.peakW];
                }

                const windsByHour = {};
                for (const track of distTracks) {
                    for (const pt of track) {
                        if (!isNaN(pt.windKmh)) {
                            (windsByHour[pt.h] ||= []).push(pt.windKmh);
                        }
                    }
                }
                const hourlyMedians = Object.values(windsByHour).map((winds) => {
                    if (winds.length === 0) return 0;
                    const sorted = [...winds].sort((a, b) => a - b);
                    const mid = Math.floor(sorted.length / 2);
                    return sorted.length % 2 !== 0
                        ? sorted[mid]
                        : (sorted[mid - 1] + sorted[mid]) / 2;
                });
                const computedMeanWind =
                    hourlyMedians.length > 0 ? Math.max(...hourlyMedians) : medianWind || null;

                let pairedWind = null;
                if (dist.pairedTrackName && dist.meanPoints) {
                    const winds = dist.meanPoints
                        .map((pt) => pt.windKmh)
                        .filter((w) => !isNaN(w));
                    if (winds.length > 0) {
                        pairedWind = Math.max(...winds);
                    }
                }

                return {
                    name: label,
                    cycleTime: item.cycleTime,
                    probability: Math.min(
                        100,
                        Math.round((dist.trackCount / totalEnsembleMembers) * 100)
                    ),
                    memberCount: dist.trackCount,
                    totalMembers: totalEnsembleMembers,
                    minWind,
                    maxWind,
                    medianWind,
                    computedMeanWind,
                    pairedWind,
                    windRange,
                    detected: true,
                    formationDateStr: dist.formationDateStr || null,
                };
            });
    }, [selectedTrendSystem, allCyclesData, dataset]);

    return {
        loadingTrends,
        selectedTrendSystem,
        setSelectedTrendSystem,
        isTrendsCollapsed,
        setIsTrendsCollapsed,
        handleSelectTrendSystem,
        chartData,
    };
}
