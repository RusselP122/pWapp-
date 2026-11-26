import React from "react";

export default function AnimationControls({
    animHour,
    maxAnimHour,
    runInitDate,
    isPlaying,
    isExporting,
    exportProgress,
    onTogglePlay,
    onChangeHour,
    onExportGif,
}) {
    return (
        <div className="animation-controls-card">
            <div className="flex justify-between items-center mb-3">
                <div className="flex flex-col">
                    <span className="text-sm font-bold text-cyan-400">Hour: +{animHour}</span>
                    <span className="text-[11px] text-slate-300 font-mono mt-0.5">
                        {runInitDate
                            ? `${new Date(runInitDate.getTime() + animHour * 3600000)
                                  .toISOString()
                                  .replace("T", " ")
                                  .substring(0, 19)} UTC`
                            : "Loading..."}
                    </span>
                </div>
                <button
                    type="button"
                    onClick={onTogglePlay}
                    style={{
                        background: isPlaying ? "rgba(239, 68, 68, 0.2)" : "rgba(16, 185, 129, 0.2)",
                        border: `1px solid ${
                            isPlaying ? "rgba(239, 68, 68, 0.5)" : "rgba(16, 185, 129, 0.5)"
                        }`,
                        color: isPlaying ? "#fca5a5" : "#6ee7b7",
                        padding: "4px 12px",
                        borderRadius: "4px",
                        fontSize: "12px",
                        fontWeight: "bold",
                        cursor: "pointer",
                        transition: "all 0.2s",
                    }}
                >
                    {isPlaying ? "⏸ Pause" : animHour >= maxAnimHour ? "🔄 Restart" : "▶ Play"}
                </button>
            </div>
            <input
                type="range"
                min="0"
                max={maxAnimHour}
                step="6"
                value={animHour}
                onChange={(e) => onChangeHour(parseInt(e.target.value, 10))}
                style={{ width: "100%", accentColor: "#00d4ff", cursor: "pointer", marginBottom: "12px" }}
                aria-label="Forecast animation hour"
            />

            <button
                type="button"
                onClick={onExportGif}
                disabled={isExporting}
                style={{
                    width: "100%",
                    background: isExporting ? "rgba(100, 116, 139, 0.5)" : "rgba(14, 165, 233, 0.2)",
                    border: `1px solid ${
                        isExporting ? "rgba(100, 116, 139, 0.5)" : "rgba(14, 165, 233, 0.5)"
                    }`,
                    color: isExporting ? "#cbd5e1" : "#7dd3fc",
                    padding: "8px",
                    borderRadius: "4px",
                    fontSize: "12px",
                    fontWeight: "bold",
                    cursor: isExporting ? "not-allowed" : "pointer",
                    transition: "all 0.2s",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                }}
            >
                {isExporting ? (
                    <>
                        <div className="spinner" style={{ width: "12px", height: "12px", borderTopColor: "#fff" }} />
                        <span>Exporting... {Math.round(exportProgress * 100)}%</span>
                    </>
                ) : (
                    <>
                        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        <span>Export as GIF</span>
                    </>
                )}
            </button>

            {isExporting && (
                <div style={{ marginTop: "8px", height: "4px", background: "rgba(0,0,0,0.5)", borderRadius: "2px", overflow: "hidden" }}>
                    <div
                        style={{
                            height: "100%",
                            width: `${exportProgress * 100}%`,
                            background: "#00d4ff",
                            transition: "width 0.2s ease-out",
                        }}
                    />
                </div>
            )}
        </div>
    );
}
