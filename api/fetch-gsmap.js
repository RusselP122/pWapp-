// api/fetch-gsmap.js
import zlib from "zlib";
import ftp from "basic-ftp";
import { Writable } from "stream";

// JAXA GSMaP Authorized Credentials
const JAXA_FTP_HOST = "hokusai.eorc.jaxa.jp";
const JAXA_USER = process.env.JAXA_USER || "rainmap";
const JAXA_PASS = process.env.JAXA_PASS || "Niskur+1404";

// Bounding Boxes for 82 Philippine Provinces (Generated from GeoJSON)
const PROVINCE_BOUNDS = {
  "Abra": {
    "minLat": 17.15873,
    "maxLat": 17.978069,
    "minLon": 120.467651,
    "maxLon": 121.122704
  },
  "Agusan del Norte": {
    "minLat": 8.65959,
    "maxLat": 9.455754,
    "minLon": 125.205673,
    "maxLon": 125.767509
  },
  "Agusan del Sur": {
    "minLat": 7.93625,
    "maxLat": 9.23514,
    "minLon": 125.24231,
    "maxLon": 126.360184
  },
  "Aklan": {
    "minLat": 11.31268,
    "maxLat": 11.99909,
    "minLon": 121.843529,
    "maxLon": 122.575546
  },
  "Albay": {
    "minLat": 12.98583,
    "maxLat": 13.52329,
    "minLon": 123.275948,
    "maxLon": 124.219902
  },
  "Antique": {
    "minLat": 10.41339,
    "maxLat": 12.11667,
    "minLon": 121.354156,
    "maxLon": 122.324432
  },
  "Apayao": {
    "minLat": 17.624269,
    "maxLat": 18.54108,
    "minLon": 120.927834,
    "maxLon": 121.48838
  },
  "Aurora": {
    "minLat": 14.99731,
    "maxLat": 16.530121,
    "minLon": 121.281723,
    "maxLon": 122.272217
  },
  "Basilan": {
    "minLat": 6.27847,
    "maxLat": 6.75167,
    "minLon": 121.557953,
    "maxLon": 122.326942
  },
  "Bataan": {
    "minLat": 14.37243,
    "maxLat": 14.92966,
    "minLon": 120.244293,
    "maxLon": 120.611366
  },
  "Batanes": {
    "minLat": 20.260281,
    "maxLat": 20.83411,
    "minLon": 121.781387,
    "maxLon": 122.03598
  },
  "Batangas": {
    "minLat": 13.52583,
    "maxLat": 14.22972,
    "minLon": 120.583893,
    "maxLon": 121.4702
  },
  "Benguet": {
    "minLat": 16.18766,
    "maxLat": 16.934839,
    "minLon": 120.469841,
    "maxLon": 120.905243
  },
  "Biliran": {
    "minLat": 11.4632,
    "maxLat": 11.81356,
    "minLon": 124.294899,
    "maxLon": 124.617363
  },
  "Bohol": {
    "minLat": 9.54587,
    "maxLat": 10.20694,
    "minLon": 123.743271,
    "maxLon": 124.617203
  },
  "Bukidnon": {
    "minLat": 7.40071,
    "maxLat": 8.59437,
    "minLon": 124.495598,
    "maxLon": 125.442909
  },
  "Bulacan": {
    "minLat": 14.691933,
    "maxLat": 15.27246,
    "minLon": 120.663162,
    "maxLon": 121.345367
  },
  "Cagayan": {
    "minLat": 17.508221,
    "maxLat": 19.57398,
    "minLon": 120.961052,
    "maxLon": 122.335281
  },
  "Camarines Norte": {
    "minLat": 13.83713,
    "maxLat": 14.49301,
    "minLon": 122.301659,
    "maxLon": 123.094063
  },
  "Camarines Sur": {
    "minLat": 13.26205,
    "maxLat": 14.07374,
    "minLon": 122.548309,
    "maxLon": 123.975166
  },
  "Camiguin": {
    "minLat": 9.07843,
    "maxLat": 9.25738,
    "minLon": 124.633904,
    "maxLon": 124.806618
  },
  "Capiz": {
    "minLat": 11.1406,
    "maxLat": 11.61028,
    "minLon": 122.200073,
    "maxLon": 123.097076
  },
  "Catanduanes": {
    "minLat": 13.51893,
    "maxLat": 14.09902,
    "minLon": 124.03611,
    "maxLon": 124.421173
  },
  "Cavite": {
    "minLat": 14.06133,
    "maxLat": 14.49222,
    "minLon": 120.621246,
    "maxLon": 121.068817
  },
  "Cebu": {
    "minLat": 9.41233,
    "maxLat": 11.30056,
    "minLon": 123.296677,
    "maxLon": 124.56472
  },
  "Compostela Valley": {
    "minLat": 7.07435,
    "maxLat": 8.00002,
    "minLon": 125.67524,
    "maxLon": 126.2957
  },
  "Davao del Norte": {
    "minLat": 6.89595,
    "maxLat": 7.99817,
    "minLon": 125.250427,
    "maxLon": 125.941116
  },
  "Davao del Sur": {
    "minLat": 5.36667,
    "maxLat": 7.56806,
    "minLon": 125.100563,
    "maxLon": 125.714622
  },
  "Davao Oriental": {
    "minLat": 6.33155,
    "maxLat": 8.00093,
    "minLon": 125.942436,
    "maxLon": 126.60083
  },
  "Dinagat Islands": {
    "minLat": 9.8525,
    "maxLat": 10.47186,
    "minLon": 125.463608,
    "maxLon": 125.706238
  },
  "Eastern Samar": {
    "minLat": 10.68722,
    "maxLat": 12.37158,
    "minLon": 125.113022,
    "maxLon": 125.830833
  },
  "Guimaras": {
    "minLat": 10.40611,
    "maxLat": 10.75354,
    "minLon": 122.475517,
    "maxLon": 122.725777
  },
  "Ifugao": {
    "minLat": 16.595869,
    "maxLat": 17.07999,
    "minLon": 120.879089,
    "maxLon": 121.591141
  },
  "Ilocos Norte": {
    "minLat": 17.703739,
    "maxLat": 18.64806,
    "minLon": 120.440277,
    "maxLon": 120.979263
  },
  "Ilocos Sur": {
    "minLat": 16.659241,
    "maxLat": 17.902651,
    "minLon": 120.343987,
    "maxLon": 120.858276
  },
  "Iloilo": {
    "minLat": 10.46708,
    "maxLat": 11.59639,
    "minLon": 122.011124,
    "maxLon": 123.357094
  },
  "Isabela": {
    "minLat": 16.38982,
    "maxLat": 17.548149,
    "minLon": 121.335007,
    "maxLon": 122.528893
  },
  "Kalinga": {
    "minLat": 17.168171,
    "maxLat": 17.68977,
    "minLon": 120.914787,
    "maxLon": 121.67498
  },
  "La Union": {
    "minLat": 16.208349,
    "maxLat": 16.92057,
    "minLon": 120.297791,
    "maxLon": 120.580437
  },
  "Laguna": {
    "minLat": 13.96465,
    "maxLat": 14.57583,
    "minLon": 121.008873,
    "maxLon": 121.630508
  },
  "Lanao del Norte": {
    "minLat": 7.69419,
    "maxLat": 8.34055,
    "minLon": 123.621193,
    "maxLon": 124.575073
  },
  "Lanao del Sur": {
    "minLat": 7.40917,
    "maxLat": 8.21221,
    "minLon": 123.815361,
    "maxLon": 124.80674
  },
  "Leyte": {
    "minLat": 10.18533,
    "maxLat": 11.56236,
    "minLon": 124.285629,
    "maxLon": 125.149437
  },
  "Maguindanao": {
    "minLat": 6.64957,
    "maxLat": 7.25982,
    "minLon": 124.082993,
    "maxLon": 125.0037
  },
  "Marinduque": {
    "minLat": 13.20197,
    "maxLat": 13.57067,
    "minLon": 121.810562,
    "maxLon": 122.150589
  },
  "Masbate": {
    "minLat": 11.72039,
    "maxLat": 13.15886,
    "minLon": 122.931679,
    "maxLon": 124.07444
  },
  "Metropolitan Manila": {
    "minLat": 14.350261,
    "maxLat": 14.776991,
    "minLon": 120.916946,
    "maxLon": 121.131721
  },
  "Misamis Occidental": {
    "minLat": 8.01389,
    "maxLat": 8.67022,
    "minLon": 123.549568,
    "maxLon": 123.868729
  },
  "Misamis Oriental": {
    "minLat": 8.2352,
    "maxLat": 9.09255,
    "minLon": 124.245552,
    "maxLon": 125.25338
  },
  "Mountain Province": {
    "minLat": 16.82756,
    "maxLat": 17.30442,
    "minLon": 120.774338,
    "maxLon": 121.562363
  },
  "Negros Occidental": {
    "minLat": 9.42013,
    "maxLat": 11.00361,
    "minLon": 122.379997,
    "maxLon": 123.568031
  },
  "Negros Oriental": {
    "minLat": 9.03818,
    "maxLat": 10.41343,
    "minLon": 122.613457,
    "maxLon": 123.336014
  },
  "North Cotabato": {
    "minLat": 6.72055,
    "maxLat": 7.68187,
    "minLon": 124.328743,
    "maxLon": 125.312286
  },
  "Northern Samar": {
    "minLat": 12.13891,
    "maxLat": 12.69448,
    "minLon": 124.13311,
    "maxLon": 125.324173
  },
  "Nueva Ecija": {
    "minLat": 15.16823,
    "maxLat": 16.12756,
    "minLon": 120.612808,
    "maxLon": 121.376213
  },
  "Nueva Vizcaya": {
    "minLat": 15.77052,
    "maxLat": 16.747271,
    "minLon": 120.75901,
    "maxLon": 121.467644
  },
  "Occidental Mindoro": {
    "minLat": 12.15278,
    "maxLat": 13.89928,
    "minLon": 120.017776,
    "maxLon": 121.246193
  },
  "Oriental Mindoro": {
    "minLat": 12.20899,
    "maxLat": 13.51068,
    "minLon": 120.797234,
    "maxLon": 121.557114
  },
  "Palawan": {
    "minLat": 7.80417,
    "maxLat": 12.3278,
    "minLon": 116.94278,
    "maxLon": 121.077766
  },
  "Pampanga": {
    "minLat": 14.76806,
    "maxLat": 15.2716,
    "minLon": 120.35833,
    "maxLon": 120.987068
  },
  "Pangasinan": {
    "minLat": 15.61848,
    "maxLat": 16.426941,
    "minLon": 119.749527,
    "maxLon": 120.922333
  },
  "Quezon": {
    "minLat": 13.16232,
    "maxLat": 15.21522,
    "minLon": 121.237396,
    "maxLon": 122.792572
  },
  "Quirino": {
    "minLat": 15.91659,
    "maxLat": 16.641529,
    "minLon": 121.293709,
    "maxLon": 122.13166
  },
  "Rizal": {
    "minLat": 14.29061,
    "maxLat": 14.89227,
    "minLon": 121.093407,
    "maxLon": 121.469803
  },
  "Romblon": {
    "minLat": 12.03139,
    "maxLat": 12.96167,
    "minLon": 121.685547,
    "maxLon": 122.699173
  },
  "Samar": {
    "minLat": 11.08569,
    "maxLat": 12.33532,
    "minLon": 124.145348,
    "maxLon": 125.306557
  },
  "Sarangani": {
    "minLat": 5.56896,
    "maxLat": 6.46952,
    "minLon": 124.352119,
    "maxLon": 125.534111
  },
  "Shariff Kabunsuan": {
    "minLat": 6.74976,
    "maxLat": 7.65203,
    "minLon": 123.953888,
    "maxLon": 124.506371
  },
  "Siquijor": {
    "minLat": 9.09456,
    "maxLat": 9.30056,
    "minLon": 123.455994,
    "maxLon": 123.699409
  },
  "Sorsogon": {
    "minLat": 12.53278,
    "maxLat": 13.1181,
    "minLon": 123.480423,
    "maxLon": 124.199074
  },
  "South Cotabato": {
    "minLat": 5.95476,
    "maxLat": 6.67099,
    "minLon": 124.280937,
    "maxLon": 125.272583
  },
  "Southern Leyte": {
    "minLat": 9.9125,
    "maxLat": 10.62223,
    "minLon": 124.757568,
    "maxLon": 125.296112
  },
  "Sultan Kudarat": {
    "minLat": 6.11361,
    "maxLat": 6.88278,
    "minLon": 124.016113,
    "maxLon": 125.19677
  },
  "Sulu": {
    "minLat": 5.458135,
    "maxLat": 6.43806,
    "minLon": 120.089668,
    "maxLon": 121.911049
  },
  "Surigao del Norte": {
    "minLat": 9.32456,
    "maxLat": 10.06389,
    "minLon": 125.39222,
    "maxLon": 126.163681
  },
  "Surigao del Sur": {
    "minLat": 7.910173,
    "maxLat": 9.49515,
    "minLon": 125.744873,
    "maxLon": 126.456108
  },
  "Tarlac": {
    "minLat": 15.16776,
    "maxLat": 15.88911,
    "minLon": 120.163239,
    "maxLon": 120.78196
  },
  "Tawi-Tawi": {
    "minLat": 4.64889,
    "maxLat": 7.04944,
    "minLon": 118.416946,
    "maxLon": 120.607071
  },
  "Zambales": {
    "minLat": 14.73778,
    "maxLat": 15.84526,
    "minLon": 119.86866,
    "maxLon": 120.460617
  },
  "Zamboanga del Norte": {
    "minLat": 7.14597,
    "maxLat": 8.72769,
    "minLon": 121.90139,
    "maxLon": 123.554947
  },
  "Zamboanga del Sur": {
    "minLat": 6.88755,
    "maxLat": 8.23939,
    "minLon": 121.897217,
    "maxLon": 123.670387
  },
  "Zamboanga Sibugay": {
    "minLat": 7.27722,
    "maxLat": 7.9434,
    "minLon": 122.218697,
    "maxLon": 123.097527
  }
};

