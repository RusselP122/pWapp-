import {
    decodeObfuscatedData,
    analyzeEnsembleData,
} from "../utils/spaghettiAnalysis.js";
import { getDatasetConfig } from "../utils/spaghettiConfig.js";

// Cache decoded CSV text by URL path inside the worker so horizon/basin switches
// require zero network requests and zero re-decryption.
const decodedCsvCache = new Map();

self.onmessage = (e) => {
    const { type, requestId, payload } = e.data;

    try {
        if (type === "CLEAR_CACHE") {
            decodedCsvCache.clear();
            self.postMessage({ type: "CACHE_CLEARED", requestId });
            return;
        }

        if (type === "HAS_CACHE") {
            const { cacheKey } = payload;
            self.postMessage({
                type: "HAS_CACHE_RESULT",
                requestId,
                hasCache: decodedCsvCache.has(cacheKey),
            });
            return;
        }

        if (type === "PROCESS_DATASET") {
            const {
                cacheKey,
                encryptedCsv,
                encryptedPaired,
                datasetId,
                basinId,
                horizon,
                includeCones = true,
            } = payload;

            const cfg = getDatasetConfig(datasetId);
            let cached = decodedCsvCache.get(cacheKey);

            if (!cached) {
                if (!encryptedCsv) {
                    throw new Error(`Missing encrypted CSV payload for ${cacheKey}`);
                }
                const csvText = decodeObfuscatedData(encryptedCsv, cfg.xorKey);
                const pairedCsvText = encryptedPaired
                    ? decodeObfuscatedData(encryptedPaired, cfg.xorKey)
                    : null;
                cached = { csvText, pairedCsvText };
                decodedCsvCache.set(cacheKey, cached);
            }

            const result = analyzeEnsembleData({
                csvText: cached.csvText,
                pairedCsvText: cached.pairedCsvText,
                datasetId: cfg.id,
                basinId,
                horizon,
                includeCones,
            });

            self.postMessage({
                type: "DATASET_PROCESSED",
                requestId,
                result,
            });
            return;
        }

        if (type === "PROCESS_CYCLES") {
            const { cycles, datasetId, basinId, horizon } = payload;
            const cfg = getDatasetConfig(datasetId);
            const parsedCycles = [];

            for (const c of cycles) {
                let cached = decodedCsvCache.get(c.cacheKey);
                if (!cached) {
                    const csvText = decodeObfuscatedData(c.encryptedCsv, cfg.xorKey);
                    const pairedCsvText = c.encryptedPaired
                        ? decodeObfuscatedData(c.encryptedPaired, cfg.xorKey)
                        : null;
                    cached = { csvText, pairedCsvText };
                    decodedCsvCache.set(c.cacheKey, cached);
                }

                const analyzed = analyzeEnsembleData({
                    csvText: cached.csvText,
                    pairedCsvText: cached.pairedCsvText,
                    datasetId: cfg.id,
                    basinId,
                    horizon,
                    includeCones: false,
                });

                parsedCycles.push({
                    cycleTime: c.cycleTime,
                    disturbances: analyzed.disturbances,
                    tracksByDisturbance: analyzed.tracksByDisturbance,
                });
            }

            self.postMessage({
                type: "CYCLES_PROCESSED",
                requestId,
                parsedCycles,
            });
        }
    } catch (error) {
        self.postMessage({
            type: "WORKER_ERROR",
            requestId,
            error: error?.message || "Worker processing error",
        });
    }
};
