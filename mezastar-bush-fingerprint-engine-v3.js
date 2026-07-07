/* ============================================================
   MEZASTAR BUSH IDENTIFIER V3
   Browser landmark fingerprint matcher for noisy arcades
   Drop-in replacement for the old MEL + DTW matching engine.

   Keeps your existing:
   - bushAudioBlob
   - db Supabase client
   - bushResult / bushResultText / analyzeBushBtn elements
   - decodeAudioBlob(blob) if already defined

   Reference source:
   pokemon_cry_references(id, pokemon_name, audio_url, storage_path, verified)
============================================================ */

const BUSH_FP_CFG = {
  fftSize: 2048,
  hopSize: 256,

  minHz: 300,
  maxHz: 9000,

  freqNeighborhood: 4,
  timeNeighborhood: 3,
  maxPeaksPerFrame: 5,
  minPeakDbAboveFloor: 7.0,

  fanOut: 7,
  pairMinFrames: 2,
  pairMaxFrames: 48,

  /* Real-frequency quantization */
  freqBinHz: 80,

  /* Real-time quantization */
  deltaTimeBinSeconds: 0.02,

  noiseSeconds: 0.45,
  maxRecordingSeconds: 8,

  /* Match alignment now uses seconds */
  offsetBinSeconds: 0.02,

  /* Stronger rejection of random arcade collisions */
  minAlignedVotes: 8,
  minUniqueHashes: 7,

  /* Final result rejection */
  minFinalScore: 0.38,
  minWinnerGap: 0.06,

  topResults: 5,
  verifyTopCandidates: 8
};

let bushFingerprintReferenceCache = null;
let bushFingerprintIndexCache = null;
let bushFingerprintBuildPromise = null;

/* ---------------- MAIN ANALYSIS ---------------- */

async function analyzeBushSound() {
  if (!bushAudioBlob) {
    alert("Record the bush sound first.");
    return;
  }

  const result = document.getElementById("bushResult");
  const text = document.getElementById("bushResultText");
  const analyzeBtn = document.getElementById("analyzeBushBtn");

  result.style.display = "block";
  analyzeBtn.disabled = true;

  try {
    text.innerHTML = statusHtml(
      "🔍 Cleaning arcade noise...",
      "Decoding the recording and finding stable spectral landmarks..."
    );

    const recordedBuffer = await decodeBushAudioBlobV3(bushAudioBlob);
    const recording = extractBushFingerprint(recordedBuffer, true);

    if (recording.landmarks.length < 4) {
      throw new Error(
        "Not enough stable sound landmarks were detected. Record closer to the machine speaker and start just before the cry."
      );
    }

    text.innerHTML = statusHtml(
      "🔍 Preparing cry fingerprint index...",
      "The first analysis may take longer because reference fingerprints are being cached."
    );

    const indexPack = await getBushFingerprintIndex(text);

    text.innerHTML = statusHtml(
      "🔍 Matching fingerprints...",
      `${recording.landmarks.length} live landmarks detected.`
    );

    let matches = matchBushFingerprint(
      recording.landmarks,
      indexPack.index,
      indexPack.references
    );

    if (!matches.length) {
      showBushFingerprintResults([]);
      return;
    }

    // Secondary verification improves rejection of accidental hash collisions.
    text.innerHTML = statusHtml(
      "🔍 Verifying strongest candidates...",
      "Checking time alignment and spectral consistency..."
    );

    matches = verifyBushCandidates(
      matches,
      recording,
      indexPack.referenceFingerprints
    );

    showBushFingerprintResults(matches.slice(0, BUSH_FP_CFG.topResults));
  } catch (error) {
    console.error("Bush fingerprint analysis error:", error);
    text.innerHTML = `
      <strong style="color:#f87171">Analysis failed</strong>
      <br><br>
      <span style="color:#cbd5e1">${escapeBushHtmlV3(error.message || "Unknown analysis error.")}</span>
    `;
  } finally {
    analyzeBtn.disabled = false;
  }
}