/**
 * Extracts max IEEE 754 float32 rainfall rate (mm/hr) within a bounding box
 * GSMaP grid: 3600 columns x 1800 rows (0.1 degree resolution, 60N to 60S, 0E to 360E)
 */
function readGsmapRawBinaryValue(binaryBuffer, bounds) {
  if (!binaryBuffer || binaryBuffer.length < 3600 * 1200 * 4) {
    return 0;
  }

  // Row index from latitude (60.0N = row 0, 60.0S = row 1200)
  const minRow = Math.max(0, Math.floor((60.0 - bounds.maxLat) / 0.1));
  const maxRow = Math.min(1199, Math.floor((60.0 - bounds.minLat) / 0.1));

  // Column index from longitude (0.0E = col 0, 360.0E = col 3600)
  const minLon = (bounds.minLon + 360) % 360;
  const maxLon = (bounds.maxLon + 360) % 360;
  
  const minCol = Math.max(0, Math.floor(minLon / 0.1));
  const maxCol = Math.min(3599, Math.floor(maxLon / 0.1));

  let maxRain = 0;

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      const byteOffset = (r * 3600 + c) * 4;
      if (byteOffset + 4 <= binaryBuffer.length) {
        const val = binaryBuffer.readFloatLE(byteOffset);
        if (val > maxRain && val < 1000) {
          maxRain = val;
        }
      }
    }
  }

  return maxRain;
}

