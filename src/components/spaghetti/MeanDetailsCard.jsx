import React from "react";
import { windColor, formatManilaShortDateTime } from "../../utils/spaghettiConfig";

export default function MeanDetailsCard({
    selectedMeanPoint,
    disturbances,
    runInitDate,
    onSelectPoint,
    onClose,
    onZoom,
}) {
    if (!selectedMeanPoint) return null;

    const meanTrackObj = disturbances.find((m) => m.id === selectedMeanPoint.distId);
    const pts = meanTrackObj?.meanPoints || [];
    const activeIndex = pts.findIndex((pt) => pt.h === selectedMeanPoint.h);

    let selectedPts = [];
    if (activeIndex !== -1) {
        let windowPts;
        if (pts.length <= 5) {
            windowPts = [...pts];
        } else {
            let start = activeIndex - 2;
            let end = activeIndex + 2;
            if (start < 0) {
                end -= start;
                start = 0;
            }
            if (end >= pts.length) {
                start -= end - pts.length + 1;
                end = pts.length - 1;
            }
            start = Math.max(0, start);
            windowPts = pts.slice(start, end + 1);
        }
        selectedPts = [...windowPts].reverse();
    }

    const initDateMs =
        runInitDate && !isNaN(runInitDate.getTime()) ? runInitDate.getTime() : null;

    const hasPrev = activeIndex > 0;
    const hasNext = activeIndex !== -1 && activeIndex < pts.length - 1;

    const agreementPct =
        selectedMeanPoint.stepAgreementPct ??
        (selectedMeanPoint.totalMembers > 0
            ? Math.round((selectedMeanPoint.activeMembers / selectedMeanPoint.totalMembers) * 100)
            : 0);
    const rating = agreementPct >= 70 ? "HIGH" : agreementPct >= 40 ? "MEDIUM" : "LOW";
    const ratingColor =
        agreementPct >= 70 ? "#10b981" : agreementPct >= 40 ? "#f59e0b" : "#ef4444";

    return (
        <div className="mean-details-card no-export">
            <div className="mean-details-header">
                <div>
                    <h3 className="mean-details-title">{selectedMeanPoint.displayName}</h3>
                    {initDateMs && (
                        <div style={{ fontSize: "10px", color: "#94a3b8", marginTop: "2px" }}>
                            Model Run:{" "}
                            {runInitDate.toISOString().replace("T", " ").substring(0, 16).replace(/-/g, "/")}{" "}
                            UTC ({formatManilaShortDateTime(initDateMs, 0).time} PHT)
                        </div>
                    )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <button
                        type="button"
                        className="mean-details-close-btn"
                        disabled={!hasPrev}
                        onClick={() =>
                            hasPrev &&
                            onSelectPoint(pts[activeIndex - 1], selectedMeanPoint.distId, selectedMeanPoint.region)
                        }
                        title="Previous time step"
                        aria-label="Previous forecast hour"
                    >
                        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        className="mean-details-close-btn"
                        disabled={!hasNext}
                        onClick={() =>
                            hasNext &&
                            onSelectPoint(pts[activeIndex + 1], selectedMeanPoint.distId, selectedMeanPoint.region)
                        }
                        title="Next time step"
                        aria-label="Next forecast hour"
                    >
                        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        className="mean-details-close-btn"
                        onClick={onClose}
                        title="Close details"
                        aria-label="Close mean point details"
                    >
                        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            </div>

            {selectedPts.length > 0 && (
                <div className="mean-details-table-wrap">
                    <table className="mean-details-table">
                        <thead>
                            <tr>
                                <th>
                                    DATE <span className="sub-th">UTC+8</span>
                                </th>
                                <th>TIME</th>
                                <th>
                                    WIND <span className="sub-th">km/h</span>
                                </th>
                                <th>
                                    PRESSURE <span className="sub-th">hPa</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {selectedPts.map((pt) => {
                                const isActive = pt.h === selectedMeanPoint.h;
                                const { date, time } = formatManilaShortDateTime(initDateMs, pt.h);
                                return (
                                    <tr
                                        key={pt.h}
                                        className={isActive ? "active-row" : ""}
                                        tabIndex={0}
                                        onClick={() =>
                                            onSelectPoint(pt, selectedMeanPoint.distId, selectedMeanPoint.region)
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" || e.key === " ") {
                                                e.preventDefault();
                                                onSelectPoint(pt, selectedMeanPoint.distId, selectedMeanPoint.region);
                                            }
                                        }}
                                        style={{ cursor: "pointer" }}
                                    >
                                        <td>{date}</td>
                                        <td>{time}</td>
                                        <td style={{ color: windColor(pt.windKmh), fontWeight: "bold" }}>
                                            {isNaN(pt.windKmh) ? "–" : pt.windKmh.toFixed(0)}
                                        </td>
                                        <td style={{ color: "#38bdf8" }}>
                                            {isNaN(pt.p) ? "–" : pt.p.toFixed(0)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="mean-details-footer">
                <div className="mean-details-chance-badge">
                    <span className="badge-pill" style={{ backgroundColor: ratingColor }}>
                        {rating}
                    </span>
                    <span className="badge-label">
                        {agreementPct}% within 2° · {selectedMeanPoint.activeMembers}/
                        {selectedMeanPoint.totalMembers} active
                    </span>
                </div>
                <button
                    type="button"
                    className="mean-details-info-btn"
                    onClick={onZoom}
                    title="Center map on coordinates"
                >
                    Zoom &gt;
                </button>
            </div>
        </div>
    );
}