/* ---------------- REFERENCE INDEX ---------------- */

async function loadBushFingerprintReferences() {
  if (bushFingerprintReferenceCache) return bushFingerprintReferenceCache;

  const { data, error } = await db
    .from("pokemon_cry_references")
    .select("id,pokemon_name,audio_url,storage_path,verified")
    .order("id");

  if (error) throw error;

  bushFingerprintReferenceCache = (data || []).filter(
    x => x.audio_url
  );

  return bushFingerprintReferenceCache;
}

async function getBushFingerprintIndex(textElement) {
  if (bushFingerprintIndexCache) return bushFingerprintIndexCache;
  if (bushFingerprintBuildPromise) return bushFingerprintBuildPromise;

  bushFingerprintBuildPromise = (async () => {
    const references = await loadBushFingerprintReferences();

    if (!references.length) {
      throw new Error("No cry references found in Supabase.");
    }

    const index = new Map();
    const referenceFingerprints = new Map();

    for (let i = 0; i < references.length; i++) {
      const ref = references[i];

      if (textElement) {
        textElement.innerHTML = statusHtml(
          "🔍 Building cry fingerprint index...",
          `${i + 1} / ${references.length}<br>${escapeBushHtmlV3(ref.pokemon_name)}`
        );
      }

      try {
        const fp = await getOneReferenceFingerprint(ref);
        referenceFingerprints.set(ref.id, fp);

        for (const landmark of fp.landmarks) {
          let postings = index.get(landmark.hash);

          if (!postings) {
            postings = [];
            index.set(landmark.hash, postings);
          }

         postings.push({
  referenceId: ref.id,
  referenceTime: landmark.anchorTime
});
        }
      } catch (error) {
        console.warn("Reference skipped:", ref.storage_path || ref.audio_url, error);
      }
    }

    bushFingerprintIndexCache = {
      index,
      references,
      referenceFingerprints
    };

    return bushFingerprintIndexCache;
  })();

  try {
    return await bushFingerprintBuildPromise;
  } finally {
    bushFingerprintBuildPromise = null;
  }
}

async function getOneReferenceFingerprint(ref) {
  const cacheKey = "mezastarBushFpV3:" + (ref.storage_path || ref.audio_url);

  // In-memory cache first.
  if (!window.__bushOneFpCache) window.__bushOneFpCache = new Map();
  if (window.__bushOneFpCache.has(cacheKey)) {
    return window.__bushOneFpCache.get(cacheKey);
  }

  const response = await fetch(ref.audio_url, { cache: "force-cache" });

  if (!response.ok) {
    throw new Error(`Could not load ${ref.storage_path || ref.audio_url}`);
  }

  const blob = await response.blob();
  const audioBuffer = await decodeBushAudioBlobV3(blob);
  const fp = extractBushFingerprint(audioBuffer, false);

  window.__bushOneFpCache.set(cacheKey, fp);
  return fp;
}

/* ---------------- FEATURE / FINGERPRINT EXTRACTION ---------------- */

function extractBushFingerprint(audioBuffer, isRecording) {
  let samples = convertBushToMonoV3(audioBuffer);
  const sampleRate = audioBuffer.sampleRate;

  // Hard cap protects phones from oversized recordings.
  const maxSamples = Math.floor(
    sampleRate * BUSH_FP_CFG.maxRecordingSeconds
  );

  if (samples.length > maxSamples) {
    samples = samples.slice(0, maxSamples);
  }

  // DC removal.
  samples = removeBushDC(samples);

  // Pre-emphasis suppresses low rumble and strengthens transients.
  samples = preEmphasizeBush(samples, 0.97);

  const spectrogram = createBushLogSpectrogram(samples, sampleRate);

  if (!spectrogram.frames.length) {
    return { landmarks: [], peaks: [], frameVectors: [] };
  }

  const cleaned = isRecording
    ? suppressBushStationaryNoise(spectrogram, sampleRate)
    : spectrogram;

  const peaks = pickBushConstellationPeaks(cleaned);
const landmarks = createBushLandmarks(
  peaks,
  sampleRate
);
  return {
    landmarks,
    peaks,
    frameVectors: cleaned.frames,
    sampleRate,
    hopSize: BUSH_FP_CFG.hopSize
  };
}

