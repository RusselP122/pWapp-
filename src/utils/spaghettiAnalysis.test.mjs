import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    BASINS,
    getDatasetConfig,
    isOriginInBasin,
    formatDisturbanceDisplayName,
    windColor,
    windCategory,
} from "./spaghettiConfig.js";
import {
    decodeObfuscatedData,
    parseCSV,
    haversineKm,
    splitAntimeridianSegment,
    hasCorruptJump,
    analyzeEnsembleData,
} from "./spaghettiAnalysis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../public/data");

test("decodeObfuscatedData decodes numeric and string XOR keys", () => {
    const sample = "init_time,lat,lon\n2026-11-25 18:00:00,12.5,130.0\n";

    // Numeric XOR 0xAA
    const encNum = Buffer.from(
        Uint8Array.from(Buffer.from(sample, "utf8"), (b) => b ^ 0xaa)
    ).toString("base64");
    assert.equal(decodeObfuscatedData(encNum, 0xaa), sample);

    // String XOR "CalauanWeather2026"
    const key = Buffer.from("CalauanWeather2026", "utf8");
    const encStr = Buffer.from(
        Uint8Array.from(Buffer.from(sample, "utf8"), (b, i) => b ^ key[i % key.length])
    ).toString("base64");
    assert.equal(decodeObfuscatedData(encStr, "CalauanWeather2026"), sample);
});

