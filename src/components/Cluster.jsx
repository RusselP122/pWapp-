import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import EnsembleGraphicViewer from "./spaghetti/EnsembleGraphicViewer.jsx";
import { getAssetUrl } from "../utils/spaghettiConfig.js";
import {
  MODEL_LIST,
  getModelConfig,
  matchesModelId,
  isMonitoringEntry,
  getAvailableDates,
  getCyclesForDateAndModel,
  getBestAvailableCycle,
  formatDateLabel,
  formatClusterLabel,
  sanitizeFilenamePart
} from "../utils/spaghettiViewerUtils.js";

export default function Cluster() {
  const [manifestData, setManifestData] = useState([]);
  const [loadingManifest, setLoadingManifest] = useState(true);
  const [manifestError, setManifestError] = useState(null);

  const [selectedDate, setSelectedDate] = useState("");
  const [selectedCycle, setSelectedCycle] = useState("18Z");
  const [selectedModel, setSelectedModel] = useState("gdm_wncv3");
  const [selectedDisturbance, setSelectedDisturbance] = useState("");

  const fetchAbortRef = useRef(null);

  const fetchManifest = useCallback(() => {
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
    }
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setLoadingManifest(true);
    setManifestError(null);
    const url = `${getAssetUrl("data/spaghetti_manifest.json")}?t=${Date.now()}`;

    fetch(url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setManifestData(Array.isArray(data) ? data : []);
        setLoadingManifest(false);
      })
      .catch((err) => {
        if (controller.signal.aborted || err.name === "AbortError") return;
        console.warn("Could not load spaghetti_manifest.json:", err);
        setManifestError(err.message || "Failed to fetch manifest");
        setLoadingManifest(false);
      });
  }, []);

  useEffect(() => {
    fetchManifest();
    return () => {
      if (fetchAbortRef.current) {
        fetchAbortRef.current.abort();
      }
    };
  }, [fetchManifest]);

  const monitoringEntries = useMemo(
    () => manifestData.filter((entry) => isMonitoringEntry(entry)),
    [manifestData]
  );

  // Strictly latest 2 dates present in the manifest (no fake today fallback)
  const availableDates = useMemo(
    () => getAvailableDates(monitoringEntries, 2),
    [monitoringEntries]
  );

  useEffect(() => {
    if (availableDates.length === 0) {
      if (selectedDate) setSelectedDate("");
      return;
    }
    if (!selectedDate || !availableDates.includes(selectedDate)) {
      setSelectedDate(availableDates[0]);
    }
  }, [availableDates, selectedDate]);

  const dateEntries = useMemo(() => {
    if (!selectedDate) return [];
    return monitoringEntries.filter((e) => e.init_date === selectedDate);
  }, [monitoringEntries, selectedDate]);

  const availableModelsOnDate = useMemo(() => {
    const set = new Set();
    for (const m of MODEL_LIST) {
      if (dateEntries.some((e) => matchesModelId(e.model, m.id))) {
        set.add(m.id);
      }
    }
    return set;
  }, [dateEntries]);

  const availableDatesForModel = useMemo(
    () =>
      availableDates.filter((dateStr) =>
        monitoringEntries.some(
          (e) => e.init_date === dateStr && matchesModelId(e.model, selectedModel)
        )
      ),
    [availableDates, monitoringEntries, selectedModel]
  );

  // Cycles strictly available for selected date AND active model (no cross-model fallback)
  const availableCyclesForDate = useMemo(
    () => getCyclesForDateAndModel(dateEntries, selectedModel),
    [dateEntries, selectedModel]
  );

  useEffect(() => {
    if (availableCyclesForDate.size === 0) return;
    if (!availableCyclesForDate.has(selectedCycle)) {
      const nextBest = getBestAvailableCycle(availableCyclesForDate);
      if (nextBest) {
        setSelectedCycle(nextBest);
      }
    }
  }, [selectedDate, selectedModel, availableCyclesForDate, selectedCycle]);

  // Disturbance targets strictly filtered by selected date, cycle, AND active model
  const disturbancesForCycle = useMemo(() => {
    const subset = dateEntries.filter(
      (e) =>
        String(e.cycle || "").toUpperCase() === selectedCycle &&
        matchesModelId(e.model, selectedModel)
    );
    return Array.from(new Set(subset.map((e) => e.storm_id).filter(Boolean))).sort();
  }, [dateEntries, selectedCycle, selectedModel]);

  useEffect(() => {
    if (disturbancesForCycle.length > 0) {
      if (!selectedDisturbance || !disturbancesForCycle.includes(selectedDisturbance)) {
        setSelectedDisturbance(disturbancesForCycle[0]);
      }
    } else if (selectedDisturbance) {
      setSelectedDisturbance("");
    }
  }, [disturbancesForCycle, selectedDisturbance]);

  const currentEntry = useMemo(() => {
    return (
      dateEntries.find((e) => {
        const matchCycle = String(e.cycle || "").toUpperCase() === selectedCycle;
        const matchModel = matchesModelId(e.model, selectedModel);
        const matchDist = !selectedDisturbance || e.storm_id === selectedDisturbance;
        return matchCycle && matchModel && matchDist;
      }) || null
    );
  }, [dateEntries, selectedCycle, selectedModel, selectedDisturbance]);

  const activeModelMeta = getModelConfig(selectedModel);

  const disturbanceDisplayName = useMemo(() => {
    if (!selectedDisturbance) return "Cluster 01";
    const idx = Math.max(0, disturbancesForCycle.indexOf(selectedDisturbance));
    const base = formatClusterLabel(selectedDisturbance, idx, currentEntry);
    if (currentEntry?.region) {
      return `${base} (${currentEntry.region})`;
    }
    if (selectedDisturbance.toUpperCase().includes("CP") || currentEntry?.basin === "CP") {
      return `${base} (Central Pacific / Dateline)`;
    }
    return base;
  }, [selectedDisturbance, disturbancesForCycle, currentEntry]);

  const downloadFilename = useMemo(() => {
    const tag = sanitizeFilenamePart(selectedDisturbance || disturbanceDisplayName, "CLUSTER");
    const datePart = sanitizeFilenamePart(selectedDate || "LATEST", "LATEST");
    const cyclePart = sanitizeFilenamePart(selectedCycle || "00Z", "00Z");
    const modelPart = sanitizeFilenamePart(selectedModel, "MODEL");
    return `CLUSTER_${tag}_${datePart}_${cyclePart}_${modelPart}.png`;
  }, [selectedDisturbance, disturbanceDisplayName, selectedDate, selectedCycle, selectedModel]);

  const systemSelector =
    disturbancesForCycle.length > 0 ? (
      <div className="flex flex-col gap-1.5 self-start sm:self-end">
        <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400 font-semibold">
          Detected Systems ({disturbancesForCycle.length})
        </span>
        <div className="flex flex-wrap items-center gap-1.5 bg-slate-950/80 p-1 rounded-xl border border-slate-800">
          {disturbancesForCycle.map((dId, idx) => {
            const isSelected = selectedDisturbance === dId;
            // Match strictly on selectedModel as well as cycle and disturbance ID
            const entry = dateEntries.find(
              (e) =>
                String(e.cycle || "").toUpperCase() === selectedCycle &&
                e.storm_id === dId &&
                matchesModelId(e.model, selectedModel)
            );
            const label = formatClusterLabel(dId, idx, entry);
            const isCpac = Boolean(
              (entry &&
                (entry.basin === "CP" ||
                  (entry.region && entry.region.toUpperCase().includes("CENTRAL PACIFIC")))) ||
                dId.toUpperCase().includes("CP")
            );

            return (
              <button
                key={dId}
                onClick={() => setSelectedDisturbance(dId)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-colors cursor-pointer flex items-center gap-1.5 ${
                  isSelected
                    ? "bg-cyan-500 text-slate-950 shadow-sm"
                    : "text-slate-400 hover:text-white hover:bg-slate-900"
                }`}
              >
                <span>{label}</span>
                {isCpac && (
                  <span
                    className={`text-[9px] px-1.5 py-0.2 rounded font-mono font-bold tracking-tight uppercase ${
                      isSelected
                        ? "bg-amber-400 text-slate-950"
                        : "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                    }`}
                  >
                    CPAC
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    ) : null;

  return (
    <EnsembleGraphicViewer
      badgeText="AI Ensemble Cluster Tracking"
      titleLead="Cluster"
      titleAccent="Monitoring"
      subtitle="Autonomous trajectory clustering resolving under-monitoring circulation envelopes, cyclogenesis density signals, and potential low pressure area developments before official naming."
      loadingManifest={loadingManifest}
      manifestError={manifestError}
      onRetry={fetchManifest}
      emptyTitle="No Under-Monitoring Disturbances Detected"
      emptyDescription="No low-pressure area or pre-genesis circulation clusters exceeded ensemble monitoring thresholds in the latest 48-hour forecast window."
      availableDates={availableDates}
      selectedDate={selectedDate}
      onSelectDate={setSelectedDate}
      selectedModel={selectedModel}
      onSelectModel={setSelectedModel}
      availableModelsOnDate={availableModelsOnDate}
      availableDatesForModel={availableDatesForModel}
      availableCyclesForDate={availableCyclesForDate}
      selectedCycle={selectedCycle}
      onSelectCycle={setSelectedCycle}
      systemSelector={systemSelector}
      currentEntry={currentEntry}
      cardTitle={`${activeModelMeta.name} • ${disturbanceDisplayName}`}
      badges={currentEntry?.region ? [currentEntry.region] : []}
      downloadFilename={downloadFilename}
      imageAlt={`AI Cluster Forecast Track - ${disturbanceDisplayName} - ${selectedDate} ${selectedCycle}`}
      lightboxAlt={`Cluster Guidance - ${disturbanceDisplayName}`}
      loadingMessage="Loading Cluster Guidance Map..."
      unavailableDescription={
        <>
          The under-monitoring spaghetti plot for{" "}
          <span className="font-mono text-cyan-300 font-bold">
            {activeModelMeta.name} ({activeModelMeta.members}M)
          </span>{" "}
          on{" "}
          <span className="font-mono text-cyan-300 font-bold">
            {formatDateLabel(selectedDate)}
          </span>{" "}
          {availableCyclesForDate.size > 0 && (
            <>
              at cycle <span className="font-mono text-cyan-300 font-bold">{selectedCycle}</span>{" "}
            </>
          )}
          may still be generating or did not meet monitoring thresholds.
        </>
      }
    />
  );
}