function createBushLogSpectrogram(samples, sampleRate) {
  const N = BUSH_FP_CFG.fftSize;
  const H = BUSH_FP_CFG.hopSize;
  const window = createBushHannWindowV3(N);

  const minBin = Math.max(
    1,
    Math.floor(BUSH_FP_CFG.minHz * N / sampleRate)
  );

  const maxBin = Math.min(
    N / 2 - 1,
    Math.ceil(BUSH_FP_CFG.maxHz * N / sampleRate)
  );

  const frames = [];

  for (let start = 0; start + N <= samples.length; start += H) {
    const frame = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      frame[i] = samples[start + i] * window[i];
    }

    const magnitude = calculateBushMagnitudeSpectrumV3(frame);
    const useful = new Float32Array(maxBin - minBin + 1);

    for (let bin = minBin; bin <= maxBin; bin++) {
      // dB-like compression.
      useful[bin - minBin] = 20 * Math.log10(magnitude[bin] + 1e-8);
    }

    frames.push(useful);
  }

  return { frames, minBin, maxBin, sampleRate };
}

function suppressBushStationaryNoise(spec, sampleRate) {
  const frames = spec.frames;
  const bandCount = frames[0].length;

  const noiseFrameCount = Math.max(
    1,
    Math.min(
      frames.length,
      Math.floor(
        BUSH_FP_CFG.noiseSeconds * sampleRate / BUSH_FP_CFG.hopSize
      )
    )
  );

  const floor = new Float32Array(bandCount);

  // Median of initial frames is more robust than mean.
  for (let b = 0; b < bandCount; b++) {
    const values = [];

    for (let t = 0; t < noiseFrameCount; t++) {
      values.push(frames[t][b]);
    }

    values.sort((a, b2) => a - b2);
    floor[b] = values[Math.floor(values.length / 2)];
  }

  const cleanedFrames = frames.map(frame => {
    const out = new Float32Array(bandCount);

    for (let b = 0; b < bandCount; b++) {
      // Positive spectral excess above stationary background.
      out[b] = Math.max(0, frame[b] - floor[b]);
    }

    return out;
  });

  return { ...spec, frames: cleanedFrames };
}

function pickBushConstellationPeaks(spec) {
  const frames = spec.frames;
  const peaks = [];

  if (frames.length < 3) return peaks;

  const F = BUSH_FP_CFG.freqNeighborhood;
  const T = BUSH_FP_CFG.timeNeighborhood;

  for (let t = T; t < frames.length - T; t++) {
    const candidates = [];
    const current = frames[t];

    // Adaptive per-frame floor.
    const sorted = Array.from(current).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length * 0.50)] || 0;
    const p75 = sorted[Math.floor(sorted.length * 0.75)] || median;
    const threshold = Math.max(
      median + BUSH_FP_CFG.minPeakDbAboveFloor,
      p75
    );

    for (let f = F; f < current.length - F; f++) {
      const value = current[f];
      if (value < threshold) continue;

      let isLocalMax = true;

      outer:
      for (let dt = -T; dt <= T; dt++) {
        const row = frames[t + dt];

        for (let df = -F; df <= F; df++) {
          if (dt === 0 && df === 0) continue;

          if (row[f + df] > value) {
            isLocalMax = false;
            break outer;
          }
        }
      }

      if (isLocalMax) {
        candidates.push({
          frame: t,
          bin: f + spec.minBin,
          strength: value
        });
      }
    }

    candidates
      .sort((a, b) => b.strength - a.strength)
      .slice(0, BUSH_FP_CFG.maxPeaksPerFrame)
      .forEach(p => peaks.push(p));
  }

  return peaks.sort((a, b) =>
    a.frame - b.frame || a.bin - b.bin
  );
}

