import * as turf from "@turf/turf";
import {
    BASINS,
    getDatasetConfig,
    windColor,
    windCategory,
    isOriginInBasin,
    parseUtcInitDate,
    formatManilaShortDateTime,
} from "./spaghettiConfig.js";

export const AGREEMENT_RADIUS_DEG = 2;
export const AGREEMENT_RADIUS_KM = AGREEMENT_RADIUS_DEG * 111.32;

const NHC_RADII_KM = {
    0: 0.1,
    12: 48,
    24: 74,
    36: 102,
    48: 130,
    72: 195,
    96: 278,
    120: 361,
};
const NHC_KEYS = Object.keys(NHC_RADII_KM).map(Number).sort((a, b) => a - b);

function getNhcRadius(h) {
    if (h <= 0) return 0.1;
    if (h >= 120) {
        const rate = (NHC_RADII_KM[120] - NHC_RADII_KM[96]) / 24;
        return NHC_RADII_KM[120] + (h - 120) * rate;
    }
    for (let i = 0; i < NHC_KEYS.length - 1; i++) {
        const h1 = NHC_KEYS[i];
        const h2 = NHC_KEYS[i + 1];
        if (h >= h1 && h <= h2) {
            const fraction = (h - h1) / (h2 - h1);
            return NHC_RADII_KM[h1] + fraction * (NHC_RADII_KM[h2] - NHC_RADII_KM[h1]);
        }
    }
    return 0.1;
}

export function decodeObfuscatedData(base64Str, key = 0xAA) {
    const binaryStr = atob(base64Str);
    const len = binaryStr.length;
    const decryptedBytes = new Uint8Array(len);
    if (typeof key === "string") {
        const keyBytes = new TextEncoder().encode(key);
        const kLen = keyBytes.length;
        for (let i = 0; i < len; i++) {
            decryptedBytes[i] = binaryStr.charCodeAt(i) ^ keyBytes[i % kLen];
        }
    } else {
        for (let i = 0; i < len; i++) {
            decryptedBytes[i] = binaryStr.charCodeAt(i) ^ key;
        }
    }
    return new TextDecoder().decode(decryptedBytes);
}

export function parseCSV(text) {
    const lines = text
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"));
    if (lines.length < 2) return { rows: [], cols: [] };

    const cols = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const colCount = cols.length;
    const rows = new Array(lines.length - 1);

    for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(",");
        const row = {};
        for (let c = 0; c < colCount; c++) {
            row[cols[c]] = vals[c] !== undefined ? vals[c].trim() : undefined;
        }
        rows[i - 1] = row;
    }
    return { rows, cols };
}

export function parseLeadTimeHours(row) {
    let leadH = parseFloat(row.lead_time_hours);
    if (isNaN(leadH) || row.lead_time_hours === undefined) {
        const str = row.lead_time || "";
        const parts = str.match(/(?:(\d+)\s+days\s+)?(\d+):(\d+):(\d+)/);
        if (parts) {
            const d = parseInt(parts[1] || 0, 10);
            const h = parseInt(parts[2] || 0, 10);
            leadH = d * 24 + h;
        }
    }
    return leadH;
}

export function normalizeLon180(lon) {
    if (lon > 180) return ((lon + 180) % 360) - 180;
    if (lon < -180) return ((lon - 180) % 360) + 180;
    return lon;
}