test("parseCSV strips BOM, comment headers, and handles CRLF", () => {
    const csv = "\uFEFF# comment\r\ninit_time, lat ,lon\r\n2026-11-25 00:00:00, 14.2, 125.5\r\n";
    const { cols, rows } = parseCSV(csv);
    assert.deepEqual(cols, ["init_time", "lat", "lon"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lat, "14.2");
    assert.equal(rows[0].lon, "125.5");
});

test("isOriginInBasin handles South Pacific antimeridian longitudes", () => {
    const spac = BASINS.find((b) => b.id === "spac");
    assert.equal(isOriginInBasin({ lat: -15, lon: 175 }, spac), true);
    assert.equal(isOriginInBasin({ lat: -18, lon: -175 }, spac), true); // 185°E
    assert.equal(isOriginInBasin({ lat: -18, lon: -135 }, spac), true); // 225°E
    assert.equal(isOriginInBasin({ lat: -18, lon: 110 }, spac), false);
    assert.equal(isOriginInBasin({ lat: 15, lon: 175 }, spac), false);
});

test("splitAntimeridianSegment splits ±180 crossings cleanly", () => {
    const p1 = { lat: 10, lon: 178, h: 0 };
    const p2 = { lat: 12, lon: -178, h: 6 };
    const parts = splitAntimeridianSegment(p1, p2);
    assert.equal(parts.length, 2);
    assert.equal(parts[0][0].lon, 178);
    assert.equal(parts[0][1].lon, 180);
    assert.equal(parts[1][0].lon, -180);
    assert.equal(parts[1][1].lon, -178);
    assert.ok(Math.abs(parts[0][1].lat - 11) < 1e-6);
    assert.ok(Math.abs(parts[1][0].lat - 11) < 1e-6);

    const normal = splitAntimeridianSegment({ lat: 10, lon: 125 }, { lat: 11, lon: 126 });
    assert.equal(normal.length, 1);
});

test("hasCorruptJump allows antimeridian crossings but flags teleports", () => {
    assert.equal(
        hasCorruptJump([
            { lat: 10, lon: 179, h: 0 },
            { lat: 10.5, lon: -179, h: 6 },
        ]),
        false
    );
    assert.equal(
        hasCorruptJump([
            { lat: 10, lon: 120, h: 0 },
            { lat: 10, lon: 150, h: 6 }, // > 3000 km in 6h
        ]),
        true
    );
});

test("haversineKm measures across antimeridian accurately", () => {
    const d = haversineKm({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 });
    assert.ok(d > 105 && d < 115, `Expected ~111 km, got ${d}`);
});

test("formatDisturbanceDisplayName integrates stormNaming.js", () => {
    assert.equal(
        formatDisturbanceDisplayName({
            id: 1,
            lat: 14,
            lon: 125,
            pairedTrackName: "25W",
            meanPoints: [{ lat: 14, lon: 125 }],
        }),
        "QUEENIE (Surigae) (25W)"
    );
    assert.equal(
        formatDisturbanceDisplayName({
            id: 2,
            lat: 14,
            lon: 140,
            pairedTrackName: "97W",
        }),
        "Invest 97W"
    );
    assert.equal(
        formatDisturbanceDisplayName({
            id: 3,
            lat: 14,
            lon: 140,
            stormTrackId: "IN-FA",
        }),
        "In-fa"
    );
    assert.equal(formatDisturbanceDisplayName({ id: 4, lat: 14, lon: 140 }), "Disturbance 4");
});

test("analyzeEnsembleData clusters fnv3_large_latest.csv cleanly", () => {
    const largePath = path.join(DATA_DIR, "fnv3_large_latest.csv");
    if (!fs.existsSync(largePath)) return;

    const csvText = fs.readFileSync(largePath, "utf8");
    const res = analyzeEnsembleData({
        csvText,
        datasetId: "large",
        basinId: "wpac",
        horizon: "5day",
        includeCones: false,
    });

    assert.equal(res.allTracks.length, 1000);
    assert.ok(res.disturbances.length >= 1);
    assert.ok(res.disturbances[0].trackCount >= 900);
});

test("windColor and windCategory align with PAGASA thresholds", () => {
    assert.equal(windCategory(185), "Super Typhoon");
    assert.equal(windColor(185), "#FF007F");
    assert.equal(windCategory(120), "Typhoon");
    assert.equal(windCategory(90), "Sev. Tropical Storm");
    assert.equal(windCategory(65), "Tropical Storm");
    assert.equal(windCategory(45), "Tropical Depression");
    assert.equal(windCategory(20), "LPA");
});

test("getDatasetConfig resolves aliases and member limits", () => {
    assert.equal(getDatasetConfig("base").id, "fnv3p2");
    assert.equal(getDatasetConfig("wnv3").id, "oper");
    assert.equal(getDatasetConfig("aifs").totalMembers, 52);
    assert.equal(getDatasetConfig("aigefs").totalMembers, 31);
});

test("analyzeEnsembleData separates sample=-1 embedded mean in AIGEFS", () => {
    const aigefsPath = path.join(DATA_DIR, "aigefs_tc_latest.dat");
    if (!fs.existsSync(aigefsPath)) return;

    const enc = fs.readFileSync(aigefsPath, "utf8");
    const csvText = decodeObfuscatedData(enc, "CalauanWeather2026");

    // CP96 in aigefs_tc_latest.dat starts at 6.4N, -170.9E (CPAC)
    const res = analyzeEnsembleData({
        csvText,
        datasetId: "aigefs",
        basinId: "cpac",
        horizon: "5day",
        includeCones: true,
    });

    assert.ok(res.numMembers <= 31, `Expected <=31 members without sample=-1, got ${res.numMembers}`);
    assert.ok(res.disturbances.length >= 1, "Expected at least 1 CPAC disturbance");
    const cp96 = res.disturbances[0];
    assert.equal(cp96.pairedTrackName, "96C");
    assert.equal(cp96.meanSource, "paired");
    assert.ok(cp96.meanPoints && cp96.meanPoints.length >= 2);
});

test("analyzeEnsembleData processes fnv3p2 + paired CSV consistently", () => {
    const csvPath = path.join(DATA_DIR, "fnv3p2_latest.csv");
    const pairedPath = path.join(DATA_DIR, "fnv3p2_paired_latest.csv");
    if (!fs.existsSync(csvPath) || !fs.existsSync(pairedPath)) return;

    const csvText = fs.readFileSync(csvPath, "utf8");
    const pairedCsvText = fs.readFileSync(pairedPath, "utf8");

    const res = analyzeEnsembleData({
        csvText,
        pairedCsvText,
        datasetId: "fnv3p2",
        basinId: "wpac",
        horizon: "5day",
        includeCones: true,
    });

    assert.ok(res.allTracks.length > 0);
    assert.ok(res.disturbances.length > 0);
    const withMean = res.disturbances.find((d) => d.hasEnsembleMean);
    assert.ok(withMean, "Expected at least one disturbance with ensemble mean");
    assert.ok(withMean.coneGeoJson, "Expected NHC cone GeoJSON geometry");
    assert.ok(withMean.formationDateStr && withMean.formationDateStr !== "Unknown");
});