function createBushLandmarks(peaks, sampleRate) {

  const landmarks = [];

  for (let i = 0; i < peaks.length; i++) {

    const anchor = peaks[i];
    let paired = 0;

    for (let j = i + 1; j < peaks.length; j++) {

      const target = peaks[j];

      const dtFrames =
        target.frame - anchor.frame;

      if (
        dtFrames <
        BUSH_FP_CFG.pairMinFrames
      ) {
        continue;
      }

      if (
        dtFrames >
        BUSH_FP_CFG.pairMaxFrames
      ) {
        break;
      }

      /*
        Convert FFT bin to actual Hz.

        This fixes matching between:
        - APK/reference audio
        - Android microphone audio
        - different sample rates
      */

      const anchorHz =
        anchor.bin *
        sampleRate /
        BUSH_FP_CFG.fftSize;

      const targetHz =
        target.bin *
        sampleRate /
        BUSH_FP_CFG.fftSize;

      /*
        Convert frame difference
        to actual elapsed seconds.
      */

      const deltaSeconds =
        dtFrames *
        BUSH_FP_CFG.hopSize /
        sampleRate;

      const hash =
        makeBushHash(
          anchorHz,
          targetHz,
          deltaSeconds
        );

      landmarks.push({
        hash,

        /*
          Keep frame for compatibility
        */
        anchorFrame: anchor.frame,

        /*
          New real-time anchor
        */
        anchorTime:
          anchor.frame *
          BUSH_FP_CFG.hopSize /
          sampleRate
      });

      paired++;

      if (
        paired >=
        BUSH_FP_CFG.fanOut
      ) {
        break;
      }
    }
  }

  return landmarks;
}

function makeBushHash(
  anchorHz,
  targetHz,
  deltaSeconds
) {

  const q1 =
    Math.round(
      anchorHz /
      BUSH_FP_CFG.freqBinHz
    );

  const q2 =
    Math.round(
      targetHz /
      BUSH_FP_CFG.freqBinHz
    );

  const qdt =
    Math.round(
      deltaSeconds /
      BUSH_FP_CFG.deltaTimeBinSeconds
    );

  return `${q1}|${q2}|${qdt}`;
}


/* ---------------- MATCHING ---------------- */