export function haversineKm(a, b) {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    let diffLon = b.lon - a.lon;
    if (diffLon > 180) diffLon -= 360;
    if (diffLon < -180) diffLon += 360;
    const dLon = (diffLon * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const sinD =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.asin(Math.min(1, Math.sqrt(sinD)));
}

export function meanGeoCenter(points) {
    if (points.length === 0) return { lat: 0, lon: 0 };
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (const pt of points) {
        const latRad = (pt.lat * Math.PI) / 180;
        const lonRad = (pt.lon * Math.PI) / 180;
        sumX += Math.cos(latRad) * Math.cos(lonRad);
        sumY += Math.cos(latRad) * Math.sin(lonRad);
        sumZ += Math.sin(latRad);
    }
    const n = points.length;
    const avgX = sumX / n;
    const avgY = sumY / n;
    const avgZ = sumZ / n;
    const hyp = Math.sqrt(avgX * avgX + avgY * avgY);
    const lat = (Math.atan2(avgZ, hyp) * 180) / Math.PI;
    const lon = (Math.atan2(avgY, avgX) * 180) / Math.PI;
    return { lat, lon };
}

/**
 * Splits a segment between two points if it crosses the ±180° antimeridian.
 * Returns 1 or 2 [pStart, pEnd] pairs strictly inside [-180, 180].
 */
export function splitAntimeridianSegment(p1, p2) {
    const dlon = p2.lon - p1.lon;
    if (Math.abs(dlon) <= 180) {
        return [[p1, p2]];
    }
    const lon2Unwrapped = dlon > 0 ? p2.lon - 360 : p2.lon + 360;
    const edge1 = dlon > 0 ? -180 : 180;
    const edge2 = -edge1;
    const denom = lon2Unwrapped - p1.lon;
    const t = denom !== 0 ? (edge1 - p1.lon) / denom : 0.5;
    const crossLat = p1.lat + t * (p2.lat - p1.lat);
    return [
        [p1, { ...p2, lat: crossLat, lon: edge1 }],
        [{ ...p1, lat: crossLat, lon: edge2 }, p2],
    ];
}

export function hasCorruptJump(points) {
    for (let i = 1; i < points.length; i++) {
        const p1 = points[i - 1];
        const p2 = points[i];
        const dt = Math.max(1, p2.h - p1.h);
        const dKm = haversineKm(p1, p2);
        if (dKm > Math.max(1800, 180 * dt)) {
            return true;
        }
    }
    return false;
}

export function stitchMemberTracks(memberRows) {
    const byHour = {};
    for (const row of memberRows) {
        const h = row.h;
        if (!byHour[h]) byHour[h] = [];
        byHour[h].push(row);
    }
    const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
    if (hours.length === 0) return [];

    const closedTracks = [];
    let activeTracks = [];

    for (const h of hours) {
        const stillActive = [];
        for (const track of activeTracks) {
            const lastPt = track[track.length - 1];
            if (h - lastPt.h > 24) {
                closedTracks.push(track);
            } else {
                stillActive.push(track);
            }
        }
        activeTracks = stillActive;

        const candidates = byHour[h];
        const matches = [];

        for (let tIdx = 0; tIdx < activeTracks.length; tIdx++) {
            const track = activeTracks[tIdx];
            const lastPt = track[track.length - 1];
            const dt = h - lastPt.h;

            let guessLat = lastPt.lat;
            let guessLon = lastPt.lon;

            if (track.length >= 2) {
                const prevPt = track[track.length - 2];
                const prevDt = lastPt.h - prevPt.h;
                if (prevDt > 0) {
                    const vLat = (lastPt.lat - prevPt.lat) / prevDt;
                    let dLon = lastPt.lon - prevPt.lon;
                    if (dLon > 180) dLon -= 360;
                    if (dLon < -180) dLon += 360;
                    const vLon = dLon / prevDt;

                    guessLat = lastPt.lat + vLat * dt;
                    guessLon = lastPt.lon + vLon * dt;
                    if (guessLon > 180) guessLon -= 360;
                    if (guessLon < -180) guessLon += 360;
                    guessLat = Math.max(-90, Math.min(90, guessLat));
                }
            }

            const maxDistKm = Math.min(800, Math.max(400, 100 * dt));

            for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
                const cand = candidates[cIdx];
                const distKm = haversineKm({ lat: guessLat, lon: guessLon }, cand);
                if (distKm <= maxDistKm) {
                    const dp = isNaN(lastPt.p) || isNaN(cand.p) ? 0 : Math.abs(lastPt.p - cand.p);
                    const score = distKm / 100 + dp;
                    matches.push({ tIdx, cIdx, score });
                }
            }
        }

        matches.sort((a, b) => a.score - b.score);
        const matchedTracks = new Set();
        const matchedCandidates = new Set();
        const newActiveTracks = [];

        for (const m of matches) {
            if (!matchedTracks.has(m.tIdx) && !matchedCandidates.has(m.cIdx)) {
                matchedTracks.add(m.tIdx);
                matchedCandidates.add(m.cIdx);
                const track = activeTracks[m.tIdx];
                track.push(candidates[m.cIdx]);
                newActiveTracks.push(track);
            }
        }

        for (let tIdx = 0; tIdx < activeTracks.length; tIdx++) {
            if (!matchedTracks.has(tIdx)) {
                const track = activeTracks[tIdx];
                const lastPt = track[track.length - 1];
                if (h - lastPt.h <= 24) {
                    newActiveTracks.push(track);
                } else {
                    closedTracks.push(track);
                }
            }
        }

        for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
            if (!matchedCandidates.has(cIdx)) {
                newActiveTracks.push([candidates[cIdx]]);
            }
        }

        activeTracks = newActiveTracks;
    }

    for (const track of activeTracks) {
        closedTracks.push(track);
    }
    return closedTracks.filter((t) => t.length >= 2);
}

export function getTrackDistance(trackA, trackB, lookupA = null, lookupB = null) {
    const pointsA = lookupA || {};
    if (!lookupA) {
        for (const p of trackA) pointsA[p.h] = p;
    }
    const pointsB = lookupB || {};
    if (!lookupB) {
        for (const p of trackB) pointsB[p.h] = p;
    }

    let sumDist = 0;
    let count = 0;
    for (const hStr in pointsB) {
        const pB = pointsB[hStr];
        const pA = pointsA[pB.h];
        if (pA) {
            sumDist += haversineKm(pA, pB);
            count++;
        }
    }

    if (count > 0) {
        const meanDist = sumDist / count;
        const minLen = Math.min(trackA.length, trackB.length);
        if (count === 1 && minLen >= 4) {
            return meanDist + 500;
        }
        return meanDist;
    }

    const startA = trackA[0];
    const endA = trackA[trackA.length - 1];
    const startB = trackB[0];
    const endB = trackB[trackB.length - 1];

    if (startB.h >= endA.h) {
        const dt = startB.h - endA.h;
        if (dt <= 24) {
            const dGap = haversineKm(endA, startB);
            const penaltyDist = dGap + 25 * dt;
            if (penaltyDist < 1200) return penaltyDist;
        }
    } else if (startA.h >= endB.h) {
        const dt = startA.h - endB.h;
        if (dt <= 24) {
            const dGap = haversineKm(endB, startA);
            const penaltyDist = dGap + 25 * dt;
            if (penaltyDist < 1200) return penaltyDist;
        }
    }

    return 5000;
}