export default async function handler(req, res) {
  try {
    const now = new Date();

    const timeSteps = [
      { label: "Latest (Now)", offsetHours: 0 },
      { label: "1 Hour Ago", offsetHours: 1 },
      { label: "2 Hours Ago", offsetHours: 2 },
      { label: "3 Hours Ago", offsetHours: 3 },
      { label: "6 Hours Ago", offsetHours: 6 },
    ];

    const frames = timeSteps.map(step => {
      const targetTime = new Date(now.getTime() - step.offsetHours * 3600 * 1000);
      const isoDate = targetTime.toISOString().split("T")[0];
      const formattedTime = targetTime.toLocaleTimeString("en-US", {
        timeZone: "Asia/Manila",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
      }) + " PHT";

      return {
        label: step.label,
        offsetHours: step.offsetHours,
        date: isoDate,
        formattedTime,
        isoString: targetTime.toISOString(),
        tileUrl: `https://gibs-{s}.earthdata.nasa.gov/wmts/epsg3857/best/GPM_3IMERGHHE/default/${isoDate}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`,
        provinces: {} // Will be populated below
      };
    });

    let dataSource = `JAXA GSMaP (${JAXA_FTP_HOST})`;
    let latestFileName = "None";

    const client = new ftp.Client();
    try {
      await client.access({
        host: JAXA_FTP_HOST,
        user: JAXA_USER,
        password: JAXA_PASS,
        secure: false
      });

      const list = await client.list("now/latest");
      const gsmapFiles = list
        .map(f => f.name)
        .filter(n => /^gsmap_now\.\d{8}\.\d{4}\.dat\.gz$/.test(n))
        .sort();

      if (gsmapFiles.length > 0) {
        latestFileName = gsmapFiles[gsmapFiles.length - 1];
        
        // Fetch historical data for each frame sequentially
        for (const frame of frames) {
            // Find corresponding file (approx 1 file per hour)
            const fileIndex = Math.max(0, gsmapFiles.length - 1 - frame.offsetHours);
            const targetFile = gsmapFiles[fileIndex];
            
            if (!targetFile) continue;
            
            const chunks = [];
            const writable = new Writable({
              write(chunk, encoding, callback) {
                chunks.push(chunk);
                callback();
              }
            });

            await client.downloadTo(writable, `now/latest/${targetFile}`);
            const compressedBuffer = Buffer.concat(chunks);
            const rawBinaryBuffer = zlib.gunzipSync(compressedBuffer);
            
            Object.entries(PROVINCE_BOUNDS).forEach(([provName, bounds]) => {
              const rainVal = readGsmapRawBinaryValue(rawBinaryBuffer, bounds);
              frame.provinces[provName] = {
                rainfall: Math.round(rainVal * 10) / 10,
                rainfall_mm: Math.round(rainVal * 10) / 10,
                current_rate: rainVal,
                source: dataSource
              };
            });
        }
      }
    } catch (binErr) {
      console.warn("JAXA GSMaP FTP fetch note:", binErr.message);
    } finally {
      client.close();
    }

    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=600');

    // To maintain compatibility, we also provide the latest frame's provinces at the root
    const latestProvinces = frames[0].provinces || {};

    return res.status(200).json({
      success: true,
      message: "JAXA GSMaP Raw Binary precipitation extracted successfully",
      timestamp: now.toISOString(),
      user: JAXA_USER,
      ftp_host: JAXA_FTP_HOST,
      file_processed: latestFileName,
      provider: `JAXA GSMaP (${JAXA_FTP_HOST})`,
      dataType: "4-byte float32 plain binary (3600x1800 grid)",
      bounds: [
        [-60, 80],
        [60, 160]
      ],
      attribution: "JAXA Global Rainfall Watch Data",
      frames,
      provinces: latestProvinces
    });
  } catch (error) {
    console.error("Error in api/fetch-gsmap.js:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to parse JAXA P-Tree Raw Binary data"
    });
  }
}