function matchBushFingerprint(
  recordedLandmarks,
  index,
  references
) {

  const candidateOffsets =
    new Map();

  /*
    IMPORTANT FIX:

    Unique hashes must be tracked
    per reference AND per aligned offset.

    The old engine counted hashes across
    unrelated offsets, allowing weak
    candidates such as Lugia to accumulate
    false support.
  */

  const candidateUniqueHashes =
    new Map();

  for (const live of recordedLandmarks) {

    const postings =
      index.get(live.hash);

    if (!postings) {
      continue;
    }

    for (const posting of postings) {

      /*
        Compare real seconds,
        not raw frame numbers.
      */

      const offset =
        posting.referenceTime -
        live.anchorTime;

      const offsetBin =
        Math.round(
          offset /
          BUSH_FP_CFG.offsetBinSeconds
        );

      const key =
        `${posting.referenceId}|${offsetBin}`;

      candidateOffsets.set(
        key,
        (candidateOffsets.get(key) || 0) + 1
      );

      let unique =
        candidateUniqueHashes.get(key);

      if (!unique) {

        unique = new Set();

        candidateUniqueHashes.set(
          key,
          unique
        );
      }

      unique.add(live.hash);
    }
  }

  const bestByReference =
    new Map();

  for (
    const [key, votes]
    of candidateOffsets.entries()
  ) {

    const splitAt =
      key.indexOf("|");

    const referenceId =
      Number(
        key.slice(0, splitAt)
      );

    const offsetBin =
      Number(
        key.slice(splitAt + 1)
      );

    const uniqueHashes =
      candidateUniqueHashes
        .get(key)?.size || 0;

    const old =
      bestByReference.get(
        referenceId
      );

    if (
      !old ||
      votes > old.alignedVotes ||
      (
        votes === old.alignedVotes &&
        uniqueHashes > old.uniqueHashes
      )
    ) {

      bestByReference.set(
        referenceId,
        {
          referenceId,
          alignedVotes: votes,
          offsetBin,
          uniqueHashes
        }
      );
    }
  }

  const refMap =
    new Map(
      references.map(
        r => [r.id, r]
      )
    );

  const totalLive =
    Math.max(
      1,
      recordedLandmarks.length
    );

  return Array
    .from(
      bestByReference.values()
    )
    .map(match => {

      const ref =
        refMap.get(
          match.referenceId
        );

      const voteRatio =
        match.alignedVotes /
        totalLive;

      const uniqueSupport =
        Math.min(
          1,
          match.uniqueHashes / 18
        );

      const rawScore =
        0.72 *
        Math.min(
          1,
          voteRatio * 7.5
        )
        +
        0.28 *
        uniqueSupport;

      return {
        ...match,

        pokemon_name:
          ref?.pokemon_name ||
          "Unknown",

        score: rawScore
      };
    })
    .filter(match =>
      match.alignedVotes >=
        BUSH_FP_CFG.minAlignedVotes
      &&
      match.uniqueHashes >=
        BUSH_FP_CFG.minUniqueHashes
    )
    .sort((a, b) =>
      b.score - a.score
      ||
      b.alignedVotes -
      a.alignedVotes
      ||
      b.uniqueHashes -
      a.uniqueHashes
    );
}
function verifyBushCandidates(
  matches,
  recording,
  referenceFingerprints
) {

  return matches
    .slice(
      0,
      BUSH_FP_CFG.verifyTopCandidates
    )
    .map(match => {

      const refFp =
        referenceFingerprints.get(
          match.referenceId
        );

      if (!refFp) {
        return match;
      }

      /*
        Offset is now stored in
        quantized seconds.
      */

      const offsetSeconds =
        match.offsetBin *
        BUSH_FP_CFG.offsetBinSeconds;

      /*
        Convert seconds into the
        reference fingerprint frame scale
        only for peak consistency.
      */

      const offsetFrames =
        Math.round(
          offsetSeconds *
          refFp.sampleRate /
          refFp.hopSize
        );

      const consistency =
        calculateBushPeakConsistency(
          recording.peaks,
          refFp.peaks,
          offsetFrames,
          recording.sampleRate,
          refFp.sampleRate
        );

      const verifiedScore =
        0.78 * match.score +
        0.22 * consistency;

      return {
        ...match,
        consistency,

        score:
          Math.max(
            0,
            Math.min(
              1,
              verifiedScore
            )
          )
      };
    })
    .sort((a, b) =>
      b.score - a.score
      ||
      b.alignedVotes -
      a.alignedVotes
    );
}

function calculateBushPeakConsistency(
  livePeaks,
  refPeaks,
  offsetFrames,
  liveSampleRate,
  refSampleRate
) {

  if (
    !livePeaks.length ||
    !refPeaks.length
  ) {
    return 0;
  }

  const refByFrame =
    new Map();

  for (const p of refPeaks) {

    let list =
      refByFrame.get(p.frame);

    if (!list) {

      list = [];

      refByFrame.set(
        p.frame,
        list
      );
    }

    /*
      Store real Hz,
      not raw FFT bin.
    */

    list.push(
      p.bin *
      refSampleRate /
      BUSH_FP_CFG.fftSize
    );
  }

  let checked = 0;
  let matched = 0;

  for (const live of livePeaks) {

    /*
      Convert live frame to seconds,
      then into reference frame scale.
    */

    const liveTime =
      live.frame *
      BUSH_FP_CFG.hopSize /
      liveSampleRate;

    const expectedFrame =
      Math.round(
        liveTime *
        refSampleRate /
        BUSH_FP_CFG.hopSize
      )
      +
      offsetFrames;

    const liveHz =
      live.bin *
      liveSampleRate /
      BUSH_FP_CFG.fftSize;

    let found = false;

    for (
      let dt = -2;
      dt <= 2 && !found;
      dt++
    ) {

      const frequencies =
        refByFrame.get(
          expectedFrame + dt
        );

      if (!frequencies) {
        continue;
      }

      for (
        const refHz
        of frequencies
      ) {

        /*
          Allow modest frequency drift
          from speaker + microphone.
        */

        if (
          Math.abs(
            refHz - liveHz
          ) <= 140
        ) {

          found = true;
          break;
        }
      }
    }

    checked++;

    if (found) {
      matched++;
    }
  }

  return checked
    ? matched / checked
    : 0;
}

