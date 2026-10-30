// src/components/Cluster.jsx
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
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
  Info,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  Eye,
  Cpu,
  Compass,
  AlertCircle
} from "lucide-react";

// Asset URL helper to ensure compatibility in local dev and subpath production
const getAssetUrl = (path) => {
  if (!path) return "";
  const base = import.meta.env.BASE_URL || "/";
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  return `${base}${cleanPath}`;
};

// Cycle metadata and Philippine Standard Time conversion
const CYCLE_OPTIONS = [
  { code: "00Z", label: "00", pht: "08:00 AM PHT", hourUtc: 0 },
  { code: "06Z", label: "06", pht: "02:00 PM PHT", hourUtc: 6 },
  { code: "12Z", label: "12", pht: "08:00 PM PHT", hourUtc: 12 },
  { code: "18Z", label: "18", pht: "02:00 AM PHT", hourUtc: 18 }
];

const MODEL_CONFIGS = {
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
    name: "GDM WNC Large",
    fullName: "DeepMind Nazca Large Ensemble",
    members: 1000,
    badgeColor: "from-purple-500 to-indigo-600",
    borderGlow: "border-purple-500/40",
    desc: "Massive 1,000-member ensemble providing extreme-dispersion risk envelopes."
  }
};

const formatDateLabel = (ymdStr) => {
  if (!ymdStr || ymdStr.length !== 8) return ymdStr;
  const year = ymdStr.slice(0, 4);
  const month = parseInt(ymdStr.slice(4, 6), 10) - 1;
  const day = parseInt(ymdStr.slice(6, 8), 10);
  const dateObj = new Date(Date.UTC(year, month, day));

  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  return `${monthNames[month]} ${day}, ${year}`;
};

const formatClusterLabel = (dId, index = 0) => {
  if (!dId) return `Cluster ${String(index + 1).padStart(2, "0")}`;
  const match = dId.match(/\d+/);
  if (match) {
    return `Cluster ${match[0].padStart(2, "0")}`;
  }
  return `Cluster ${String(index + 1).padStart(2, "0")}`;
};

