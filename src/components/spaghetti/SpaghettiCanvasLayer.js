import L from "leaflet";
import { windColor } from "../../utils/spaghettiConfig.js";
import { splitAntimeridianSegment } from "../../utils/spaghettiAnalysis.js";

/**
 * High-performance Leaflet Renderer subclass for rendering hundreds to thousands
 * of ensemble spaghetti tracks, plot dots, and time-step animations.
 * Inherits Leaflet's native L.Renderer transform/zoom/flyTo lifecycle so tracks stay
 * pixel-locked to map tiles and boundaries across every pan, flyTo, fitBounds, and resize.
 */
const SpaghettiRenderer = L.Renderer.extend({
    options: {
        padding: 0.25,
    },

    initialize(options) {
        L.Renderer.prototype.initialize.call(this, options);
        this._tracks = [];
        this._state = {
            mode: "tracker", // "tracker" | "filter" | "animation" | "trends"
            animHour: 0,
            activeDisturbanceId: null,
            meanOnlyIds: new Set(),
            filteredTrackIds: null,
            showPlotPoints: true,
        };
        this._rafId = null;
    },

    getEvents() {
        const events = L.Renderer.prototype.getEvents.call(this);
        events.resize = this._update;
        return events;
    },

    _initContainer() {
        const container = (this._container = document.createElement("canvas"));
        container.style.pointerEvents = "none";
        this._ctx = container.getContext("2d");
    },

    _destroyContainer() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        delete this._ctx;
        L.DomUtil.remove(this._container);
        delete this._container;
    },

    _updatePaths() {
        // Tracks are drawn directly in _update() instead of individual Path layers
    },

    _reset() {
        L.Renderer.prototype._reset.call(this);
    },

    _update() {
        if (!this._map) return;
        if (this._map._animatingZoom && this._bounds) {
            return;
        }

        L.Renderer.prototype._update.call(this);

        const b = this._bounds;
        const container = this._container;
        const ctx = this._ctx;
        if (!b || !container || !ctx) return;

        const size = b.getSize();
        if (size.x <= 0 || size.y <= 0) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        L.DomUtil.setPosition(container, b.min);

        const targetW = Math.round(dpr * size.x);
        const targetH = Math.round(dpr * size.y);
        if (container.width !== targetW || container.height !== targetH) {
            container.width = targetW;
            container.height = targetH;
            container.style.width = `${size.x}px`;
            container.style.height = `${size.y}px`;
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, targetW, targetH);
        ctx.setTransform(dpr, 0, 0, dpr, -b.min.x * dpr, -b.min.y * dpr);

        this._redrawTracks();
    },

    setTracks(allTracks, trackDistIds) {
        const prepared = [];
        for (let trackIndex = 0; trackIndex < allTracks.length; trackIndex++) {
            const points = allTracks[trackIndex];
            if (!points || points.length < 2) continue;

            const distId = trackDistIds ? trackDistIds[trackIndex] : null;
            let minLat = 90;
            let maxLat = -90;
            let minLon = 180;
            let maxLon = -180;
            let crossesDateline = false;

            const preparedPts = [];
            for (const pt of points) {
                if (pt.lat < minLat) minLat = pt.lat;
                if (pt.lat > maxLat) maxLat = pt.lat;
                if (pt.lon < minLon) minLon = pt.lon;
                if (pt.lon > maxLon) maxLon = pt.lon;
                preparedPts.push({
                    lat: pt.lat,
                    lon: pt.lon,
                    h: pt.h,
                    color: windColor(pt.windKmh),
                });
            }

            const segments = [];
            for (let i = 1; i < points.length; i++) {
                const p1 = points[i - 1];
                const p2 = points[i];
                const segColor = windColor(p2.windKmh);
                const splitParts = splitAntimeridianSegment(p1, p2);
                if (splitParts.length > 1) crossesDateline = true;
                for (const [s1, s2] of splitParts) {
                    segments.push({
                        lat1: s1.lat,
                        lon1: s1.lon,
                        lat2: s2.lat,
                        lon2: s2.lon,
                        h2: p2.h,
                        color: segColor,
                    });
                }
            }

            prepared.push({
                trackIndex,
                distId,
                maxH: points[points.length - 1].h,
                minLat,
                maxLat,
                minLon,
                maxLon,
                crossesDateline,
                points: preparedPts,
                segments,
            });
        }

        this._tracks = prepared;
        this._scheduleDraw();
    },

    setRenderState(partialState) {
        this._state = { ...this._state, ...partialState };
        this._scheduleDraw();
    },

    redrawSync() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        this._update();
    },

    _scheduleDraw() {
        if (!this._map || this._rafId !== null) return;
        this._rafId = requestAnimationFrame(() => {
            this._rafId = null;
            this._update();
        });
    },

    _getStyleMetrics(map, activeCount) {
        const zoom = map.getZoom();
        const size = map.getSize();
        const compact = size.x < 640 ? 0.85 : 1.0;

        const lineWidth = Math.max(0.9, Math.min(2.6, (0.85 + (zoom - 3) * 0.45) * compact));
        const pointRadius = Math.max(1.2, Math.min(4.0, (1.35 + (zoom - 3) * 0.65) * compact));
        const pointWeight = Math.max(0.9, Math.min(2.0, (1.0 + (zoom - 3) * 0.25) * compact));

        const densityT = Math.min(1, Math.max(0, (activeCount - 80) / 720));
        const activeLineAlpha = Number((0.55 - densityT * 0.35).toFixed(2));
        let activePointAlpha = Number((0.88 - densityT * 0.56).toFixed(2));
        if (zoom <= 4 && activeCount > 150) {
            activePointAlpha = Math.min(activePointAlpha, 0.26);
        }

        return { lineWidth, pointRadius, pointWeight, activeLineAlpha, activePointAlpha };
    },

    _redrawTracks() {
        const map = this._map;
        const ctx = this._ctx;
        if (!map || !ctx) return;

        const { mode } = this._state;
        if (mode === "trends" || this._tracks.length === 0) {
            return;
        }

        const bounds = map.getBounds().pad(0.35);
        const south = bounds.getSouth();
        const north = bounds.getNorth();
        const west = bounds.getWest();
        const east = bounds.getEast();
        const canCullLon = west >= -180 && east <= 180;

        if (mode === "animation") {
            this._drawAnimation(ctx, map, south, north, west, east, canCullLon);
        } else {
            this._drawStatic(ctx, map, south, north, west, east, canCullLon);
        }
    },

    _drawStatic(ctx, map, south, north, west, east, canCullLon) {
        const {
            mode,
            activeDisturbanceId,
            meanOnlyIds,
            filteredTrackIds,
            showPlotPoints,
        } = this._state;

        const isFilterMode = mode === "filter";

        const visibleTracks = [];
        let activeCount = 0;
        for (const trk of this._tracks) {
            if (trk.maxLat < south || trk.minLat > north) continue;
            if (canCullLon && !trk.crossesDateline && (trk.maxLon < west || trk.minLon > east)) {
                continue;
            }
            const isMeanOnly = !isFilterMode && trk.distId != null && meanOnlyIds.has(trk.distId);
            const isFiltered = filteredTrackIds === null || filteredTrackIds.has(trk.trackIndex);
            if (!isMeanOnly && !isFiltered) continue;

            const isSelected =
                isFilterMode || activeDisturbanceId === null || trk.distId === activeDisturbanceId;
            if (!isMeanOnly && isSelected) activeCount++;
            visibleTracks.push({ trk, isMeanOnly, isSelected });
        }

        const {
            lineWidth,
            pointRadius,
            pointWeight,
            activeLineAlpha,
            activePointAlpha,
        } = this._getStyleMetrics(map, activeCount);

        const dimLineBuckets = new Map();
        const activeLineBuckets = new Map();
        const dimPointBuckets = new Map();
        const activePointBuckets = new Map();

        const pushToBucket = (buckets, key, val) => {
            let arr = buckets.get(key);
            if (!arr) {
                arr = [];
                buckets.set(key, arr);
            }
            arr.push(val);
        };

        for (let i = 0; i < visibleTracks.length; i++) {
            const { trk, isMeanOnly, isSelected } = visibleTracks[i];

            let lineAlpha = 0.05;
            let pointAlpha = 0.05;
            let isDim = true;

            if (isMeanOnly) {
                lineAlpha = 0.03;
                pointAlpha = showPlotPoints ? 0.03 : 0;
            } else if (isSelected) {
                lineAlpha = activeLineAlpha;
                pointAlpha = showPlotPoints ? activePointAlpha : 0;
                isDim = false;
            } else {
                pointAlpha = showPlotPoints ? 0.05 : 0;
            }

            const lineBuckets = isDim ? dimLineBuckets : activeLineBuckets;
            const pointBuckets = isDim ? dimPointBuckets : activePointBuckets;

            for (const seg of trk.segments) {
                const p1 = map.latLngToLayerPoint([seg.lat1, seg.lon1]);
                const p2 = map.latLngToLayerPoint([seg.lat2, seg.lon2]);
                pushToBucket(lineBuckets, `${lineAlpha}|${seg.color}`, [p1.x, p1.y, p2.x, p2.y]);
            }

            if (pointAlpha > 0) {
                for (const pt of trk.points) {
                    const p = map.latLngToLayerPoint([pt.lat, pt.lon]);
                    pushToBucket(pointBuckets, `${pointAlpha}|${pt.color}`, [p.x, p.y]);
                }
            }
        }

        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        const strokeLineBuckets = (buckets) => {
            ctx.lineWidth = lineWidth;
            for (const [key, coords] of buckets.entries()) {
                const sep = key.indexOf("|");
                const alpha = parseFloat(key.slice(0, sep));
                const color = key.slice(sep + 1);
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = color;
                ctx.beginPath();
                for (let i = 0; i < coords.length; i++) {
                    const [x1, y1, x2, y2] = coords[i];
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                }
                ctx.stroke();
            }
        };

        const strokePointBuckets = (buckets) => {
            ctx.lineWidth = pointWeight;
            const twoPi = Math.PI * 2;
            for (const [key, pts] of buckets.entries()) {
                const sep = key.indexOf("|");
                const alpha = parseFloat(key.slice(0, sep));
                const color = key.slice(sep + 1);
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = color;
                ctx.beginPath();
                for (let i = 0; i < pts.length; i++) {
                    const [x, y] = pts[i];
                    ctx.moveTo(x + pointRadius, y);
                    ctx.arc(x, y, pointRadius, 0, twoPi);
                }
                ctx.stroke();
            }
        };

        strokeLineBuckets(dimLineBuckets);
        if (showPlotPoints) strokePointBuckets(dimPointBuckets);
        strokeLineBuckets(activeLineBuckets);
        if (showPlotPoints) strokePointBuckets(activePointBuckets);
        ctx.globalAlpha = 1;
    },

    _drawAnimation(ctx, map, south, north, west, east, canCullLon) {
        const {
            animHour,
            activeDisturbanceId,
            meanOnlyIds,
            filteredTrackIds,
        } = this._state;

        const lineBuckets = new Map();
        const headMarkers = [];
        let activeCount = 0;

        for (const trk of this._tracks) {
            if (trk.maxLat < south || trk.minLat > north) continue;
            if (canCullLon && !trk.crossesDateline && (trk.maxLon < west || trk.minLon > east)) {
                continue;
            }

            if (animHour > trk.maxH) continue;
            if (trk.distId != null && meanOnlyIds.has(trk.distId)) continue;
            if (activeDisturbanceId !== null && trk.distId !== activeDisturbanceId) continue;
            if (filteredTrackIds !== null && !filteredTrackIds.has(trk.trackIndex)) continue;

            let lastVisiblePt = null;
            for (const pt of trk.points) {
                if (pt.h <= animHour) lastVisiblePt = pt;
                else break;
            }
            if (!lastVisiblePt) continue;
            activeCount++;

            for (const seg of trk.segments) {
                if (seg.h2 > animHour) break;
                const p1 = map.latLngToLayerPoint([seg.lat1, seg.lon1]);
                const p2 = map.latLngToLayerPoint([seg.lat2, seg.lon2]);
                let arr = lineBuckets.get(seg.color);
                if (!arr) {
                    arr = [];
                    lineBuckets.set(seg.color, arr);
                }
                arr.push([p1.x, p1.y, p2.x, p2.y]);
            }

            const hp = map.latLngToLayerPoint([lastVisiblePt.lat, lastVisiblePt.lon]);
            headMarkers.push([hp.x, hp.y, lastVisiblePt.color]);
        }

        const { lineWidth, pointRadius, activeLineAlpha } = this._getStyleMetrics(map, activeCount);

        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = lineWidth;
        ctx.globalAlpha = activeLineAlpha;
        for (const [color, coords] of lineBuckets.entries()) {
            ctx.strokeStyle = color;
            ctx.beginPath();
            for (let i = 0; i < coords.length; i++) {
                const [x1, y1, x2, y2] = coords[i];
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
            }
            ctx.stroke();
        }

        const r = Math.max(2.2, Math.min(5.0, pointRadius + 1.0));
        const twoPi = Math.PI * 2;
        ctx.lineWidth = Math.max(1.2, lineWidth * 0.85);
        for (let i = 0; i < headMarkers.length; i++) {
            const [x, y, color] = headMarkers[i];
            ctx.beginPath();
            ctx.arc(x, y, r, 0, twoPi);
            ctx.globalAlpha = 0.85;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.globalAlpha = 0.95;
            ctx.strokeStyle = "#38bdf8";
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    },
});

export default SpaghettiRenderer;