export function runHDBSCAN(distanceMatrix, minClusterSize) {
    const n = distanceMatrix.length;
    if (n === 0) return [];

    const k = Math.min(n - 1, Math.max(1, minClusterSize - 1));
    const coreDist = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const sortedDists = Array.from(distanceMatrix[i]).sort((a, b) => a - b);
        coreDist[i] = sortedDists[k];
    }

    const inMST = new Uint8Array(n);
    const minDist = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    minDist[0] = 0;
    const edges = [];

    for (let step = 0; step < n; step++) {
        let u = -1;
        let best = Infinity;
        for (let i = 0; i < n; i++) {
            if (!inMST[i] && minDist[i] < best) {
                best = minDist[i];
                u = i;
            }
        }
        if (u === -1) break;
        inMST[u] = 1;
        if (parent[u] !== -1) {
            edges.push({ u: parent[u], v: u, weight: best });
        }
        const rowU = distanceMatrix[u];
        const coreU = coreDist[u];
        for (let v = 0; v < n; v++) {
            if (!inMST[v]) {
                const w = Math.max(coreU, coreDist[v], rowU[v]);
                if (w < minDist[v]) {
                    minDist[v] = w;
                    parent[v] = u;
                }
            }
        }
    }

    edges.sort((a, b) => a.weight - b.weight);

    let nextNodeId = n;
    const ufParent = new Int32Array(n * 2);
    const nodes = new Array(n * 2);
    for (let i = 0; i < n * 2; i++) {
        ufParent[i] = i;
        nodes[i] = {
            id: i,
            left: null,
            right: null,
            weight: 0,
            death: Infinity,
            size: i < n ? 1 : 0,
        };
    }

    function find(i) {
        let root = i;
        while (ufParent[root] !== root) root = ufParent[root];
        let curr = i;
        while (curr !== root) {
            const next = ufParent[curr];
            ufParent[curr] = root;
            curr = next;
        }
        return root;
    }

    for (const edge of edges) {
        const rootU = find(edge.u);
        const rootV = find(edge.v);
        if (rootU !== rootV) {
            const newId = nextNodeId++;
            ufParent[rootU] = newId;
            ufParent[rootV] = newId;
            nodes[newId].left = nodes[rootU];
            nodes[newId].right = nodes[rootV];
            nodes[newId].weight = edge.weight;
            nodes[newId].size = nodes[rootU].size + nodes[rootV].size;
            nodes[rootU].death = edge.weight;
            nodes[rootV].death = edge.weight;
        }
    }

    const rootNodeId = nextNodeId - 1;
    if (rootNodeId < n) return new Array(n).fill(0);

    function collectLeaves(node) {
        const out = [];
        const stack = [node];
        while (stack.length > 0) {
            const curr = stack.pop();
            if (!curr.left && !curr.right) {
                out.push(curr.id);
            } else {
                if (curr.right) stack.push(curr.right);
                if (curr.left) stack.push(curr.left);
            }
        }
        return out;
    }

    let nextClusterId = 1;
    const condensedNodes = {
        0: {
            id: 0,
            parent: null,
            birth: nodes[rootNodeId].weight,
            entries: [],
            children: [],
            stability: 0,
            selected: false,
        },
    };

    function addEntry(cid, pt, deathWeight) {
        condensedNodes[cid].entries.push({ pt, deathWeight });
    }

    function condense(node, cid) {
        if (!node.left && !node.right) {
            addEntry(cid, node.id, node.death);
            return;
        }
        const left = node.left;
        const right = node.right;
        const leftCount = left.size;
        const rightCount = right.size;

        if (leftCount >= minClusterSize && rightCount >= minClusterSize) {
            const leftClusterId = nextClusterId++;
            const rightClusterId = nextClusterId++;
            condensedNodes[leftClusterId] = {
                id: leftClusterId,
                parent: cid,
                birth: node.weight,
                entries: [],
                children: [],
                stability: 0,
                selected: false,
            };
            condensedNodes[rightClusterId] = {
                id: rightClusterId,
                parent: cid,
                birth: node.weight,
                entries: [],
                children: [],
                stability: 0,
                selected: false,
            };
            condensedNodes[cid].children.push(leftClusterId, rightClusterId);
            for (const p of collectLeaves(left)) addEntry(cid, p, node.weight);
            for (const p of collectLeaves(right)) addEntry(cid, p, node.weight);
            condense(left, leftClusterId);
            condense(right, rightClusterId);
        } else if (leftCount >= minClusterSize) {
            for (const p of collectLeaves(right)) addEntry(cid, p, node.weight);
            condense(left, cid);
        } else if (rightCount >= minClusterSize) {
            for (const p of collectLeaves(left)) addEntry(cid, p, node.weight);
            condense(right, cid);
        } else {
            for (const p of collectLeaves(node)) addEntry(cid, p, nodes[p].death);
        }
    }

    condense(nodes[rootNodeId], 0);

    for (const cnode of Object.values(condensedNodes)) {
        const lambdaBirth = 1 / (cnode.birth || 0.0001);
        let sumStability = 0;
        for (const { deathWeight } of cnode.entries) {
            const lambdaDeath = 1 / (deathWeight || 0.0001);
            sumStability += Math.max(0, lambdaDeath - lambdaBirth);
        }
        cnode.stability = sumStability;
    }

    const clusterIds = Object.keys(condensedNodes).map(Number).sort((a, b) => b - a);
    const subtreeStability = {};
    for (const cid of clusterIds) {
        const cnode = condensedNodes[cid];
        const childIds = cnode.children;
        let childStabilitySum = 0;
        for (const childId of childIds) {
            childStabilitySum += subtreeStability[childId] || 0;
        }
        if (childIds.length > 0 && childStabilitySum >= cnode.stability) {
            subtreeStability[cid] = childStabilitySum;
            cnode.selected = false;
        } else {
            subtreeStability[cid] = cnode.stability;
            cnode.selected = true;
            const queue = [...childIds];
            while (queue.length > 0) {
                const qid = queue.shift();
                condensedNodes[qid].selected = false;
                if (condensedNodes[qid].children.length > 0) {
                    queue.push(...condensedNodes[qid].children);
                }
            }
        }
    }

    const labels = new Array(n).fill(-1);
    for (const cnode of Object.values(condensedNodes)) {
        if (cnode.selected) {
            const lbl = cnode.id === 0 ? 1 : cnode.id;
            for (const { pt, deathWeight } of cnode.entries) {
                if (cnode.id === 0 && deathWeight >= cnode.birth && cnode.birth > 1200) {
                    continue;
                }
                labels[pt] = lbl;
            }
        }
    }
    return labels;
}

