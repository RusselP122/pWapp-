import React from "react";

export default function ExportOverlay({
    isExporting,
    exportTitle = "Exporting Map",
    exportStatusText,
    exportProgress,
}) {
    if (!isExporting) return null;

    return (
        <div className="export-loading-overlay">
            <div className="export-loading-card">
                <div className="export-loading-spinner-container">
                    <div className="export-loading-spinner-outer" />
                    <div className="export-loading-spinner-inner" />
                    <div className="export-loading-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                            />
                        </svg>
                    </div>
                </div>
                <h3 className="export-loading-title">{exportTitle}</h3>
                <p className="export-loading-status">
                    {exportStatusText || "Generating image..."}
                </p>
                {exportProgress > 0 && (
                    <div className="export-progress-container">
                        <div className="export-progress-bar-bg">
                            <div
                                className="export-progress-bar-fill"
                                style={{ width: `${Math.round(exportProgress * 100)}%` }}
                            />
                        </div>
                        <span className="export-progress-text">
                            {Math.round(exportProgress * 100)}% Complete
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}