export default function Cluster() {
  const [manifestData, setManifestData] = useState([]);
  const [loadingManifest, setLoadingManifest] = useState(true);
  const [manifestError, setManifestError] = useState(null);

  // User selections
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedCycle, setSelectedCycle] = useState("18Z");
  const [selectedModel, setSelectedModel] = useState("gdm_wncv3");
  const [selectedDisturbance, setSelectedDisturbance] = useState("");

  // Lightbox / Zoom State
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  // Fetch Manifest
  const fetchManifest = useCallback(() => {
    setLoadingManifest(true);
    setManifestError(null);
    const url = getAssetUrl("data/spaghetti_manifest.json") + `?t=${Date.now()}`;

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setManifestData(Array.isArray(data) ? data : []);
        setLoadingManifest(false);
      })
      .catch((err) => {
        console.warn("Could not load spaghetti_manifest.json:", err);
        setManifestError(err.message);
        setLoadingManifest(false);
      });
  }, []);

  useEffect(() => {
    fetchManifest();
  }, [fetchManifest]);

  // Filter only Under-Monitoring / LPA cluster entries
  const monitoringEntries = useMemo(() => {
    return manifestData.filter((entry) => {
      if (!entry) return false;
      const isMon = Boolean(entry.is_monitoring);
      const stormId = (entry.storm_id || "").toUpperCase();
      return isMon || stormId.startsWith("MONITORING_") || stormId.startsWith("LPA");
    });
  }, [manifestData]);

  // Extract unique available dates in descending order (newest date first)
  const availableDates = useMemo(() => {
    const dates = Array.from(
      new Set(
        monitoringEntries
          .map((e) => e.init_date)
          .filter((d) => d && typeof d === "string" && d.length === 8)
      )
    ).sort((a, b) => b.localeCompare(a));

    if (dates.length === 0) {
      // Fallback to recent date if manifest is still loading or empty
      const today = new Date();
      const y = today.getUTCFullYear();
      const m = String(today.getUTCMonth() + 1).padStart(2, "0");
      const d = String(today.getUTCDate()).padStart(2, "0");
      return [`${y}${m}${d}`];
    }
    // Strictly cap to the latest 2 days (Option B)
    return dates.slice(0, 2);
  }, [monitoringEntries]);

  // Synchronize default selected date when manifest loads
  useEffect(() => {
    if (availableDates.length > 0 && (!selectedDate || !availableDates.includes(selectedDate))) {
      setSelectedDate(availableDates[0]);
    }
  }, [availableDates, selectedDate]);

  // Entries filtered by the chosen date
  const dateEntries = useMemo(() => {
    if (!selectedDate) return [];
    return monitoringEntries.filter((e) => e.init_date === selectedDate);
  }, [monitoringEntries, selectedDate]);

  // Cycles strictly available for the CURRENT selected date AND active model
  const availableCyclesForDate = useMemo(() => {
    const modelEntries = dateEntries.filter((e) => {
      return (
        e.model === selectedModel ||
        (selectedModel === "gdm_wncv3" && (e.model === "gdm_wnc" || e.model === "wncv3"))
      );
    });
    const targetEntries = modelEntries.length > 0 ? modelEntries : dateEntries;
    return new Set(targetEntries.map((e) => (e.cycle || "").toUpperCase()));
  }, [dateEntries, selectedModel]);

  // Core Requirement: "When new date come, the old cycle will disappear and new cycle appear"
  // If the user selects a new date whose available cycles do not contain the current cycle,
  // automatically transition to the latest available cycle for that date!
  useEffect(() => {
    if (availableCyclesForDate.size === 0) return;

    if (!availableCyclesForDate.has(selectedCycle)) {
      // Find latest valid cycle for this date
      const sortedCycles = ["18Z", "12Z", "06Z", "00Z"];
      const nextBest = sortedCycles.find((c) => availableCyclesForDate.has(c));
      if (nextBest) {
        setSelectedCycle(nextBest);
      }
    }
  }, [selectedDate, availableCyclesForDate, selectedCycle]);

  // Disturbance targets for selected date, cycle, AND active model
  // Ensures that if a cluster (e.g. Cluster 02) does not exist in another DeepMind model, it will not appear
  const disturbancesForCycle = useMemo(() => {
    const subset = dateEntries.filter((e) => {
      const matchCycle = (e.cycle || "").toUpperCase() === selectedCycle;
      const matchModel =
        e.model === selectedModel ||
        (selectedModel === "gdm_wncv3" && (e.model === "gdm_wnc" || e.model === "wncv3"));
      return matchCycle && matchModel;
    });
    const uniqueIds = Array.from(new Set(subset.map((e) => e.storm_id).filter(Boolean)));
    return uniqueIds.sort();
  }, [dateEntries, selectedCycle, selectedModel]);

  // Auto-select disturbance
  useEffect(() => {
    if (disturbancesForCycle.length > 0) {
      if (!selectedDisturbance || !disturbancesForCycle.includes(selectedDisturbance)) {
        setSelectedDisturbance(disturbancesForCycle[0]);
      }
    } else {
      setSelectedDisturbance("");
    }
  }, [disturbancesForCycle, selectedDisturbance]);

  // Models available for current selection
  const availableModelsForDisturbance = useMemo(() => {
    const subset = dateEntries.filter(
      (e) =>
        (e.cycle || "").toUpperCase() === selectedCycle &&
        (!selectedDisturbance || e.storm_id === selectedDisturbance)
    );
    const models = Array.from(new Set(subset.map((e) => e.model).filter(Boolean)));
    return models;
  }, [dateEntries, selectedCycle, selectedDisturbance]);

  // Active matched manifest entry
  const currentEntry = useMemo(() => {
    return dateEntries.find((e) => {
      const matchCycle = (e.cycle || "").toUpperCase() === selectedCycle;
      const matchModel =
        e.model === selectedModel ||
        (selectedModel === "gdm_wncv3" && (e.model === "gdm_wnc" || e.model === "wncv3"));
      const matchDist = !selectedDisturbance || e.storm_id === selectedDisturbance;
      return matchCycle && matchModel && matchDist;
    });
  }, [dateEntries, selectedCycle, selectedModel, selectedDisturbance]);

  // Construct active image URL
  const imageUrl = useMemo(() => {
    if (currentEntry && currentEntry.filename) {
      return getAssetUrl(`assets/${currentEntry.filename}`);
    }

    // Dynamic predicted filename fallback
    if (selectedDate && selectedCycle && selectedModel) {
      const distTag = selectedDisturbance || "MONITORING_LPA01";
      const cleanModel = selectedModel;
      return getAssetUrl(`assets/${distTag}_${selectedDate}_${selectedCycle}_${cleanModel}.png`);
    }

    return null;
  }, [currentEntry, selectedDate, selectedCycle, selectedModel, selectedDisturbance]);

  // Reset zoom on cycle or image change
  useEffect(() => {
    setImageLoading(true);
    setImageError(false);
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  }, [imageUrl]);

  // Handle Fullscreen toggle
  const toggleFullscreen = () => {
    setIsFullscreen((prev) => !prev);
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  };

  // Keyboard navigation for cycles and ESC
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setIsFullscreen(false);
      }
      if (e.key === "ArrowLeft") {
        const order = ["00Z", "06Z", "12Z", "18Z"];
        const curIdx = order.indexOf(selectedCycle);
        if (curIdx > 0 && availableCyclesForDate.has(order[curIdx - 1])) {
          setSelectedCycle(order[curIdx - 1]);
        }
      }
      if (e.key === "ArrowRight") {
        const order = ["00Z", "06Z", "12Z", "18Z"];
        const curIdx = order.indexOf(selectedCycle);
        if (curIdx < order.length - 1 && availableCyclesForDate.has(order[curIdx + 1])) {
          setSelectedCycle(order[curIdx + 1]);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedCycle]);

  // Touch & Gesture state refs
  const touchDistanceRef = useRef(null);
  const initialZoomRef = useRef(1);
  const lastTapRef = useRef(0);

  // Mouse pan handlers for zoom
  const handleMouseDown = (e) => {
    if (zoomLevel > 1) {
      e.preventDefault();
      setIsDragging(true);
      setDragStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
    }
  };

  const handleMouseMove = (e) => {
    if (isDragging && zoomLevel > 1) {
      e.preventDefault();
      setPanOffset({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Touch pan & pinch-to-zoom handlers (Mobile, iPad, Android, iPhone)
  const handleTouchStart = (e) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      if (zoomLevel > 1) {
        setIsDragging(true);
        setDragStart({ x: touch.clientX - panOffset.x, y: touch.clientY - panOffset.y });
      }

      // Double-tap to toggle zoom (1x <-> 2x)
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        if (zoomLevel > 1) {
          setZoomLevel(1);
          setPanOffset({ x: 0, y: 0 });
        } else {
          setZoomLevel(2.2);
        }
      }
      lastTapRef.current = now;
    } else if (e.touches.length === 2) {
      setIsDragging(false);
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      touchDistanceRef.current = dist;
      initialZoomRef.current = zoomLevel;
    }
  };

  const handleTouchMove = (e) => {
    if (e.touches.length === 1 && isDragging && zoomLevel > 1) {
      const touch = e.touches[0];
      setPanOffset({
        x: touch.clientX - dragStart.x,
        y: touch.clientY - dragStart.y
      });
    } else if (e.touches.length === 2 && touchDistanceRef.current !== null) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const currentDist = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      const ratio = currentDist / touchDistanceRef.current;
      const newZoom = Math.min(3.5, Math.max(1, initialZoomRef.current * ratio));
      setZoomLevel(newZoom);
      if (newZoom <= 1) {
        setPanOffset({ x: 0, y: 0 });
      }
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

  // Wheel zoom handler
  const handleWheel = (e) => {
    e.preventDefault();
    const nextZoom = e.deltaY < 0 ? zoomLevel + 0.25 : zoomLevel - 0.25;
    const clamped = Math.min(3.5, Math.max(1, nextZoom));
    setZoomLevel(clamped);
    if (clamped <= 1) {
      setPanOffset({ x: 0, y: 0 });
    }
  };

  const disturbanceDisplayName = useMemo(() => {
    if (!selectedDisturbance) return "Cluster 01";
    return formatClusterLabel(selectedDisturbance);
  }, [selectedDisturbance]);

  const activeModelMeta = MODEL_CONFIGS[selectedModel] || MODEL_CONFIGS.gdm_wncv3;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased selection:bg-cyan-500 selection:text-white">
      {/* Broadcast Header Ambient Glow */}
      <div className="relative overflow-hidden border-b border-slate-800/80 bg-gradient-to-b from-slate-900/90 via-slate-950 to-slate-950">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none animate-pulse"></div>
        <div className="absolute top-0 right-1/4 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none"></div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              {/* Badge */}
              <div className="inline-flex items-center gap-2 px-3 py-1 mb-2.5 rounded-full bg-cyan-950/70 border border-cyan-500/40 text-cyan-300 text-xs font-mono font-semibold tracking-wider uppercase shadow-inner shadow-cyan-950/50">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400"></span>
                </span>
                AI Ensemble Cluster Tracking
              </div>

              {/* Title */}
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight text-white flex items-center gap-2.5">
                Cluster
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-sky-400">
                  Monitoring
                </span>
              </h1>

              {/* Subtitle */}
              <p className="mt-1.5 text-xs sm:text-sm text-slate-400 max-w-3xl leading-relaxed">
                Autonomous trajectory clustering resolving under-monitoring circulation envelopes,
                cyclogenesis density signals, and potential low pressure area developments before official naming.
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
                {availableDates.map((dateStr, idx) => {
                  const isSelected = selectedDate === dateStr;
                  const isLatest = idx === 0;
                  return (
                    <button
                      key={dateStr}
                      onClick={() => setSelectedDate(dateStr)}
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
                })}
              </div>
            </div>

            {/* 2. Model Selector Switcher */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1.5 font-semibold">
                <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                DeepMind AI Model
              </label>
              <div className="grid grid-cols-2 gap-2 bg-slate-950/80 p-1 rounded-xl border border-slate-800">
                {Object.values(MODEL_CONFIGS).map((m) => {
                  const isSelected = selectedModel === m.id;
                  const isAvailable = availableModelsForDisturbance.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      onClick={() => setSelectedModel(m.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer ${
                        isSelected
                          ? `bg-gradient-to-r ${m.badgeColor} text-white shadow-md`
                          : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
                      }`}
                      title={m.desc}
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

          {/* Core Feature Row: Cycle Selector Buttons (00, 06, 12, 18) */}
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

              {/* Cycle Grid: Responsive across mobile, tablet, and desktop */}
              <div className="grid grid-cols-4 gap-2 sm:gap-3 max-w-xl">
                {CYCLE_OPTIONS.map((c) => {
                  const isSelected = selectedCycle === c.code;
                  const hasData = availableCyclesForDate.has(c.code);

                  return (
                    <button
                      key={c.code}
                      disabled={!hasData}
                      onClick={() => {
                        if (hasData) setSelectedCycle(c.code);
                      }}
                      className={`relative flex flex-col items-center justify-center py-2.5 px-2 rounded-xl transition-all duration-200 border ${
                        isSelected
                          ? "bg-cyan-500 text-slate-950 border-cyan-400 shadow-lg shadow-cyan-500/25 scale-[1.02] cursor-pointer"
                          : hasData
                          ? "bg-slate-800/80 hover:bg-slate-800 text-white border-slate-700/80 hover:border-slate-600 cursor-pointer"
                          : "bg-slate-950/40 text-slate-600 border-slate-900/60 opacity-40 cursor-not-allowed select-none"
                      }`}
                      title={hasData ? `Cycle ${c.code} (${c.pht})` : `No new forecast data available for ${c.code}`}
                    >
                      {/* Cycle Number (Big & Clear) */}
                      <div className="flex items-center gap-0.5">
                        <span className={`text-base sm:text-lg font-black tracking-tight font-mono ${!hasData ? "text-slate-600" : ""}`}>
                          {c.label}
                        </span>
                        <span className={`text-[10px] font-bold ${!hasData ? "text-slate-600" : "opacity-80"}`}>Z</span>
                      </div>

                      {/* Philippine Time Indicator */}
                      <span
                        className={`text-[9px] font-mono leading-tight tracking-tight mt-0.5 whitespace-nowrap ${
                          isSelected ? "text-slate-950 font-bold" : hasData ? "text-slate-400" : "text-slate-600"
                        }`}
                      >
                        {c.pht.split(" ")[0]} {c.pht.split(" ")[1]}
                      </span>

                      {/* Status indicator dot */}
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

            {/* Disturbance / System Selector (if at least one disturbance exists for the model) */}
            {disturbancesForCycle.length > 0 && (
              <div className="flex flex-col gap-1.5 self-start sm:self-end">
                <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400 font-semibold">
                  Detected Systems ({disturbancesForCycle.length})
                </span>
                <div className="flex items-center gap-1.5 bg-slate-950/80 p-1 rounded-xl border border-slate-800">
                  {disturbancesForCycle.map((dId, idx) => {
                    const isSelected = selectedDisturbance === dId;
                    const label = formatClusterLabel(dId, idx);
                    return (
                      <button
                        key={dId}
                        onClick={() => setSelectedDisturbance(dId)}
                        className={`px-3 py-1 rounded-lg text-xs font-bold font-mono transition-colors cursor-pointer ${
                          isSelected
                            ? "bg-cyan-500 text-slate-950 shadow-sm"
                            : "text-slate-400 hover:text-white hover:bg-slate-900"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Display Canvas & Map Card */}
        <div className="relative bg-slate-900/90 border border-slate-800/80 rounded-2xl overflow-hidden shadow-2xl backdrop-blur-md">
          
          {/* Card Top Information Bar */}
          <div className="px-4 py-3 bg-slate-900 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse"></span>
              <span className="font-bold text-white tracking-wide">
                {activeModelMeta.name} • {disturbanceDisplayName}
              </span>
              <span className="text-slate-400 font-mono">
                [INIT: {formatDateLabel(selectedDate)} {selectedCycle}]
              </span>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-2">

              {imageUrl && (
                <a
                  href={imageUrl}
                  download={`CLUSTER_${disturbanceDisplayName}_${selectedDate}_${selectedCycle}.png`}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors flex items-center gap-1.5 text-xs font-mono"
                  title="Download High-Resolution Plot"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Save Image</span>
                </a>
              )}

              <button
                onClick={toggleFullscreen}
                className="px-3 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/30 transition-all flex items-center gap-1.5 text-xs font-semibold cursor-pointer shadow-sm"
              >
                <Maximize2 className="w-3.5 h-3.5" />
                <span>Fullscreen</span>
              </button>
            </div>
          </div>

          {/* Interactive Image Viewing Stage */}
          <div
            className="relative w-full bg-slate-950/80 flex items-center justify-center p-2 sm:p-4 min-h-[460px] sm:min-h-[580px] lg:min-h-[680px] overflow-hidden select-none cursor-pointer"
            onClick={toggleFullscreen}
          >
            {/* Loading Spinner */}
            {imageLoading && !imageError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 z-20 gap-3">
                <div className="relative flex items-center justify-center w-14 h-14">
                  <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20 animate-ping"></div>
                  <div className="absolute inset-1 rounded-full border-2 border-dashed border-cyan-400 animate-spin [animation-duration:3s]"></div>
                  <Compass className="w-6 h-6 text-cyan-400 animate-pulse" />
                </div>
                <div className="text-center">
                  <p className="text-xs font-mono uppercase tracking-wider text-slate-200 font-semibold">
                    Loading Cluster Guidance Map...
                  </p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Rendering {selectedModel.toUpperCase()} {selectedCycle} forecast tracks
                  </p>
                </div>
              </div>
            )}

            {/* Error or Missing Image State */}
            {imageError && (
              <div className="flex flex-col items-center justify-center text-center p-8 max-w-md mx-auto my-12 bg-slate-900/60 border border-slate-800 rounded-2xl">
                <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-3">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <h3 className="text-sm font-bold text-white mb-1">
                  Plot Generating or Unavailable for {selectedCycle}
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                  The under-monitoring spaghetti plot for cycle <span className="font-mono text-cyan-300 font-bold">{selectedCycle}</span> on <span className="font-mono text-cyan-300 font-bold">{formatDateLabel(selectedDate)}</span> may still be generating or was filtered if no significant disturbance met monitoring thresholds.
                </p>
                <div className="flex items-center gap-2">
                  {Array.from(availableCyclesForDate).map((altCycle) => (
                    <button
                      key={altCycle}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedCycle(altCycle);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold transition-all cursor-pointer"
                    >
                      View {altCycle}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Rendered Map Graphic */}
            {imageUrl && !imageError && (
              <div className="relative group max-w-full">
                <img
                  src={imageUrl}
                  alt={`AI Cluster Forecast Track - ${disturbanceDisplayName} - ${selectedDate} ${selectedCycle}`}
                  onLoad={() => setImageLoading(false)}
                  onError={() => {
                    setImageLoading(false);
                    setImageError(true);
                  }}
                  className={`w-auto h-auto max-w-full max-h-[82vh] object-contain rounded-xl shadow-2xl transition-all duration-300 ${
                    imageLoading ? "opacity-0" : "opacity-100 group-hover:scale-[1.008]"
                  }`}
                />
                
                {/* Hover overlay hint */}
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
          {/* Card 1: Interpreting Confidence & Landfall */}
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

          {/* Card 3: Advisory Disclaimer */}
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
              <span className="font-bold text-white">
                {activeModelMeta.name} • {disturbanceDisplayName}
              </span>
              <span className="text-slate-400 font-mono hidden sm:inline">
                [{selectedDate} {selectedCycle}]
              </span>
            </div>

            {/* Zoom Controls */}
            <div className="flex items-center gap-1.5 sm:gap-2">
              <button
                onClick={() => setZoomLevel((z) => Math.max(0.6, z - 0.25))}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
                title="Zoom Out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-xs font-mono text-slate-300 px-1 w-12 text-center">
                {Math.round(zoomLevel * 100)}%
              </span>
              <button
                onClick={() => setZoomLevel((z) => Math.min(3.5, z + 0.25))}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
                title="Zoom In"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  setZoomLevel(1);
                  setPanOffset({ x: 0, y: 0 });
                }}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
                title="Reset Zoom"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              <div className="h-4 w-px bg-slate-700 mx-1"></div>

              <a
                href={imageUrl}
                download={`CLUSTER_${disturbanceDisplayName}_${selectedDate}_${selectedCycle}.png`}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors flex items-center gap-1 text-xs"
                title="Download PNG"
              >
                <Download className="w-4 h-4" />
              </a>

              <button
                onClick={toggleFullscreen}
                className="p-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 transition-colors cursor-pointer ml-1"
                title="Close Lightbox (ESC)"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Lightbox Interactive Canvas with Touch Drag & Pinch */}
          <div
            className={`relative flex-grow flex items-center justify-center p-2 overflow-hidden touch-none select-none ${
              zoomLevel > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-default"
            }`}
            style={{ touchAction: "none" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            onWheel={handleWheel}
          >
            <img
              src={imageUrl}
              alt="Cluster High Resolution"
              style={{
                transform: `scale(${zoomLevel}) translate(${panOffset.x / zoomLevel}px, ${
                  panOffset.y / zoomLevel
                }px)`,
                transition: isDragging ? "none" : "transform 0.12s ease-out"
              }}
              className="max-h-[88vh] max-w-full object-contain pointer-events-auto rounded shadow-2xl select-none"
              draggable={false}
            />
          </div>

          {/* Lightbox Cycle Quick Selector Bar */}
          <div className="px-4 py-3 bg-slate-900/90 border-t border-slate-800 flex items-center justify-between z-30">
            <span className="text-xs font-mono text-slate-400 hidden sm:inline">
              Use Left/Right arrow keys to switch cycles
            </span>
            <div className="flex items-center gap-2 mx-auto sm:mx-0">
              {CYCLE_OPTIONS.map((c) => {
                const isSelected = selectedCycle === c.code;
                const hasData = availableCyclesForDate.has(c.code);
                return (
                  <button
                    key={c.code}
                    onClick={() => setSelectedCycle(c.code)}
                    className={`px-3 py-1 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer ${
                      isSelected
                        ? "bg-cyan-500 text-slate-950 ring-2 ring-cyan-300"
                        : hasData
                        ? "bg-slate-800 text-slate-300 hover:text-white"
                        : "bg-slate-900 text-slate-600"
                    }`}
                  >
                    {c.label}Z
                  </button>
                );
              })}
            </div>
            <button
              onClick={toggleFullscreen}
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
