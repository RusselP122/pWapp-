import React from "react";
import {
    ResponsiveContainer,
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip as ChartTooltip,
    AreaChart,
    Area,
} from "recharts";
import {
    getDatasetConfig,
    formatCycleLabel,
    formatDisturbanceDisplayName,
} from "../../utils/spaghettiConfig";

const CYCLE_COLORS = ["#38bdf8", "#34d399", "#fbbf24", "#f87171"];

export default function TrendsPanel({
    dataset,
    loadingTrends,
    selectedTrendSystem,
    chartData,
    isTrendsCollapsed,
    setIsTrendsCollapsed,
    onClose,
}) {
    const totalEnsembleMembers = getDatasetConfig(dataset).totalMembers;

    const latestDetectedItem = selectedTrendSystem
        ? selectedTrendSystem.find((item) => item.disturbance !== null)
        : null;
    const latestDist = latestDetectedItem?.disturbance;

    return (
        <div className="trends-panel no-export">
            {loadingTrends ? (
                <div className="trends-loading-overlay">
                    <div className="map-spinner" />
                    <span className="map-loading-text">Loading multi-cycle trends...</span>
                </div>
            ) : selectedTrendSystem ? (
                <>
                    <div className="mean-details-header">
                        <div>
                            <h3
                                className="mean-details-title"
                                style={{
                                    fontSize: "14px",
                                    fontWeight: "800",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "6px",
                                }}
                            >
                                {latestDist ? (
                                    <>
                                        <span>{formatDisturbanceDisplayName(latestDist)}</span>
                                        <span style={{ fontSize: "12px", fontWeight: "normal", color: "#94a3b8" }}>
                                            ({latestDist.trackCount}/{totalEnsembleMembers})
                                        </span>
                                    </>
                                ) : (
                                    "Selected Storm"
                                )}
                            </h3>
                            <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                                Run-to-run forecast trends · Latest:{" "}
                                {selectedTrendSystem[0]
                                    ? formatCycleLabel(selectedTrendSystem[0].cycleTime)
                                    : "N/A"}
                            </span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <button
                                type="button"
                                className="mean-details-close-btn"
                                onClick={() => setIsTrendsCollapsed(!isTrendsCollapsed)}
                                title={isTrendsCollapsed ? "Expand charts" : "Collapse charts"}
                                style={{ padding: "4px" }}
                            >
                                {isTrendsCollapsed ? (
                                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                    </svg>
                                ) : (
                                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                                    </svg>
                                )}
                            </button>
                            <button
                                type="button"
                                className="mean-details-close-btn"
                                onClick={onClose}
                                title="Close trends"
                                style={{ padding: "4px" }}
                            >
                                <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>

                    {/* Color Legend for cycle tracks on the map */}
                    <div
                        style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "12px",
                            padding: "10px 14px",
                            background: "#ffffff",
                            border: "1px solid #cbd5e1",
                            borderRadius: "10px",
                            fontSize: "11px",
                            marginBottom: "6px",
                        }}
                    >
                        {selectedTrendSystem.map((item, index) => {
                            const isCurrent = item.cycleIndex === 0;
                            const dotColor = isCurrent
                                ? "#000000"
                                : CYCLE_COLORS[item.cycleIndex] || "#cbd5e1";
                            const dotBorder = isCurrent ? "1.5px solid #000000" : "none";
                            const shadowColor = isCurrent ? "rgba(0, 0, 0, 0.2)" : dotColor;
                            const label = formatCycleLabel(item.cycleTime);
                            const textColor = isCurrent
                                ? "#000000"
                                : item.disturbance
                                ? "#1e293b"
                                : "#64748b";
                            return (
                                <div key={item.cycleTime} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                                    <span
                                        style={{
                                            width: "8px",
                                            height: "8px",
                                            borderRadius: "50%",
                                            backgroundColor: dotColor,
                                            border: dotBorder,
                                            boxShadow: `0 0 4px ${shadowColor}`,
                                            boxSizing: "border-box",
                                        }}
                                    />
                                    <span style={{ color: textColor, fontWeight: item.disturbance ? 600 : 400 }}>
                                        {label}{" "}
                                        {item.disturbance
                                            ? `(${item.disturbance.trackCount}/${totalEnsembleMembers})`
                                            : "(N/A)"}
                                        {index === 0 && (
                                            <span
                                                style={{
                                                    color: "#000000",
                                                    fontSize: "9px",
                                                    fontWeight: "bold",
                                                    marginLeft: "4px",
                                                }}
                                            >
                                                [CURRENT]
                                            </span>
                                        )}
                                    </span>
                                </div>
                            );
                        })}
                    </div>

                    {!isTrendsCollapsed && (
                        <>
                            <div className="trend-chart-card">
                                <h4 className="trend-chart-title">Genesis Probability</h4>
                                <div style={{ width: "100%", height: "160px" }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart data={chartData} margin={{ top: 10, right: 15, left: 0, bottom: 0 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                                            <XAxis
                                                dataKey="name"
                                                tick={{ fill: "#94a3b8", fontSize: 10 }}
                                                stroke="rgba(255,255,255,0.1)"
                                            />
                                            <YAxis
                                                domain={[0, 100]}
                                                tick={{ fill: "#94a3b8", fontSize: 10 }}
                                                stroke="rgba(255,255,255,0.1)"
                                                width={35}
                                            />
                                            <ChartTooltip
                                                content={({ active, payload }) => {
                                                    if (!active || !payload || !payload.length) return null;
                                                    const data = payload[0].payload;
                                                    return (
                                                        <div
                                                            style={{
                                                                background: "rgba(15, 23, 42, 0.95)",
                                                                backdropFilter: "blur(8px)",
                                                                border: "1px solid rgba(255, 255, 255, 0.1)",
                                                                borderRadius: "8px",
                                                                padding: "8px 12px",
                                                                boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                                                            }}
                                                        >
                                                            <div style={{ fontSize: "11px", fontWeight: 700, color: "#94a3b8", marginBottom: "4px" }}>
                                                                {data.cycleTime}
                                                            </div>
                                                            {data.detected ? (
                                                                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                                    <div style={{ fontSize: "12px", fontWeight: 800, color: "#10b981" }}>
                                                                        Genesis Prob: {data.probability}% ({data.memberCount}/{data.totalMembers} members)
                                                                    </div>
                                                                    {data.formationDateStr && (
                                                                        <div style={{ color: "#fbbf24", fontSize: "11px", fontWeight: 600 }}>
                                                                            Genesis Est: {data.formationDateStr}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            ) : (
                                                                <div style={{ fontSize: "12px", color: "#ef4444", fontWeight: 600 }}>
                                                                    System not detected
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                }}
                                            />
                                            <Line
                                                type="monotone"
                                                dataKey="probability"
                                                stroke="#10b981"
                                                strokeWidth={2.5}
                                                dot={{ fill: "#10b981", r: 3 }}
                                                activeDot={{ r: 5 }}
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>

                            <div className="trend-chart-card">
                                <h4 className="trend-chart-title">Peak Wind Intensity (Spread)</h4>
                                <div style={{ width: "100%", height: "180px" }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <AreaChart data={chartData} margin={{ top: 10, right: 15, left: 10, bottom: 0 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                                            <XAxis
                                                dataKey="name"
                                                tick={{ fill: "#94a3b8", fontSize: 10 }}
                                                stroke="rgba(255,255,255,0.1)"
                                            />
                                            <YAxis
                                                domain={["auto", "auto"]}
                                                tick={{ fill: "#94a3b8", fontSize: 10 }}
                                                stroke="rgba(255,255,255,0.1)"
                                                unit=" km/h"
                                                width={55}
                                            />
                                            <ChartTooltip
                                                content={({ active, payload }) => {
                                                    if (!active || !payload || !payload.length) return null;
                                                    const data = payload[0].payload;
                                                    return (
                                                        <div
                                                            style={{
                                                                background: "rgba(15, 23, 42, 0.95)",
                                                                backdropFilter: "blur(8px)",
                                                                border: "1px solid rgba(255, 255, 255, 0.1)",
                                                                borderRadius: "8px",
                                                                padding: "8px 12px",
                                                                boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                                                            }}
                                                        >
                                                            <div style={{ fontSize: "11px", fontWeight: 700, color: "#94a3b8", marginBottom: "4px" }}>
                                                                {data.cycleTime}
                                                            </div>
                                                            {data.detected ? (
                                                                <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
                                                                    <div style={{ color: "#00d4ff", fontWeight: 700 }}>
                                                                        Ensemble Mean:{" "}
                                                                        {data.computedMeanWind ? `${data.computedMeanWind.toFixed(0)} km/h` : "N/A"}
                                                                    </div>
                                                                    {data.pairedWind && (
                                                                        <div style={{ color: "#ffffff", fontWeight: 700, display: "flex", alignItems: "center", gap: "4px" }}>
                                                                            <span style={{ width: "8px", height: "0px", borderTop: "2px dashed #ffffff", display: "inline-block" }} />
                                                                            Paired Track: {data.pairedWind.toFixed(0)} km/h
                                                                        </div>
                                                                    )}
                                                                    <div style={{ color: "#94a3b8", fontSize: "11px" }}>
                                                                        Median Peak: {data.medianWind ? `${data.medianWind.toFixed(0)} km/h` : "N/A"}
                                                                    </div>
                                                                    <div style={{ color: "rgba(255, 255, 255, 0.5)", fontSize: "11px" }}>
                                                                        Member Range:{" "}
                                                                        {data.minWind ? `${data.minWind.toFixed(0)} - ${data.maxWind.toFixed(0)} km/h` : "N/A"}
                                                                    </div>
                                                                </div>
                                                            ) : (
                                                                <div style={{ fontSize: "12px", color: "#ef4444", fontWeight: 600 }}>
                                                                    System not detected
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                }}
                                            />
                                            <Area type="monotone" dataKey="windRange" stroke="none" fill="rgba(0, 212, 255, 0.15)" />
                                            <Line
                                                type="monotone"
                                                dataKey="computedMeanWind"
                                                stroke="#00d4ff"
                                                name="Ensemble Mean"
                                                strokeWidth={2.5}
                                                dot={{ fill: "#00d4ff", r: 3 }}
                                                activeDot={{ r: 5 }}
                                            />
                                            <Line
                                                type="monotone"
                                                dataKey="pairedWind"
                                                stroke="#ffffff"
                                                name="Paired Track"
                                                strokeDasharray="4 4"
                                                strokeWidth={1.5}
                                                dot={{ fill: "#ffffff", r: 2 }}
                                                activeDot={{ r: 4 }}
                                            />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                        </>
                    )}
                </>
            ) : (
                <div className="trends-empty-state">
                    <svg
                        width="24"
                        height="24"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        style={{ marginBottom: "8px", opacity: 0.5, color: "#94a3b8" }}
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                        />
                    </svg>
                    <span>Select a system from the sidebar to view run-to-run trends</span>
                </div>
            )}
        </div>
    );
}