export function splitClusterKMedoids(trackIndices, distanceMatrix, limit) {
    if (trackIndices.length <= limit) {
        return [trackIndices];
    }

    const n = trackIndices.length;
    let m1 = trackIndices[0];
    let m2 = trackIndices[0];
    let maxDist = -1;
    for (let i = 0; i < n; i++) {
        const idxI = trackIndices[i];
        const rowI = distanceMatrix[idxI];
        for (let j = i + 1; j < n; j++) {
            const idxJ = trackIndices[j];
            const d = rowI[idxJ];
            if (d > maxDist) {
                maxDist = d;
                m1 = idxI;
                m2 = idxJ;
            }
        }
    }

    if (maxDist <= 0) {
        const mid = Math.floor(n / 2);
        return [
            ...splitClusterKMedoids(trackIndices.slice(0, mid), distanceMatrix, limit),
            ...splitClusterKMedoids(trackIndices.slice(mid), distanceMatrix, limit),
        ];
    }

    let cluster1 = [];
    let cluster2 = [];

    for (let iter = 0; iter < 10; iter++) {
        cluster1 = [];
        cluster2 = [];

        for (const idx of trackIndices) {
            if (distanceMatrix[idx][m1] <= distanceMatrix[idx][m2]) {
                cluster1.push(idx);
            } else {
                cluster2.push(idx);
            }
        }

        if (cluster1.length === 0 || cluster2.length === 0) {
            break;
        }

        let bestM1 = m1;
        let minDistSum1 = Infinity;
        for (const candidate of cluster1) {
            let sumDist = 0;
            const rowC = distanceMatrix[candidate];
            for (const other of cluster1) {
                sumDist += rowC[other];
            }
            if (sumDist < minDistSum1) {
                minDistSum1 = sumDist;
                bestM1 = candidate;
            }
        }

        let bestM2 = m2;
        let minDistSum2 = Infinity;
        for (const candidate of cluster2) {
            let sumDist = 0;
            const rowC = distanceMatrix[candidate];
            for (const other of cluster2) {
                sumDist += rowC[other];
            }
            if (sumDist < minDistSum2) {
                minDistSum2 = sumDist;
                bestM2 = candidate;
            }
        }

        if (bestM1 === m1 && bestM2 === m2) break;
        m1 = bestM1;
        m2 = bestM2;
    }

    if (cluster1.length === 0 || cluster2.length === 0 || cluster1.length === n || cluster2.length === n) {
        const mid = Math.floor(n / 2);
        cluster1 = trackIndices.slice(0, mid);
        cluster2 = trackIndices.slice(mid);
    }

    return [
        ...splitClusterKMedoids(cluster1, distanceMatrix, limit),
        ...splitClusterKMedoids(cluster2, distanceMatrix, limit),
    ];
}

export function groupAndClusterTracks(basinFiltered, numMembers, datasetId) {
    if (basinFiltered.length === 0) return { clusters: [], trackLabels: [] };
    const n = basinFiltered.length;
    const trackLookups = basinFiltered.map((t) => {
        const map = {};
        for (const p of t) map[p.h] = p;
        return map;
    });

    const distanceMatrix = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
        const tA = basinFiltered[i];
        const lA = trackLookups[i];
        for (let j = i + 1; j < n; j++) {
            const dist = getTrackDistance(tA, basinFiltered[j], lA, trackLookups[j]);
            distanceMatrix[i][j] = dist;
            distanceMatrix[j][i] = dist;
        }
    }

    const minClusterSize = Math.max(4, Math.round(numMembers * (numMembers > 100 ? 0.03 : 0.08)));
    let labels = runHDBSCAN(distanceMatrix, minClusterSize);

    if (labels.every((l) => l === -1) && n >= 4) {
        const fallbackMin = Math.max(3, Math.floor(minClusterSize / 2));
        if (fallbackMin < minClusterSize) {
            labels = runHDBSCAN(distanceMatrix, fallbackMin);
        }
    }

    const clustersByLabel = {};
    for (let i = 0; i < n; i++) {
        const label = labels[i];
        if (label === -1) continue;
        if (!clustersByLabel[label]) clustersByLabel[label] = [];
        clustersByLabel[label].push(i);
    }

    const cfg = getDatasetConfig(datasetId);
    const limit = cfg.totalMembers || 50;

    const finalGroups = [];
    for (const trackIndices of Object.values(clustersByLabel)) {
        if (trackIndices.length > limit) {
            finalGroups.push(...splitClusterKMedoids(trackIndices, distanceMatrix, limit));
        } else {
            finalGroups.push(trackIndices);
        }
    }

    const clusters = [];
    let nextDistId = 1;
    for (const trackIndices of finalGroups) {
        const clusterTracks = trackIndices.map((idx) => basinFiltered[idx]);
        const origins = clusterTracks.map((t) => t[0]);
        const minH = Math.min(...origins.map((o) => o.h));
        const maxH = Math.max(...origins.map((o) => o.h));
        const center = meanGeoCenter(origins);
        clusters.push({
            distId: nextDistId++,
            origins,
            minH,
            maxH,
            center,
            trackIndices,
        });
    }

    const trackLabels = new Array(n).fill(null);
    for (const c of clusters) {
        for (const idx of c.trackIndices) {
            trackLabels[idx] = c.distId;
        }
    }
    return { clusters, trackLabels };
}