/* ---------------- RESULTS ---------------- */

function showBushFingerprintResults(matches) {
  const text = document.getElementById("bushResultText");

  if (!matches.length) {
    text.innerHTML = `
      <strong>No reliable fingerprint match found.</strong>
      <br><br>
      <span style="color:#94a3b8">
        Try again with the phone closer to the Mezastar speaker.
        Start recording just before the bush cry begins.
      </span>
    `;
    return;
  }

  const first = matches[0];
  const second = matches[1];

  const gap = second ? first.score - second.score : first.score;
/*
  HARD REJECTION:

  Do not present the top Pokémon
  when evidence is weak.
*/

if (
  first.score <
    BUSH_FP_CFG.minFinalScore
  ||
  first.alignedVotes <
    BUSH_FP_CFG.minAlignedVotes
  ||
  first.uniqueHashes <
    BUSH_FP_CFG.minUniqueHashes
  ||
  (
    second &&
    gap <
      BUSH_FP_CFG.minWinnerGap
  )
) {

  const percent =
    Math.round(
      first.score * 100
    );

  text.innerHTML = `
    <div style="
      padding:14px;
      border-radius:10px;
      background:#451a03;
      border:1px solid #f59e0b;
    ">

      <strong>
        ⚠️ No reliable match
      </strong>

      <br><br>

      <span style="
        color:#cbd5e1;
      ">
        Strongest candidate:
        ${escapeBushHtmlV3(
          first.pokemon_name
        )}
        (${percent}% similarity)
      </span>

      <br><br>

      <span style="
        color:#94a3b8;
        font-size:12px;
      ">
        The fingerprint evidence was
        too weak or too close to another
        candidate. Record again closer
        to the machine speaker.
      </span>

    </div>
  `;

  return;
}
 const uncertain =
  first.score < 0.50 ||
  (second && gap < 0.10);

  let html = `
    <div style="
      margin-bottom:14px;
      padding:10px 12px;
      border-radius:10px;
      background:${uncertain ? "#451a03" : "#052e16"};
      border:1px solid ${uncertain ? "#f59e0b" : "#22c55e"};
    ">
      <strong>${uncertain ? "⚠️ Uncertain Match" : "✅ Likely Match"}</strong>
      <br>
      <span style="font-size:12px;color:#cbd5e1">
        ${
          uncertain
            ? "Fingerprint support is weak or the top results are close. Try another recording."
            : "Stable time-aligned sound landmarks support the top result."
        }
      </span>
    </div>
  `;

  matches.forEach((match, index) => {
    const percent = Math.round(match.score * 100);

    html += `
      <div style="padding:12px 0;border-bottom:1px solid #334155">
        <div style="
          display:flex;
          justify-content:space-between;
          gap:15px;
          align-items:center;
        ">
          <strong>
            ${index + 1}. ${escapeBushHtmlV3(match.pokemon_name)}
          </strong>

          <span style="
            font-size:18px;
            font-weight:bold;
            color:${index === 0 ? "#facc15" : "#cbd5e1"};
          ">
            ${percent}%
          </span>
        </div>

        <div style="
          height:7px;
          background:#334155;
          border-radius:999px;
          margin-top:8px;
          overflow:hidden;
        ">
          <div style="
            height:100%;
            width:${percent}%;
            background:linear-gradient(90deg,#7c3aed,#db2777);
          "></div>
        </div>

        <div style="
          margin-top:6px;
          font-size:11px;
          color:#64748b;
        ">
          ${match.alignedVotes} aligned votes ·
          ${match.uniqueHashes} unique hashes
        </div>
      </div>
    `;
  });

  html += `
    <div style="
      margin-top:14px;
      font-size:12px;
      line-height:1.5;
      color:#94a3b8;
    ">
      This matcher uses noise-suppressed spectral landmarks,
      fingerprint hashes, time-offset voting, and candidate verification.
      Scores are similarity indicators, not probabilities.
    </div>
  `;

  text.innerHTML = html;
}

