import React from "react";
import { WIND_LEGEND, formatDisturbanceDisplayName } from "../../utils/spaghettiConfig";

export default function DisturbanceCard({
    disturbance: d,
    isActive,
    isMeanOnly,
    onSelect,
    onToggleMeanOnly,
    onFocusSystem,
}) {
    const displayName = formatDisturbanceDisplayName(d);
    const showIdSubtitle = displayName !== `Disturbance ${d.id}`;

    const handleKeyDown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(d);
        }
    };

    return (
        <div
            role="button"
            tabIndex={0}
            aria-pressed={isActive}
            onClick={() => onSelect(d)}
            onKeyDown={handleKeyDown}
            className={`system-card ${isActive ? "active" : ""}`}
        >
            <div className="system-card-header">
                <div className="system-card-title-wrap">
                    <div className="system-dot-wrap">
                        <span className="system-dot-ping" style={{ background: d.peakColor }} />
                        <span className="system-dot" style={{ background: d.peakColor }} />
                    </div>
                    <div className="system-title-col">
                        <span className="system-title">{displayName}</span>
                        {showIdSubtitle && (
                            <span className="system-subtitle-id">System #{d.id}</span>
                        )}
                    </div>
                </div>
                <div className="system-card-actions">
                    <span className="system-track-count">{d.trackCount} trks</span>
                    {onFocusSystem && (
                        <button
                            type="button"
                            className="system-focus-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                onFocusSystem(d);
                            }}
                            title="Zoom map to this system"
                            aria-label={`Zoom map to ${displayName}`}
                        >
                            <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-4.553M19.553 5.447V9m0-3.553H16M9 14l-4.553 4.553M4.447 18.553V15m0 3.553H8M15 14l4.553 4.553m0 0V15m0 3.553H16M9 10L4.447 5.447m0 0V9m0-3.553H8" />
                            </svg>
                        </button>
                    )}
                    {d.hasEnsembleMean && (
                        <button
                            type="button"
                            className={`system-view-toggle ${isMeanOnly ? "mean-only" : ""}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleMeanOnly(d.id);
                            }}
                            title={isMeanOnly ? "Show spaghetti tracks" : "Show mean only"}
                        >
                            {isMeanOnly ? "MEAN" : "ALL"}
                        </button>
                    )}
                </div>
            </div>

            <div className="system-details">
                <div className="system-detail-row">
                    <span>First Expected (PHT):</span>
                    <span className="system-detail-value">{d.formationDateStr}</span>
                </div>
                <div className="system-detail-row">
                    <span>{d.region}</span>
                    <span className="system-detail-value">
                        {d.lat.toFixed(1)}°N, {d.lon.toFixed(1)}°E
                    </span>
                </div>
                <div className="system-detail-row system-detail-divider">
                    <span>Peak Wind:</span>
                    <span className="system-peak-value" style={{ color: d.peakColor }}>
                        {d.peakW > 0 ? `${d.peakW.toFixed(0)} km/h` : "N/A"}
                    </span>
                </div>

                {d.highIntensityUncertainty && (
                    <div className="system-ri-warning">
                        ⚠️ High Intensity Uncertainty (RI Risk)
                    </div>
                )}

                {d.hasEnsembleMean && (
                    <>
                        <div className="system-detail-row">
                            <span>Confidence:</span>
                            <span
                                className="system-detail-value"
                                style={{
                                    color:
                                        d.agreement >= 70
                                            ? "#10b981"
                                            : d.agreement >= 40
                                            ? "#f59e0b"
                                            : "#ef4444",
                                    fontWeight: "bold",
                                    textTransform: "uppercase",
                                    fontSize: "0.85em",
                                    letterSpacing: "0.05em",
                                }}
                            >
                                {d.agreement >= 70 ? "High" : d.agreement >= 40 ? "Medium" : "Low"}
                            </span>
                        </div>
                        <div className="system-detail-row">
                            <span>Track Agreement (≤2°):</span>
                            <span className="system-detail-value">{d.agreement}%</span>
                        </div>
                        <div className="system-detail-row">
                            <span>Spread (1σ):</span>
                            <span className="system-detail-value">{d.spreadKm} km</span>
                        </div>
                    </>
                )}

                {d.catCounts && Object.keys(d.catCounts).length > 0 && (
                    <div className="system-intensity-breakdown">
                        {WIND_LEGEND.map(({ label, category, color }) => {
                            const count = d.catCounts[category] || 0;
                            if (count === 0) return null;
                            return (
                                <div key={label} className="intensity-row">
                                    <span
                                        className="intensity-dot"
                                        style={{ background: color, boxShadow: `0 0 6px ${color}60` }}
                                    />
                                    <span className="intensity-cat">{category}</span>
                                    <span className="intensity-bar-wrap">
                                        <span
                                            className="intensity-bar"
                                            style={{
                                                width: `${Math.min(100, (count / d.trackCount) * 100)}%`,
                                                background: color,
                                            }}
                                        />
                                    </span>
                                    <span className="intensity-count">{count}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