export function regionName(lat, lon) {
    if (lon >= 100 && lon <= 120 && lat >= 5 && lat <= 25) return "South China Sea";
    if (lon > 120 && lon <= 135 && lat >= 5 && lat <= 25) return "Philippine Sea";
    if (lon > 135 && lon <= 180 && lat >= 0 && lat <= 25) return "W. Pacific";
    if (lon > 120 && lon <= 145 && lat > 25 && lat <= 45) return "NW Pacific";
    if (lat < 0) return "Southern Hemisphere";
    return "Open Pacific";
}

function median(arr) {
    if (arr.length === 0) return NaN;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function weightedMedian(values, weights) {
    if (values.length === 0) return 0;
    const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
    const totalWeight = pairs.reduce((sum, p) => sum + p.w, 0);
    let cumulative = 0;
    for (const p of pairs) {
        cumulative += p.w;
        if (cumulative >= totalWeight / 2) return p.v;
    }
    return pairs[pairs.length - 1].v;
}

function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil(p * s.length) - 1;
    return s[Math.max(0, Math.min(idx, s.length - 1))];
}

function buildConeGeoJson(meanPts) {
    if (!meanPts || meanPts.length < 2) return null;

    const circles = [];
    for (let i = 0; i < meanPts.length; i++) {
        const pt = meanPts[i];
        let rKm = Math.max(10, pt.r67km);
        if (i === 0 || pt.h === 0) {
            rKm = 0.1;
        } else {
            const hoursSinceOrigin = pt.h - meanPts[0].h;
            const maxRadius = getNhcRadius(hoursSinceOrigin);
            rKm = Math.min(rKm, maxRadius);
        }
        circles.push(turf.circle([pt.lon, pt.lat], rKm, { steps: 36, units: "kilometers" }));
    }

    if (circles.length === 0) return null;

    const capsules = [];
    if (circles.length === 1) {
        capsules.push(circles[0]);
    } else {
        for (let i = 0; i < circles.length - 1; i++) {
            const dlon = Math.abs(meanPts[i + 1].lon - meanPts[i].lon);
            if (dlon > 180) {
                capsules.push(circles[i], circles[i + 1]);
                continue;
            }
            const fc = turf.featureCollection([circles[i], circles[i + 1]]);
            const capsule = turf.convex(fc);
            if (capsule) capsules.push(capsule);
        }
    }

    if (capsules.length === 0) return null;

    try {
        return turf.union(turf.featureCollection(capsules));
    } catch {
        try {
            return capsules.reduce((acc, curr) => turf.union(acc, curr));
        } catch {
            return null;
        }
    }
}

function parsePairedTracks(pairedCsvText, maxHours, preParsedEmbedded = null) {
    const pairedMeanByTrackId = {};

    const addPoint = (trackId, pt) => {
        if (!trackId) return;
        if (!pairedMeanByTrackId[trackId]) {
            pairedMeanByTrackId[trackId] = { points: [], trackId };
        }
        pairedMeanByTrackId[trackId].points.push(pt);
    };

    if (preParsedEmbedded) {
        for (const [trackId, pts] of Object.entries(preParsedEmbedded)) {
            for (const pt of pts) {
                if (pt.h <= maxHours) addPoint(trackId, pt);
            }
        }
    }

    if (pairedCsvText) {
        const { rows: pairedRows } = parseCSV(pairedCsvText);
        for (const row of pairedRows) {
            const trackId = (row.track_id || "").trim();
            const sampleVal = (row.sample || "").trim();
            if (sampleVal !== "-1") continue;

            const leadH = parseLeadTimeHours(row);
            if (isNaN(leadH) || leadH > maxHours) continue;

            const lat = parseFloat(row.lat);
            const lon = parseFloat(row.lon);
            const pres = parseFloat(row.minimum_sea_level_pressure_hpa);
            const windKt = parseFloat(row.maximum_sustained_wind_speed_knots);
            const windKmh = isNaN(windKt) ? NaN : Math.round(windKt * 1.852);
            if (isNaN(lat) || isNaN(lon)) continue;

            addPoint(trackId, {
                lat,
                lon: normalizeLon180(lon),
                p: pres,
                windKmh,
                h: leadH,
            });
        }
    }

    for (const key of Object.keys(pairedMeanByTrackId)) {
        pairedMeanByTrackId[key].points.sort((a, b) => a.h - b.h);
    }

    return pairedMeanByTrackId;
}

/**
 * Unified ensemble run analyzer used by both Tracker/Animation/Filter views
 * and Multi-Cycle Trends so statistics, clustering, and formatting never drift.
 */