/* ---------------- AUDIO / FFT HELPERS ---------------- */

async function decodeBushAudioBlobV3(blob) {
  // Reuse your existing decoder if present.
  if (
    typeof window.decodeAudioBlob === "function" &&
    window.decodeAudioBlob !== decodeBushAudioBlobV3
  ) {
    return window.decodeAudioBlob(blob);
  }

  const arrayBuffer = await blob.arrayBuffer();
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("Web Audio API is not supported.");
  }

  const ctx = new AudioContextClass();

  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await ctx.close();
  }
}

function convertBushToMonoV3(audioBuffer) {
  const mono = new Float32Array(audioBuffer.length);

  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const data = audioBuffer.getChannelData(c);

    for (let i = 0; i < data.length; i++) {
      mono[i] += data[i] / audioBuffer.numberOfChannels;
    }
  }

  return mono;
}

function removeBushDC(samples) {
  let mean = 0;

  for (let i = 0; i < samples.length; i++) {
    mean += samples[i];
  }

  mean /= Math.max(1, samples.length);

  const out = new Float32Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] - mean;
  }

  return out;
}

function preEmphasizeBush(samples, coefficient) {
  const out = new Float32Array(samples.length);

  if (!samples.length) return out;

  out[0] = samples[0];

  for (let i = 1; i < samples.length; i++) {
    out[i] = samples[i] - coefficient * samples[i - 1];
  }

  return out;
}

function createBushHannWindowV3(size) {
  const window = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    window[i] =
      0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }

  return window;
}

function calculateBushMagnitudeSpectrumV3(input) {
  const size = input.length;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);

  for (let i = 0; i < size; i++) {
    real[i] = input[i];
  }

  let j = 0;

  for (let i = 1; i < size; i++) {
    let bit = size >> 1;

    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }

    j ^= bit;

    if (i < j) {
      const temp = real[i];
      real[i] = real[j];
      real[j] = temp;
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    for (let i = 0; i < size; i += length) {
      let currentCosine = 1;
      let currentSine = 0;

      for (let k = 0; k < length / 2; k++) {
        const even = i + k;
        const odd = i + k + length / 2;

        const oddReal =
          real[odd] * currentCosine -
          imaginary[odd] * currentSine;

        const oddImaginary =
          real[odd] * currentSine +
          imaginary[odd] * currentCosine;

        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;

        real[even] += oddReal;
        imaginary[even] += oddImaginary;

        const nextCosine =
          currentCosine * cosine -
          currentSine * sine;

        const nextSine =
          currentCosine * sine +
          currentSine * cosine;

        currentCosine = nextCosine;
        currentSine = nextSine;
      }
    }
  }

  const spectrum = new Float32Array(size / 2);

  for (let i = 0; i < spectrum.length; i++) {
    spectrum[i] = Math.sqrt(
      real[i] * real[i] +
      imaginary[i] * imaginary[i]
    );
  }

  return spectrum;
}

/* ---------------- UI HELPERS ---------------- */

function statusHtml(title, detail) {
  return `
    <strong>${title}</strong>
    <br><br>
    <span style="color:#94a3b8">${detail}</span>
  `;
}

function escapeBushHtmlV3(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* Optional: call this after adding/updating reference cries. */
function clearBushFingerprintCache() {
  bushFingerprintReferenceCache = null;
  bushFingerprintIndexCache = null;
  bushFingerprintBuildPromise = null;

  if (window.__bushOneFpCache) {
    window.__bushOneFpCache.clear();
  }
}
