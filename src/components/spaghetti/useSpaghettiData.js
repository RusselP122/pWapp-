import { useState, useRef, useEffect, useCallback } from "react";
import SpaghettiWorker from "../../workers/spaghettiWorker?worker";
import { getAssetUrl, getDatasetConfig } from "../../utils/spaghettiConfig";

/**
 * Manages dataset fetching, AbortController cancellation, worker-side CSV caching,
 * and background ensemble track parsing/clustering.
 */
export function useSpaghettiData({ dataset, horizon, basin, leafletReady, onDatasetLoaded }) {
    const workerRef = useRef(null);
    const reqIdRef = useRef(0);
    const abortRef = useRef(null);
    const pendingPromisesRef = useRef(new Map());
    const manifestPromiseRef = useRef(null);

    const [status, setStatus] = useState("idle");
    const [statusMsg, setStatusMsg] = useState("");
    const [runLabel, setRunLabel] = useState("");
    const [runInitDate, setRunInitDate] = useState(null);
    const [trackCount, setTrackCount] = useState(0);
    const [rawRowCount, setRawRowCount] = useState(0);
    const [disturbances, setDisturbances] = useState([]);
    const [allTracks, setAllTracks] = useState([]);
    const [trackDistIds, setTrackDistIds] = useState([]);
    const [maxAnimHour, setMaxAnimHour] = useState(120);
    const [isAigefsOutdated, setIsAigefsOutdated] = useState(false);
    const [cyclesManifest, setCyclesManifest] = useState(null);

    // Initialize shared Web Worker once
    useEffect(() => {
        const worker = new SpaghettiWorker();
        worker.onmessage = (e) => {
            const { requestId, type } = e.data;
            const pending = pendingPromisesRef.current.get(requestId);
            if (!pending) return;
            pendingPromisesRef.current.delete(requestId);
            if (type === "WORKER_ERROR") {
                pending.reject(new Error(e.data.error));
            } else {
                pending.resolve(e.data);
            }
        };
        worker.onerror = (err) => {
            for (const pending of pendingPromisesRef.current.values()) {
                pending.reject(new Error(err.message || "Worker error"));
            }
            pendingPromisesRef.current.clear();
        };
        workerRef.current = worker;

        return () => {
            if (abortRef.current) abortRef.current.abort();
            worker.terminate();
            workerRef.current = null;
        };
    }, []);

    const callWorker = useCallback((type, payload) => {
        return new Promise((resolve, reject) => {
            if (!workerRef.current) {
                reject(new Error("Worker not initialized"));
                return;
            }
            const requestId = ++reqIdRef.current;
            pendingPromisesRef.current.set(requestId, { resolve, reject });
            workerRef.current.postMessage({ type, requestId, payload });
        });
    }, []);

    const fetchManifest = useCallback(async (forceRefresh = false, signal = undefined) => {
        if (!forceRefresh && cyclesManifest) return cyclesManifest;
        if (!forceRefresh && manifestPromiseRef.current) return manifestPromiseRef.current;

        const promise = (async () => {
            const res = await fetch(getAssetUrl(`/data/cycles_manifest.json?t=${Date.now()}`), {
                signal,
            });
            if (!res.ok) throw new Error("Manifest not found");
            const manifest = await res.json();
            setCyclesManifest(manifest);
            return manifest;
        })();

        manifestPromiseRef.current = promise;
        try {
            return await promise;
        } finally {
            manifestPromiseRef.current = null;
        }
    }, [cyclesManifest]);

    const loadData = useCallback(
        async ({ forceRefresh = false } = {}) => {
            if (!leafletReady) return;

            if (abortRef.current) {
                abortRef.current.abort();
            }
            const controller = new AbortController();
            abortRef.current = controller;
            const currentSeq = reqIdRef.current + 1;

            const cfg = getDatasetConfig(dataset);
            const maxHours = horizon === "5day" ? 120 : 312;
            setMaxAnimHour(maxHours);
            setStatus("loading");
            setStatusMsg(`Loading latest ${cfg.label} data…`);
            setTrackCount(0);
            setRunLabel("");

            if (forceRefresh) {
                await callWorker("CLEAR_CACHE", {}).catch(() => {});
            }

            let csvUrl = cfg.csvPath;
            let pairedUrl = cfg.pairedPath;

            if (cfg.usesCyclesManifest) {
                try {
                    const manifest = await fetchManifest(forceRefresh, controller.signal);
                    if (controller.signal.aborted) return;
                    const activeCycles = manifest?.[cfg.manifestKey];
                    if (activeCycles && activeCycles.length > 0) {
                        csvUrl = `/data/${activeCycles[0].tracks}`;
                        if (activeCycles[0].paired) {
                            pairedUrl = `/data/${activeCycles[0].paired}`;
                        }
                    }
                } catch (e) {
                    if (e?.name === "AbortError") return;
                    console.warn("Failed to fetch cycles_manifest.json, using fallback URLs", e);
                }
            }

            const cacheKey = `${cfg.id}|${csvUrl}|${pairedUrl || ""}`;

            try {
                const cacheCheck = await callWorker("HAS_CACHE", { cacheKey });
                if (controller.signal.aborted) return;

                let encryptedCsv = null;
                let encryptedPaired = null;

                if (!cacheCheck.hasCache || forceRefresh) {
                    const bust = `?t=${Date.now()}`;
                    const fetchMain = fetch(getAssetUrl(`${csvUrl}${bust}`), {
                        signal: controller.signal,
                    }).then(async (res) => {
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        return res.text();
                    });

                    const fetchPaired = pairedUrl
                        ? fetch(getAssetUrl(`${pairedUrl}${bust}`), {
                              signal: controller.signal,
                          })
                              .then((res) => (res.ok ? res.text() : null))
                              .catch(() => null)
                        : Promise.resolve(null);

                    [encryptedCsv, encryptedPaired] = await Promise.all([
                        fetchMain,
                        fetchPaired,
                    ]);
                    if (controller.signal.aborted) return;
                }

                setStatusMsg("Clustering & analyzing ensemble tracks…");
                const workerRes = await callWorker("PROCESS_DATASET", {
                    cacheKey,
                    encryptedCsv,
                    encryptedPaired,
                    datasetId: cfg.id,
                    basinId: basin,
                    horizon,
                    includeCones: true,
                });

                // Ignore stale responses if a newer load started while worker ran
                if (controller.signal.aborted || abortRef.current !== controller) {
                    return;
                }

                const result = workerRes.result;
                const initDate = result.initDateMs ? new Date(result.initDateMs) : null;
                setRunInitDate(initDate);

                if (cfg.id === "aigefs" && initDate) {
                    const diffHours = (Date.now() - initDate.getTime()) / 3600000;
                    setIsAigefsOutdated(diffHours > 24);
                } else {
                    setIsAigefsOutdated(false);
                }

                setRunLabel(`${cfg.label} · ${result.runInitTime}`);
                setRawRowCount(result.rawRowCount);
                setAllTracks(result.allTracks);
                setTrackDistIds(result.trackDistIds);
                setDisturbances(result.disturbances);
                setTrackCount(result.allTracks.length);

                if (result.allTracks.length > 0) {
                    setStatus("ok");
                    setStatusMsg("");
                } else if (result.rawRowCount > 0) {
                    setStatus("none");
                    setStatusMsg(
                        `No active tropical disturbances are being tracked in the current ${cfg.label} run.`
                    );
                } else {
                    setStatus("none");
                    setStatusMsg(`No tracks found in the current ${cfg.label} run data.`);
                }

                if (onDatasetLoaded) {
                    onDatasetLoaded(result, currentSeq);
                }
            } catch (err) {
                if (err?.name === "AbortError" || controller.signal.aborted) return;
                setStatus("error");
                setStatusMsg(`Failed to load ${cfg.label} data (${err.message}).`);
                console.error(err);
            }
        },
        [leafletReady, dataset, horizon, basin, callWorker, fetchManifest, onDatasetLoaded]
    );

    useEffect(() => {
        loadData();
    }, [loadData]);

    return {
        status,
        statusMsg,
        runLabel,
        runInitDate,
        trackCount,
        rawRowCount,
        disturbances,
        allTracks,
        trackDistIds,
        maxAnimHour,
        isAigefsOutdated,
        cyclesManifest,
        setCyclesManifest,
        fetchManifest,
        callWorker,
        refreshData: () => loadData({ forceRefresh: true }),
    };
}