export function analyzeEnsembleData({
    csvText,
    pairedCsvText = null,
    datasetId = "fnv3p2",
    basinId = "wpac",
    horizon = "5day",
    includeCones = true,
}) {
    const cfg = getDatasetConfig(datasetId);
    const maxHours = horizon === "5day" ? 120 : 312;
    const basin = BASINS.find((opt) => opt.id === basinId) || BASINS[0];

    const { rows } = parseCSV(csvText);
    const rawRows = rows.filter(
        (r) =>
            (r.lead_time_hours !== undefined || r.lead_time !== undefined) &&
            r.lat !== undefined
    );

    const runInitTime =
        rows.length > 0 && rows[0].init_time ? rows[0].init_time : "latest";
    const initDate = parseUtcInitDate(runInitTime);
    const initDateMs = initDate ? initDate.getTime() : null;

    // Group rows by (track_id, sample) when track_id exists; extract sample=-1 as paired mean
    const groupedRows = {};
    const embeddedPaired = {};
    const memberSamples = new Set();

    for (const row of rawRows) {
        const leadH = parseLeadTimeHours(row);
        if (isNaN(leadH) || leadH > maxHours) continue;

        const lat = parseFloat(row.lat);
        const lon = parseFloat(row.lon);
        const pres = parseFloat(row.minimum_sea_level_pressure_hpa);
        const windKt = parseFloat(row.maximum_sustained_wind_speed_knots);
        const windKmh = isNaN(windKt) ? NaN : Math.round(windKt * 1.852);
        if (isNaN(lat) || isNaN(lon)) continue;

        const llon = normalizeLon180(lon);
        const sample = (row.sample !== undefined ? String(row.sample).trim() : "") || "default";
        const rawTrackId = (row.track_id !== undefined ? String(row.track_id).trim() : "");

        if (sample === "-1") {
            if (rawTrackId) {
                (embeddedPaired[rawTrackId] ||= []).push({
                    lat,
                    lon: llon,
                    p: pres,
                    windKmh,
                    h: leadH,
                });
            }
            continue;
        }

        memberSamples.add(sample);
        const groupKey = rawTrackId ? `${rawTrackId}::${sample}` : sample;
        if (!groupedRows[groupKey]) {
            groupedRows[groupKey] = { rawTrackId, sample, pts: [] };
        }
        groupedRows[groupKey].pts.push({
            lat,
            lon: llon,
            p: pres,
            windKmh,
            h: leadH,
        });
    }

    // Build clean, chronologically sorted tracks
    const stitchedTracks = [];
    const stitchedTrackMeta = [];

    for (const group of Object.values(groupedRows)) {
        const pts = group.pts;
        if (pts.length < 2) continue;
        pts.sort((a, b) => a.h - b.h);

        let needsStitch = false;
        for (let i = 1; i < pts.length; i++) {
            if (pts[i].h === pts[i - 1].h || pts[i].h - pts[i - 1].h > 24) {
                needsStitch = true;
                break;
            }
        }

        const tracksForGroup = needsStitch ? stitchMemberTracks(pts) : [pts];
        for (const trk of tracksForGroup) {
            if (trk.length < 2 || hasCorruptJump(trk)) continue;
            stitchedTracks.push(trk);
            stitchedTrackMeta.push({
                sample: group.sample,
                rawTrackId: group.rawTrackId,
            });
        }
    }

    // Filter tracks whose origin falls inside the selected basin
    const basinFiltered = [];
    const basinTrackMeta = [];
    for (let i = 0; i < stitchedTracks.length; i++) {
        const points = stitchedTracks[i];
        const origin = points.find((p) => p.h === 0) || points[0];
        if (!origin) continue;
        if (isOriginInBasin(origin, basin)) {
            basinFiltered.push(points);
            basinTrackMeta.push(stitchedTrackMeta[i]);
        }
    }

    const numMembers = memberSamples.size || cfg.totalMembers;
    const { clusters, trackLabels } = groupAndClusterTracks(
        basinFiltered,
        numMembers,
        cfg.id
    );

    const tracksByDisturbance = {};
    const trackIdsByDisturbance = {};
    for (let i = 0; i < basinFiltered.length; i++) {
        const distId = trackLabels[i];
        if (distId !== null) {
            (tracksByDisturbance[distId] ||= []).push(basinFiltered[i]);
            (trackIdsByDisturbance[distId] ||= []).push(basinTrackMeta[i].rawTrackId);
        }
    }

    const disturbanceList = clusters.map((cluster) => {
        const distTracks = tracksByDisturbance[cluster.distId] || [];
        const rawIds = trackIdsByDisturbance[cluster.distId] || [];

        const allMaxW = distTracks.map((pts) => {
            let mx = 0;
            for (const pt of pts) {
                if (!isNaN(pt.windKmh) && pt.windKmh > mx) mx = pt.windKmh;
            }
            return mx;
        });

        const peakW = allMaxW.length > 0 ? Math.max(...allMaxW) : 0;
        const peakCat = windCategory(peakW);
        const peakColor = windColor(peakW);
        const region = regionName(cluster.center.lat, cluster.center.lon);

        const catCounts = {};
        for (const w of allMaxW) {
            const cat = windCategory(w);
            catCounts[cat] = (catCounts[cat] || 0) + 1;
        }

        // Determine dominant meaningful stormTrackId (e.g. "70W", "IN-FA", "CP96", "WP302026")
        const idCounts = {};
        let stormTrackId = null;
        let bestIdCount = 0;
        for (const rid of rawIds) {
            if (!rid || /^\d+$/.test(rid)) continue;
            idCounts[rid] = (idCounts[rid] || 0) + 1;
            if (idCounts[rid] > bestIdCount) {
                bestIdCount = idCounts[rid];
                stormTrackId = rid;
            }
        }

        const formationDateStr = initDateMs
            ? formatManilaShortDateTime(initDateMs, cluster.minH || 0).full
            : "Unknown";

        return {
            id: cluster.distId,
            lat: cluster.center.lat,
            lon: cluster.center.lon,
            region,
            trackCount: distTracks.length,
            peakW,
            peakCat,
            peakColor,
            catCounts,
            pairedTrackName: null,
            stormTrackId,
            agreement: 0,
            spreadKm: 0,
            hasEnsembleMean: false,
            meanSource: null,
            highIntensityUncertainty: false,
            meanPoints: null,
            coneGeoJson: null,
            formationDateStr,
            minH: cluster.minH,
        };
    });

    // Deterministic sorting and renumbering
    disturbanceList.sort((a, b) => {
        if (a.minH !== b.minH) return a.minH - b.minH;
        if (b.trackCount !== a.trackCount) return b.trackCount - a.trackCount;
        if (b.lat !== a.lat) return b.lat - a.lat;
        return b.lon - a.lon;
    });

    const oldToNew = {};
    disturbanceList.forEach((d, idx) => {
        const newId = idx + 1;
        oldToNew[d.id] = newId;
        d.id = newId;
    });

    const updatedTracksByDist = {};
    for (const [oldId, trks] of Object.entries(tracksByDisturbance)) {
        const newId = oldToNew[parseInt(oldId, 10)] || oldId;
        updatedTracksByDist[newId] = trks;
    }

    const finalTrackLabels = trackLabels.map((lbl) =>
        lbl !== null && oldToNew[lbl] != null ? oldToNew[lbl] : lbl
    );

    // Paired / official mean track assignment
    const pairedMeanByTrackId = parsePairedTracks(
        pairedCsvText,
        maxHours,
        embeddedPaired
    );

    const pairedAssignment = {};
    const usedPairedTracks = new Set();
    const usedDisturbances = new Set();
    const candidates = [];

    for (const [tId, paired] of Object.entries(pairedMeanByTrackId)) {
        if (paired.points.length < 2) continue;
        const pOrigin = paired.points[0];
        for (const dist of disturbanceList) {
            const tracks = updatedTracksByDist[dist.id] || [];
            if (tracks.length < 2) continue;
            const dKm = haversineKm(
                { lat: dist.lat, lon: dist.lon },
                { lat: pOrigin.lat, lon: pOrigin.lon }
            );
            if (dKm < 500) {
                candidates.push({ tId, paired, dist, dKm });
            }
        }
    }

    candidates.sort((a, b) => a.dKm - b.dKm);
    for (const c of candidates) {
        if (usedPairedTracks.has(c.tId) || usedDisturbances.has(c.dist.id)) continue;
        usedPairedTracks.add(c.tId);
        usedDisturbances.add(c.dist.id);
        const numMatch = c.tId.match(/^([A-Z]{2})(\d{2})/i);
        pairedAssignment[c.dist.id] = {
            paired: c.paired,
            trackName: numMatch
                ? `${numMatch[2]}${numMatch[1][0].toUpperCase()}`
                : c.tId,
        };
    }

    const minRequiredMembers = cfg.minRequiredMembers;

    for (const dist of disturbanceList) {
        const tracks = updatedTracksByDist[dist.id] || [];
        if (tracks.length < minRequiredMembers) {
            dist.hasEnsembleMean = false;
            continue;
        }

        dist.hasEnsembleMean = true;
        const assignment = pairedAssignment[dist.id];
        let matchedPaired = null;
        if (assignment) {
            matchedPaired = assignment.paired;
            dist.pairedTrackName = assignment.trackName;
            dist.meanSource = "paired";
        } else {
            dist.meanSource = "computed";
        }

        const byHour = {};
        for (let tIdx = 0; tIdx < tracks.length; tIdx++) {
            const track = tracks[tIdx];
            for (const pt of track) {
                if (!byHour[pt.h]) {
                    byHour[pt.h] = { lats: [], lons: [], ps: [], winds: [], trackIndices: [] };
                }
                byHour[pt.h].lats.push(pt.lat);
                byHour[pt.h].lons.push(pt.lon);
                byHour[pt.h].ps.push(!isNaN(pt.p) ? pt.p : NaN);
                byHour[pt.h].winds.push(!isNaN(pt.windKmh) ? pt.windKmh : NaN);
                byHour[pt.h].trackIndices.push(tIdx);
            }
        }

        const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);

        // Pre-calculate track persistence weights
        const trackWeights = tracks.map((track) => {
            let maxJumpSpeed = 0;
            for (let i = 1; i < track.length; i++) {
                const pt1 = track[i - 1];
                const pt2 = track[i];
                const dH = pt2.h - pt1.h;
                if (dH > 0) {
                    const speed = haversineKm(pt1, pt2) / dH;
                    if (speed > maxJumpSpeed) maxJumpSpeed = speed;
                }
            }
            if (maxJumpSpeed > 60) return 0.3;
            if (maxJumpSpeed > 45) return 0.6;
            return 1.0;
        });

        // Selective Ensemble Mean (SEM) member selection at reference hour
        let refHour = 24;
        if (!byHour[24]) {
            refHour = hours.filter((h) => h <= 24).pop() || hours[hours.length - 1];
        }
        let semSelectedIndices = new Set(tracks.map((_, i) => i));

        if (byHour[refHour] && byHour[refHour].lats.length >= 3) {
            const refGeo = meanGeoCenter(
                byHour[refHour].lats.map((lat, idx) => ({
                    lat,
                    lon: byHour[refHour].lons[idx],
                }))
            );
            const trackErrors = [];
            let totalError = 0;
            for (let i = 0; i < byHour[refHour].lats.length; i++) {
                const tIdx = byHour[refHour].trackIndices[i];
                const err = haversineKm(
                    { lat: byHour[refHour].lats[i], lon: byHour[refHour].lons[i] },
                    refGeo
                );
                trackErrors.push({ tIdx, err });
                totalError += err;
            }
            const avgError = totalError / trackErrors.length;
            const selected = trackErrors.filter((t) => t.err <= avgError).map((t) => t.tIdx);
            if (selected.length > 0) {
                semSelectedIndices = new Set(selected);
            }
        }

        const meanPts = [];
        let totalAgreement = 0;
        let agreementSteps = 0;

        for (const h of hours) {
            const d = byHour[h];
            const n = d.lats.length;
            if (n === 0) continue;

            let mLat;
            let mLon;
            let mW;
            let mP;

            if (matchedPaired) {
                const pairedPt = matchedPaired.points.reduce(
                    (best, pt) =>
                        Math.abs(pt.h - h) < Math.abs(best.h - h) ? pt : best,
                    matchedPaired.points[0]
                );
                if (Math.abs(pairedPt.h - h) <= 3) {
                    mLat = pairedPt.lat;
                    mLon = pairedPt.lon;
                    mW = pairedPt.windKmh;
                    mP = pairedPt.p;
                } else {
                    continue;
                }
            } else {
                const semPts = [];
                for (let i = 0; i < n; i++) {
                    if (semSelectedIndices.has(d.trackIndices[i])) {
                        semPts.push({ lat: d.lats[i], lon: d.lons[i] });
                    }
                }
                const geoMean =
                    semPts.length > 0
                        ? meanGeoCenter(semPts)
                        : meanGeoCenter(d.lats.map((lat, idx) => ({ lat, lon: d.lons[idx] })));
                mLat = geoMean.lat;
                mLon = geoMean.lon;

                // Survivorship-bias-corrected weighted median intensity
                const windVals = [];
                const windWeights = [];
                for (let i = 0; i < d.winds.length; i++) {
                    if (!isNaN(d.winds[i])) {
                        windVals.push(d.winds[i]);
                        windWeights.push(trackWeights[d.trackIndices[i]]);
                    }
                }
                const activeCount = windVals.length;
                const deadCount = tracks.length - activeCount;
                for (let i = 0; i < deadCount; i++) {
                    const decayVal = deadCount > 1 ? 19 + (i / (deadCount - 1)) * 18 : 28;
                    windVals.push(decayVal);
                    windWeights.push(1.0);
                }
                mW = weightedMedian(windVals, windWeights);

                const validPs = d.ps.filter((p) => !isNaN(p));
                mP = validPs.length > 0 ? median(validPs) : NaN;

                if (activeCount > 0) {
                    const sortedActive = [...windVals.slice(0, activeCount)].sort((a, b) => b - a);
                    const top10Count = Math.max(1, Math.floor(sortedActive.length * 0.1));
                    const top10Mean =
                        sortedActive.slice(0, top10Count).reduce((a, b) => a + b, 0) / top10Count;
                    if (top10Mean - mW > 74) {
                        dist.highIntensityUncertainty = true;
                    }
                }
            }

            const distsKm = new Array(n);
            let sumDists = 0;
            let inside = 0;
            for (let i = 0; i < n; i++) {
                const dd = haversineKm({ lat: d.lats[i], lon: d.lons[i] }, { lat: mLat, lon: mLon });
                distsKm[i] = dd;
                sumDists += dd;
                if (dd <= AGREEMENT_RADIUS_KM) inside++;
            }

            const meanDistKm = sumDists / n;
            let varianceKm = 0;
            for (let i = 0; i < n; i++) {
                const diff = distsKm[i] - meanDistKm;
                varianceKm += diff * diff;
            }
            const sdKm = Math.sqrt(varianceKm / n);
            const r67km = percentile(distsKm, 0.67);

            const stepAgreementPct = Math.round((inside / n) * 100);
            totalAgreement += inside / n;
            agreementSteps++;

            meanPts.push({
                lat: mLat,
                lon: mLon,
                windKmh: mW,
                p: mP,
                h,
                sdKm,
                r67km,
                activeMembers: n,
                totalMembers: tracks.length,
                stepAgreementPct,
            });
        }

        dist.agreement =
            agreementSteps > 0 ? Math.round((totalAgreement / agreementSteps) * 100) : 0;
        const avgSdKm =
            meanPts.reduce((s, p) => s + p.sdKm, 0) / (meanPts.length || 1);
        dist.spreadKm = Math.round(avgSdKm);
        dist.meanPoints = meanPts;
        if (includeCones && meanPts.length >= 2) {
            dist.coneGeoJson = buildConeGeoJson(meanPts);
        }
    }

    return {
        runInitTime,
        initDateMs,
        rawRowCount: rawRows.length,
        numMembers,
        allTracks: basinFiltered,
        trackDistIds: finalTrackLabels,
        disturbances: disturbanceList,
        tracksByDisturbance: updatedTracksByDist,
    };
}

