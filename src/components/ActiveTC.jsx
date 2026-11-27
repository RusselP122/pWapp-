import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Wind } from "lucide-react";
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
  resolveActiveStormMeta,
  sanitizeFilenamePart
} from "../utils/spaghettiViewerUtils.js";

export default function ActiveTC() {
  const [manifestData, setManifestData] = useState([]);
  const [stormsIndex, setStormsIndex] = useState([]);
  const [loadingManifest, setLoadingManifest] = useState(true);
  const [manifestError, setManifestError] = useState(null);

  const [selectedDate, setSelectedDate] = useState("");
  const [selectedCycle, setSelectedCycle] = useState("18Z");
  const [selectedModel, setSelectedModel] = useState("gdm_wncv3");
  const [selectedStormId, setSelectedStormId] = useState("");

  const fetchAbortRef = useRef(null);

  const fetchManifest = useCallback(() => {
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
    }
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setLoadingManifest(true);
    setManifestError(null);
    const cacheBust = `?t=${Date.now()}`;
    const manifestUrl = `${getAssetUrl("data/spaghetti_manifest.json")}${cacheBust}`;
    const stormsUrl = `${getAssetUrl("data/tc_storms_index.json")}${cacheBust}`;

    Promise.all([
      fetch(manifestUrl, { signal: controller.signal }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      }),
      fetch(stormsUrl, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : []))
        .catch(() => [])
    ])
      .then(([manifest, storms]) => {
        if (controller.signal.aborted) return;
        setManifestData(Array.isArray(manifest) ? manifest : []);
        setStormsIndex(Array.isArray(storms) ? storms : []);
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

  const activeTCEntries = useMemo(
    () => manifestData.filter((entry) => entry && !isMonitoringEntry(entry)),
    [manifestData]
  );

  // Strictly latest 2 dates present in active TC entries (no fake today fallback)
  const availableDates = useMemo(
    () => getAvailableDates(activeTCEntries, 2),
    [activeTCEntries]
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
    return activeTCEntries.filter((e) => e.init_date === selectedDate);
  }, [activeTCEntries, selectedDate]);

  // All active storms present on the selected date (across cycles/models)
  const stormsOnDate = useMemo(
    () => Array.from(new Set(dateEntries.map((e) => e.storm_id).filter(Boolean))).sort(),
    [dateEntries]
  );

  useEffect(() => {
    if (stormsOnDate.length > 0) {
      if (!selectedStormId || !stormsOnDate.includes(selectedStormId)) {
        setSelectedStormId(stormsOnDate[0]);
      }
    } else if (selectedStormId) {
      setSelectedStormId("");
    }
  }, [stormsOnDate, selectedStormId]);

  const availableModelsOnDate = useMemo(() => {
    const set = new Set();
    const scoped = selectedStormId
      ? dateEntries.filter((e) => e.storm_id === selectedStormId)
      : dateEntries;
    const pool = scoped.length > 0 ? scoped : dateEntries;
    for (const m of MODEL_LIST) {
      if (pool.some((e) => matchesModelId(e.model, m.id))) {
        set.add(m.id);
      }
    }
    return set;
  }, [dateEntries, selectedStormId]);

  const availableDatesForModel = useMemo(
    () =>
      availableDates.filter((dateStr) =>
        activeTCEntries.some(
          (e) =>
            e.init_date === dateStr &&
            matchesModelId(e.model, selectedModel) &&
            (!selectedStormId || e.storm_id === selectedStormId)
        )
      ),
    [availableDates, activeTCEntries, selectedModel, selectedStormId]
  );

  // Cycles strictly available for selected date, selected storm, and selected model (no cross-model leak)
  const availableCyclesForDate = useMemo(() => {
    const stormScoped = selectedStormId
      ? dateEntries.filter((e) => e.storm_id === selectedStormId)
      : dateEntries;
    return getCyclesForDateAndModel(stormScoped, selectedModel);
  }, [dateEntries, selectedStormId, selectedModel]);

  useEffect(() => {
    if (availableCyclesForDate.size === 0) return;
    if (!availableCyclesForDate.has(selectedCycle)) {
      const nextBest = getBestAvailableCycle(availableCyclesForDate);
      if (nextBest) {
        setSelectedCycle(nextBest);
      }
    }
  }, [selectedDate, selectedModel, selectedStormId, availableCyclesForDate, selectedCycle]);

  const handleSelectStorm = useCallback(
    (sId) => {
      setSelectedStormId(sId);
      const stormDateEntries = dateEntries.filter((e) => e.storm_id === sId);
      const modelStormCycles = getCyclesForDateAndModel(stormDateEntries, selectedModel);

      if (modelStormCycles.size > 0) {
        if (!modelStormCycles.has(selectedCycle)) {
          const best = getBestAvailableCycle(modelStormCycles);
          if (best) setSelectedCycle(best);
        }
        return;
      }

      // If current model has no runs for this storm on selectedDate, stay in selectedModel
      // if no other model exists; otherwise let user see or auto-pick the available model cleanly.
      const fallbackModel = MODEL_LIST.find(
        (m) => getCyclesForDateAndModel(stormDateEntries, m.id).size > 0
      );
      if (fallbackModel) {
        const altCycles = getCyclesForDateAndModel(stormDateEntries, fallbackModel.id);
        setSelectedModel(fallbackModel.id);
        const best = getBestAvailableCycle(altCycles);
        if (best) setSelectedCycle(best);
      }
    },
    [dateEntries, selectedModel, selectedCycle]
  );

  const currentEntry = useMemo(() => {
    return (
      dateEntries.find((e) => {
        const matchCycle = String(e.cycle || "").toUpperCase() === selectedCycle;
        const matchModel = matchesModelId(e.model, selectedModel);
        const matchStorm = !selectedStormId || e.storm_id === selectedStormId;
        return matchCycle && matchModel && matchStorm;
      }) || null
    );
  }, [dateEntries, selectedCycle, selectedModel, selectedStormId]);

  const activeModelMeta = getModelConfig(selectedModel);

  const selectedStormMeta = useMemo(
    () =>
      resolveActiveStormMeta({
        stormId: selectedStormId,
        currentEntry,
        dateEntries,
        allActiveEntries: activeTCEntries,
        stormsIndex,
        selectedCycle,
        selectedModel,
        selectedDate
      }),
    [
      selectedStormId,
      currentEntry,
      dateEntries,
      activeTCEntries,
      stormsIndex,
      selectedCycle,
      selectedModel,
      selectedDate
    ]
  );

  const downloadFilename = useMemo(() => {
    const stormTag = sanitizeFilenamePart(selectedStormId || "ACTIVE_TC", "ACTIVE_TC");
    const datePart = sanitizeFilenamePart(selectedDate || "LATEST", "LATEST");
    const cyclePart = sanitizeFilenamePart(selectedCycle || "00Z", "00Z");
    const modelPart = sanitizeFilenamePart(selectedModel, "MODEL");
    return `ACTIVE_TC_${stormTag}_${datePart}_${cyclePart}_${modelPart}.png`;
  }, [selectedStormId, selectedDate, selectedCycle, selectedModel]);

  const badges = useMemo(() => {
    if (selectedStormMeta.isCpac) return ["Central Pacific / Dateline"];
    if (currentEntry?.region) return [currentEntry.region];
    return [];
  }, [selectedStormMeta.isCpac, currentEntry]);

  const systemSelector =
    stormsOnDate.length > 0 ? (
      <div className="flex flex-col gap-1.5 self-start sm:self-end">
        <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-1.5">
          <Wind className="w-3.5 h-3.5 text-cyan-400" />
          Active Cyclone ({stormsOnDate.length})
        </span>
        <div className="flex flex-wrap items-center gap-1.5 bg-slate-950/80 p-1 rounded-xl border border-slate-800">
          {stormsOnDate.map((sId) => {
            const isSelected = selectedStormId === sId;
            const meta = resolveActiveStormMeta({
              stormId: sId,
              currentEntry: isSelected ? currentEntry : null,
              dateEntries,
              allActiveEntries: activeTCEntries,
              stormsIndex,
              selectedCycle,
              selectedModel,
              selectedDate
            });

            return (
              <button
                key={sId}
                onClick={() => handleSelectStorm(sId)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-colors cursor-pointer flex items-center gap-1.5 ${
                  isSelected
                    ? "bg-cyan-500 text-slate-950 shadow-md"
                    : "text-slate-400 hover:text-white hover:bg-slate-900"
                }`}
              >
                <span>{meta.shortLabel}</span>
                {meta.badgeId && (
                  <span
                    className={`text-[10px] px-1 rounded ${
                      isSelected
                        ? "bg-slate-950/20 text-slate-950 font-bold"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {meta.badgeId}
                  </span>
                )}
                {meta.isCpac && (
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
      badgeText="AI Ensemble Active Cyclone Tracking"
      titleLead="Active"
      titleAccent="TC"
      subtitle="Multi-model AI ensemble spaghetti forecast tracks, dispersion envelopes, and Philippine landfall probability outlooks for active tropical cyclones and invest areas."
      loadingManifest={loadingManifest}
      manifestError={manifestError}
      onRetry={fetchManifest}
      emptyTitle="No Active Tropical Cyclones"
      emptyDescription="There are currently no active named tropical cyclones or tracked JTWC systems in the latest 48-hour AI ensemble archive."
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
      cardTitle={`${activeModelMeta.name} • ${selectedStormMeta.displayName}`}
      badges={badges}
      downloadFilename={downloadFilename}
      imageAlt={`Active TC Forecast Track - ${selectedStormMeta.displayName} - ${selectedDate} ${selectedCycle}`}
      lightboxAlt={`Active TC Guidance - ${selectedStormMeta.displayName}`}
      loadingMessage="Loading Active TC Guidance Map..."
      unavailableDescription={
        <>
          The ensemble spaghetti plot for{" "}
          <span className="font-mono text-cyan-300 font-bold">
            {selectedStormMeta.displayName}
          </span>{" "}
          in{" "}
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
          may still be compiling or unavailable.
        </>
      }
    />
  );
}
