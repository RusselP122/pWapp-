import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Layers,
  Calendar,
  Clock,
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  ShieldAlert,
  Eye,
  Cpu,
  Compass,
  AlertCircle,
  RefreshCw
} from "lucide-react";
import {
  CYCLE_OPTIONS,
  MODEL_LIST,
  getModelConfig,
  formatDateLabel,
  getAdjacentAvailableCycle,
  getEntryImageUrls
} from "../../utils/spaghettiViewerUtils.js";

const MIN_ZOOM = 1;
const MAX_ZOOM = 3.5;
const ZOOM_STEP = 0.25;

export default function EnsembleGraphicViewer({
  badgeText,
  titleLead,
  titleAccent,
  subtitle,
  loadingManifest,
  manifestError,
  onRetry,
  emptyTitle,
  emptyDescription,
  availableDates,
  selectedDate,
  onSelectDate,
  selectedModel,
  onSelectModel,
  availableModelsOnDate,
  availableDatesForModel,
  availableCyclesForDate,
  selectedCycle,
  onSelectCycle,
  systemSelector = null,
  currentEntry = null,
  cardTitle,
  badges = [],
  downloadFilename,
  imageAlt,
  lightboxAlt,
  loadingMessage,
  unavailableDescription
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(MIN_ZOOM);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [triedAltUrl, setTriedAltUrl] = useState(false);

  const stageImgRef = useRef(null);
  const lightboxCanvasRef = useRef(null);
  const touchDistanceRef = useRef(null);
  const initialZoomRef = useRef(MIN_ZOOM);
  const lastTapRef = useRef(0);
  const zoomRef = useRef(zoomLevel);
  zoomRef.current = zoomLevel;

  const activeModelMeta = getModelConfig(selectedModel);
  const { primaryUrl, altUrl } = getEntryImageUrls(currentEntry);
  const imageUrl = triedAltUrl && altUrl ? altUrl : primaryUrl;

  const applyZoom = useCallback((nextZoom) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    setZoomLevel(clamped);
    if (clamped <= MIN_ZOOM) {
      setPanOffset({ x: 0, y: 0 });
      setIsDragging(false);
    }
  }, []);

  // Reset image & zoom state whenever the target asset changes
  useEffect(() => {
    setTriedAltUrl(false);
    setImageError(false);
    setZoomLevel(MIN_ZOOM);
    setPanOffset({ x: 0, y: 0 });
    setIsDragging(false);
    setImageLoading(Boolean(primaryUrl));
  }, [primaryUrl]);

  // Guard against cached images that finish synchronously before onLoad attaches
  useEffect(() => {
    if (!imageUrl) {
      setImageLoading(false);
      return;
    }
    const imgEl = stageImgRef.current;
    if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
      setImageLoading(false);
    }
  }, [imageUrl]);

  // Close fullscreen if no valid image exists
  useEffect(() => {
    if (!imageUrl && isFullscreen) {
      setIsFullscreen(false);
    }
  }, [imageUrl, isFullscreen]);

  const canOpenFullscreen = Boolean(
    imageUrl && !imageError && !loadingManifest && !manifestError
  );

  const openFullscreen = useCallback(() => {
    if (!canOpenFullscreen) return;
    setIsFullscreen(true);
    setZoomLevel(MIN_ZOOM);
    setPanOffset({ x: 0, y: 0 });
    setIsDragging(false);
  }, [canOpenFullscreen]);

  const closeFullscreen = useCallback(() => {
    setIsFullscreen(false);
    setZoomLevel(MIN_ZOOM);
    setPanOffset({ x: 0, y: 0 });
    setIsDragging(false);
  }, []);

  // Keyboard navigation across available cycles (steps over gaps) and ESC
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        closeFullscreen();
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;

      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable) {
        return;
      }

      const direction = e.key === "ArrowLeft" ? "prev" : "next";
      const nextCycle = getAdjacentAvailableCycle(availableCyclesForDate, selectedCycle, direction);
      if (nextCycle) {
        e.preventDefault();
        onSelectCycle(nextCycle);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedCycle, availableCyclesForDate, onSelectCycle, closeFullscreen]);

  // Native non-passive wheel zoom listener inside lightbox
  useEffect(() => {
    const canvas = lightboxCanvasRef.current;
    if (!canvas || !isFullscreen) return;

    const onWheel = (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      applyZoom(zoomRef.current + delta);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [isFullscreen, applyZoom]);

  const handleImageLoad = () => {
    setImageLoading(false);
    setImageError(false);
  };

  const handleImageError = () => {
    if (!triedAltUrl && altUrl) {
      setTriedAltUrl(true);
      setImageLoading(true);
      return;
    }
    setImageLoading(false);
    setImageError(true);
  };

  // Mouse pan handlers
  const handleMouseDown = (e) => {
    if (zoomLevel > MIN_ZOOM) {
      e.preventDefault();
      setIsDragging(true);
      setDragStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
    }
  };

  const handleMouseMove = (e) => {
    if (isDragging && zoomLevel > MIN_ZOOM) {
      e.preventDefault();
      setPanOffset({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  };

  const handleMouseUp = () => {
    if (isDragging) {
      setIsDragging(false);
    }
  };

  // Touch pan & pinch-to-zoom handlers
  const handleTouchStart = (e) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      if (zoomLevel > MIN_ZOOM) {
        setIsDragging(true);
        setDragStart({ x: touch.clientX - panOffset.x, y: touch.clientY - panOffset.y });
      }

      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        applyZoom(zoomLevel > MIN_ZOOM ? MIN_ZOOM : 2.2);
      }
      lastTapRef.current = now;
    } else if (e.touches.length === 2) {
      setIsDragging(false);
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      touchDistanceRef.current = dist > 0 ? dist : null;
      initialZoomRef.current = zoomLevel;
    }
  };

  const handleTouchMove = (e) => {
    if (e.touches.length === 1 && isDragging && zoomLevel > MIN_ZOOM) {
      const touch = e.touches[0];
      setPanOffset({
        x: touch.clientX - dragStart.x,
        y: touch.clientY - dragStart.y
      });
    } else if (
      e.touches.length === 2 &&
      touchDistanceRef.current !== null &&
      touchDistanceRef.current > 0
    ) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const currentDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const ratio = currentDist / touchDistanceRef.current;
      applyZoom(initialZoomRef.current * ratio);
    }
  };

  const handleTouchEnd = (e) => {
    if (e.touches.length < 2) {
      touchDistanceRef.current = null;
    }
    if (e.touches.length === 0) {
      setIsDragging(false);
    }
  };

  const hasAnyDates = availableDates.length > 0;
  const alternativeCycles = Array.from(availableCyclesForDate).filter((c) => c !== selectedCycle);
  const alternativeModels = MODEL_LIST.filter(
    (m) => m.id !== selectedModel && availableModelsOnDate?.has(m.id)
  );
  const alternativeDates = (availableDatesForModel || []).filter((d) => d !== selectedDate);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased selection:bg-cyan-500 selection:text-white">
      {/* Broadcast Header Ambient Glow */}
      <div className="relative overflow-hidden border-b border-slate-800/80 bg-gradient-to-b from-slate-900/90 via-slate-950 to-slate-950">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none animate-pulse"></div>
        <div className="absolute top-0 right-1/4 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none"></div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 mb-2.5 rounded-full bg-cyan-950/70 border border-cyan-500/40 text-cyan-300 text-xs font-mono font-semibold tracking-wider uppercase shadow-inner shadow-cyan-950/50">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400"></span>
                </span>
                {badgeText}
              </div>

              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight text-white flex items-center gap-2.5">
                {titleLead}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-sky-400">
                  {titleAccent}
                </span>
              </h1>

              <p className="mt-1.5 text-xs sm:text-sm text-slate-400 max-w-3xl leading-relaxed">
                {subtitle}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Interactive Control Panel & Viewer */}
      <main className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-6 space-y-6 flex-grow">
        {/* Navigation & Selector Toolbar */}
        <div className="bg-slate-900/80 border border-slate-800/90 rounded-2xl p-4 sm:p-5 shadow-2xl backdrop-blur-xl space-y-5">
          {/* Top Control Bar: Date Selector & Model Selector */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800/60 pb-4">
            {/* 1. Date Selector Tabs */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1.5 font-semibold">
                <Calendar className="w-3.5 h-3.5 text-cyan-400" />
                Forecast Run Date
              </label>
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
                {hasAnyDates ? (
                  availableDates.map((dateStr, idx) => {
                    const isSelected = selectedDate === dateStr;
                    const isLatest = idx === 0;
                    return (
                      <button
                        key={dateStr}
                        onClick={() => onSelectDate(dateStr)}
                        className={`relative px-3.5 py-1.5 rounded-xl text-xs font-semibold tracking-wide transition-all duration-200 whitespace-nowrap flex items-center gap-2 cursor-pointer ${
                          isSelected
                            ? "bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-950/60 ring-2 ring-cyan-400/50"
                            : "bg-slate-800/70 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-700/60"
                        }`}
                      >
                        <span>{formatDateLabel(dateStr)}</span>
                        {isLatest && (
                          <span
                            className={`text-[9px] px-1.5 py-0.2 rounded font-mono font-bold uppercase ${
                              isSelected
                                ? "bg-white/20 text-white"
                                : "bg-cyan-950/80 text-cyan-300 border border-cyan-500/30"
                            }`}
                          >
                            Latest
                          </span>
                        )}
                      </button>
                    );
                  })
                ) : (
                  <span className="px-3 py-1.5 rounded-xl text-xs font-mono text-slate-500 bg-slate-950/60 border border-slate-800">
                    {loadingManifest ? "Loading dates..." : "No active dates"}
                  </span>
                )}
              </div>
            </div>

            {/* 2. Model Selector Switcher */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1.5 font-semibold">
                <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                DeepMind AI Model
              </label>
              <div className="grid grid-cols-2 gap-2 bg-slate-950/80 p-1 rounded-xl border border-slate-800">
                {MODEL_LIST.map((m) => {
                  const isSelected = selectedModel === m.id;
                  const hasModelDataOnDate = !hasAnyDates || Boolean(availableModelsOnDate?.has(m.id));
                  return (
                    <button
                      key={m.id}
                      onClick={() => onSelectModel(m.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer ${
                        isSelected
                          ? `bg-gradient-to-r ${m.badgeColor} text-white shadow-md`
                          : hasModelDataOnDate
                          ? "text-slate-300 hover:text-white hover:bg-slate-900"
                          : "text-slate-500 hover:text-slate-300 hover:bg-slate-900/60"
                      }`}
                      title={
                        hasModelDataOnDate
                          ? m.desc
                          : `${m.desc} (No runs archived for ${formatDateLabel(selectedDate)})`
                      }
                    >
                      <span>{m.name}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-md font-mono ${
                          isSelected ? "bg-white/20 text-white" : "bg-slate-800 text-slate-400"
                        }`}
                      >
                        {m.members}M
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Cycle Selector Buttons (00, 06, 12, 18) & Right-side System/Storm Selector */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-cyan-400" />
                <span className="text-[11px] font-mono uppercase tracking-wider text-slate-300 font-semibold">
                  Initialization Cycle (UTC & Philippine Standard Time)
                </span>
                <span className="text-[10px] text-cyan-400/80 font-mono hidden sm:inline">
                  • Click 00, 06, 12, or 18
                </span>
              </div>

              <div className="grid grid-cols-4 gap-2 sm:gap-3 max-w-xl">
                {CYCLE_OPTIONS.map((c) => {
                  const hasData = availableCyclesForDate.has(c.code);
                  const isSelected = hasData && selectedCycle === c.code;

                  return (
                    <button
                      key={c.code}
                      disabled={!hasData}
                      onClick={() => {
                        if (hasData) onSelectCycle(c.code);
                      }}
                      className={`relative flex flex-col items-center justify-center py-2.5 px-2 rounded-xl transition-all duration-200 border ${
                        isSelected
                          ? "bg-cyan-500 text-slate-950 border-cyan-400 shadow-lg shadow-cyan-500/25 scale-[1.02] cursor-pointer"
                          : hasData
                          ? "bg-slate-800/80 hover:bg-slate-800 text-white border-slate-700/80 hover:border-slate-600 cursor-pointer"
                          : "bg-slate-950/40 text-slate-600 border-slate-900/60 opacity-40 cursor-not-allowed select-none"
                      }`}
                      title={
                        hasData
                          ? `Cycle ${c.code} (${c.pht})`
                          : `No forecast data available for ${c.code}`
                      }
                    >
                      <div className="flex items-center gap-0.5">
                        <span
                          className={`text-base sm:text-lg font-black tracking-tight font-mono ${
                            !hasData ? "text-slate-600" : ""
                          }`}
                        >
                          {c.label}
                        </span>
                        <span
                          className={`text-[10px] font-bold ${
                            !hasData ? "text-slate-600" : "opacity-80"
                          }`}
                        >
                          Z
                        </span>
                      </div>

                      <span
                        className={`text-[9px] font-mono leading-tight tracking-tight mt-0.5 whitespace-nowrap ${
                          isSelected
                            ? "text-slate-950 font-bold"
                            : hasData
                            ? "text-slate-400"
                            : "text-slate-600"
                        }`}
                      >
                        {c.pht.split(" ")[0]} {c.pht.split(" ")[1]}
                      </span>

                      {hasData && (
                        <span
                          className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${
                            isSelected ? "bg-slate-950" : "bg-cyan-400"
                          }`}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {systemSelector}
          </div>
        </div>

        {/* Display Canvas & Map Card */}
        <div className="relative bg-slate-900/90 border border-slate-800/80 rounded-2xl overflow-hidden shadow-2xl backdrop-blur-md">
          {/* Card Top Information Bar */}
          <div className="px-4 py-3 bg-slate-900 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse"></span>
              <span className="font-bold text-white tracking-wide">{cardTitle}</span>
              {badges.map((badge) => (
                <span
                  key={badge}
                  className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 uppercase"
                >
                  {badge}
                </span>
              ))}
              <span className="text-slate-400 font-mono">
                {selectedDate
                  ? `[INIT: ${formatDateLabel(selectedDate)} ${
                      availableCyclesForDate.has(selectedCycle) ? selectedCycle : "N/A"
                    }]`
                  : "[NO ARCHIVED RUNS]"}
              </span>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-2">
              {canOpenFullscreen && (
                <a
                  href={imageUrl}
                  download={downloadFilename}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors flex items-center gap-1.5 text-xs font-mono"
                  title="Download High-Resolution Plot"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Save Image</span>
                </a>
              )}

              <button
                onClick={openFullscreen}
                disabled={!canOpenFullscreen}
                className={`px-3 py-1 rounded-lg border transition-all flex items-center gap-1.5 text-xs font-semibold shadow-sm ${
                  canOpenFullscreen
                    ? "bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border-cyan-500/30 cursor-pointer"
                    : "bg-slate-800/40 text-slate-500 border-slate-800 opacity-50 cursor-not-allowed"
                }`}
              >
                <Maximize2 className="w-3.5 h-3.5" />
                <span>Fullscreen</span>
              </button>
            </div>
          </div>

          {/* Interactive Image Viewing Stage */}
          <div
            className={`relative w-full bg-slate-950/80 flex items-center justify-center p-2 sm:p-4 min-h-[460px] sm:min-h-[580px] lg:min-h-[680px] overflow-hidden select-none ${
              canOpenFullscreen ? "cursor-pointer" : "cursor-default"
            }`}
            onClick={openFullscreen}
          >
            {/* 1. Loading Spinner (Manifest or Plot) */}
            {(loadingManifest || (imageLoading && !imageError)) && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 z-20 gap-3">
                <div className="relative flex items-center justify-center w-14 h-14">
                  <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20 animate-ping"></div>
                  <div className="absolute inset-1 rounded-full border-2 border-dashed border-cyan-400 animate-spin [animation-duration:3s]"></div>
                  <Compass className="w-6 h-6 text-cyan-400 animate-pulse" />
                </div>
                <div className="text-center">
                  <p className="text-xs font-mono uppercase tracking-wider text-slate-200 font-semibold">
                    {loadingManifest ? "Loading Forecast Manifest..." : loadingMessage}
                  </p>
                  {!loadingManifest && (
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Rendering {activeModelMeta.name} ({activeModelMeta.members}M) {selectedCycle} tracks
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* 2. Manifest Fetch Error State */}
            {!loadingManifest && manifestError && (
              <div
                className="flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto my-12 bg-slate-900/60 border border-rose-500/30 rounded-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-3">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <h3 className="text-sm font-bold text-white mb-1">
                  Unable to Load Forecast Manifest
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                  Failed to retrieve `spaghetti_manifest.json` ({manifestError}). Please retry loading the latest forecast archive.
                </p>
                {onRetry && (
                  <button
                    onClick={onRetry}
                    className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry
                  </button>
                )}
              </div>
            )}

            {/* 3. Empty Manifest State (no fake 404 image requested) */}
            {!loadingManifest && !manifestError && !hasAnyDates && (
              <div
                className="flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto my-12 bg-slate-900/60 border border-slate-800 rounded-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="w-12 h-12 rounded-full bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mb-3">
                  <Compass className="w-6 h-6" />
                </div>
                <h3 className="text-sm font-bold text-white mb-1">{emptyTitle}</h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-4">{emptyDescription}</p>
                {onRetry && (
                  <button
                    onClick={onRetry}
                    className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-mono text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Check for Updates
                  </button>
                )}
              </div>
            )}

            {/* 4. Missing Model/Cycle Combo or Broken Asset Image */}
            {!loadingManifest && !manifestError && hasAnyDates && (!imageUrl || imageError) && (
              <div
                className="flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto my-12 bg-slate-900/60 border border-slate-800 rounded-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-3">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <h3 className="text-sm font-bold text-white mb-1">
                  {imageError
                    ? `Plot Unavailable for ${selectedCycle}`
                    : availableCyclesForDate.size === 0
                    ? `No ${activeModelMeta.name} (${activeModelMeta.members}M) Runs on ${formatDateLabel(
                        selectedDate
                      )}`
                    : `No ${activeModelMeta.name} Plot for ${selectedCycle}`}
                </h3>
                <div className="text-xs text-slate-400 leading-relaxed mb-4">
                  {unavailableDescription}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {alternativeCycles.map((altCycle) => (
                    <button
                      key={altCycle}
                      onClick={() => onSelectCycle(altCycle)}
                      className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold transition-all cursor-pointer"
                    >
                      View {altCycle}
                    </button>
                  ))}
                  {availableCyclesForDate.size === 0 &&
                    alternativeModels.map((altModel) => (
                      <button
                        key={altModel.id}
                        onClick={() => onSelectModel(altModel.id)}
                        className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold transition-all cursor-pointer"
                      >
                        Switch to {altModel.name} ({altModel.members}M)
                      </button>
                    ))}
                  {availableCyclesForDate.size === 0 &&
                    alternativeDates.map((altDate) => (
                      <button
                        key={altDate}
                        onClick={() => onSelectDate(altDate)}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-mono text-xs font-semibold transition-all cursor-pointer"
                      >
                        View {formatDateLabel(altDate)}
                      </button>
                    ))}
                </div>
              </div>
            )}

            {/* 5. Rendered Map Graphic */}
            {imageUrl && !imageError && (
              <div className="relative group max-w-full">
                <img
                  ref={stageImgRef}
                  src={imageUrl}
                  alt={imageAlt}
                  onLoad={handleImageLoad}
                  onError={handleImageError}
                  className={`w-auto h-auto max-w-full max-h-[82vh] object-contain rounded-xl shadow-2xl transition-all duration-300 ${
                    imageLoading ? "opacity-0" : "opacity-100 group-hover:scale-[1.008]"
                  }`}
                />

                <div className="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-900/90 text-cyan-300 border border-cyan-500/30 px-2.5 py-1 rounded-lg text-[11px] font-mono flex items-center gap-1.5 pointer-events-none shadow-xl">
                  <Eye className="w-3.5 h-3.5" />
                  <span>Click to expand & zoom</span>
                </div>
              </div>
            )}
          </div>

          {/* Footer Metadata & Model Explainer */}
          <div className="px-4 py-3 bg-slate-950 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-slate-400 text-[11px]">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-300">Architecture:</span>
              <span>{activeModelMeta.fullName}</span>
              <span className="text-slate-600">•</span>
              <span className="text-cyan-400 font-mono">{activeModelMeta.members} Members</span>
            </div>
            <div className="flex items-center gap-2">
              <span>Automatic rolling archive: 48 hours (8 cycles)</span>
            </div>
          </div>
        </div>

        {/* Informative Guidance & Reference Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 pt-2">
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-2.5">
            <div className="flex items-center gap-2 text-blue-400">
              <Layers className="w-4 h-4" />
              <h2 className="text-sm font-bold text-white tracking-tight">
                Probability & Landfall Bar
              </h2>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              The on-map sidebar summarizes the percentage of ensemble realizations making landfall in the Philippines archipelago, estimated lead-time timing in PHT, and potential intensity categories (TD, TS, TY, STY).
            </p>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-2.5">
            <div className="flex items-center gap-2 text-amber-400">
              <ShieldAlert className="w-4 h-4" />
              <h2 className="text-sm font-bold text-white tracking-tight">
                Experimental Guidance
              </h2>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              This system provides early exploratory guidance. For life-safety, disaster preparedness, and official cyclone classifications, always consult PAGASA, the Joint Typhoon Warning Center (JTWC), and local DRRMCs.
            </p>
          </div>
        </div>
      </main>

      {/* Fullscreen High-Resolution Lightbox / Modal */}
      {isFullscreen && imageUrl && (
        <div className="fixed inset-0 z-[3000] bg-slate-950/95 backdrop-blur-2xl flex flex-col justify-between">
          {/* Lightbox Toolbar */}
          <div className="px-4 py-3 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between text-xs z-30">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
              <span className="font-bold text-white">{cardTitle}</span>
              <span className="text-slate-400 font-mono hidden sm:inline">
                [{selectedDate} {selectedCycle}]
              </span>
            </div>

            {/* Zoom Controls */}
            <div className="flex items-center gap-1.5 sm:gap-2">
              <button
                onClick={() => applyZoom(zoomLevel - ZOOM_STEP)}
                disabled={zoomLevel <= MIN_ZOOM}
                className={`p-1.5 rounded-lg transition-colors ${
                  zoomLevel <= MIN_ZOOM
                    ? "bg-slate-900 text-slate-600 cursor-not-allowed"
                    : "bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white cursor-pointer"
                }`}
                title="Zoom Out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-xs font-mono text-slate-300 px-1 w-12 text-center">
                {Math.round(zoomLevel * 100)}%
              </span>
              <button
                onClick={() => applyZoom(zoomLevel + ZOOM_STEP)}
                disabled={zoomLevel >= MAX_ZOOM}
                className={`p-1.5 rounded-lg transition-colors ${
                  zoomLevel >= MAX_ZOOM
                    ? "bg-slate-900 text-slate-600 cursor-not-allowed"
                    : "bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white cursor-pointer"
                }`}
                title="Zoom In"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                onClick={() => applyZoom(MIN_ZOOM)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
                title="Reset Zoom"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              <div className="h-4 w-px bg-slate-700 mx-1"></div>

              {!imageError && (
                <a
                  href={imageUrl}
                  download={downloadFilename}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors flex items-center gap-1 text-xs"
                  title="Download PNG"
                >
                  <Download className="w-4 h-4" />
                </a>
              )}

              <button
                onClick={closeFullscreen}
                className="p-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 transition-colors cursor-pointer ml-1"
                title="Close Lightbox (ESC)"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Lightbox Interactive Canvas */}
          <div
            ref={lightboxCanvasRef}
            className={`relative flex-grow flex items-center justify-center p-2 overflow-hidden touch-none select-none ${
              zoomLevel > MIN_ZOOM ? "cursor-grab active:cursor-grabbing" : "cursor-default"
            }`}
            style={{ touchAction: "none" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
          >
            {imageError ? (
              <div className="flex flex-col items-center justify-center text-center p-6 max-w-sm bg-slate-900/90 border border-slate-800 rounded-2xl">
                <AlertCircle className="w-8 h-8 text-amber-400 mb-2" />
                <p className="text-sm font-bold text-white mb-1">
                  Plot Unavailable for {selectedCycle}
                </p>
                <p className="text-xs text-slate-400">
                  Select another cycle below or exit fullscreen.
                </p>
              </div>
            ) : (
              <img
                src={imageUrl}
                alt={lightboxAlt}
                onLoad={handleImageLoad}
                onError={handleImageError}
                style={{
                  transform: `scale(${zoomLevel}) translate(${panOffset.x / zoomLevel}px, ${
                    panOffset.y / zoomLevel
                  }px)`,
                  transition: isDragging ? "none" : "transform 0.12s ease-out"
                }}
                className="max-h-[88vh] max-w-full object-contain pointer-events-auto rounded shadow-2xl select-none"
                draggable={false}
              />
            )}
          </div>

          {/* Lightbox Cycle Quick Selector Bar */}
          <div className="px-4 py-3 bg-slate-900/90 border-t border-slate-800 flex items-center justify-between z-30">
            <span className="text-xs font-mono text-slate-400 hidden sm:inline">
              Use Left/Right arrow keys to switch cycles
            </span>
            <div className="flex items-center gap-2 mx-auto sm:mx-0">
              {CYCLE_OPTIONS.map((c) => {
                const hasData = availableCyclesForDate.has(c.code);
                const isSelected = hasData && selectedCycle === c.code;
                return (
                  <button
                    key={c.code}
                    disabled={!hasData}
                    onClick={() => {
                      if (hasData) onSelectCycle(c.code);
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-mono font-bold transition-all ${
                      isSelected
                        ? "bg-cyan-500 text-slate-950 ring-2 ring-cyan-300 cursor-pointer"
                        : hasData
                        ? "bg-slate-800 text-slate-300 hover:text-white cursor-pointer"
                        : "bg-slate-900 text-slate-600 opacity-40 cursor-not-allowed"
                    }`}
                  >
                    {c.label}Z
                  </button>
                );
              })}
            </div>
            <button
              onClick={closeFullscreen}
              className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium cursor-pointer"
            >
              Exit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