export function matchDisturbancesAcrossCycles(selectedDist, cyclesData) {
    if (!selectedDist || !cyclesData || cyclesData.length === 0) return [];

    const matchedChain = [];
    let currentCenter = { lat: selectedDist.lat, lon: selectedDist.lon };
    let currentPairedName = selectedDist.pairedTrackName;

    for (let i = 0; i < cyclesData.length; i++) {
        const cycle = cyclesData[i];
        let match = null;

        if (i === 0) {
            match =
                cycle.disturbances.find((d) => d.id === selectedDist.id) || selectedDist;
        } else {
            if (currentPairedName) {
                match = cycle.disturbances.find(
                    (d) => d.pairedTrackName === currentPairedName
                );
            }
            if (!match) {
                let bestDist = Infinity;
                for (const d of cycle.disturbances) {
                    const dist = haversineKm(currentCenter, { lat: d.lat, lon: d.lon });
                    if (dist < 450 && dist < bestDist) {
                        bestDist = dist;
                        match = d;
                    }
                }
            }
        }

        if (match) {
            matchedChain.push({
                cycleIndex: i,
                cycleTime: cycle.cycleTime,
                disturbance: match,
            });
            currentCenter = { lat: match.lat, lon: match.lon };
            if (match.pairedTrackName) {
                currentPairedName = match.pairedTrackName;
            }
        } else {
            matchedChain.push({
                cycleIndex: i,
                cycleTime: cycle.cycleTime,
                disturbance: null,
            });
        }
    }

    return matchedChain;
}
