const populationFormatter = new Intl.NumberFormat("en-US");
const countryUi = {
  root: null,
  filterInput: null,
  jumpSelect: null,
  summary: null,
};

let allCountries = [];

function normalizeSearchText(value = "") {
  return String(value).toLowerCase().normalize("NFKD");
}

function buildCountrySearchIndex(item) {
  return normalizeSearchText(
    [item.name, item.iso3, item.title, item.headline, item.text, item.year]
      .filter(Boolean)
      .join(" "),
  );
}

function buildCountryRowId(item, index) {
  const raw = String(item.iso3 || item.name || `country-${index + 1}`).toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `country-${slug}` : `country-${index + 1}`;
}

function syncCountryControls(countries) {
  countryUi.root = countryUi.root || document.querySelector("#country-list");
  countryUi.filterInput = countryUi.filterInput || document.querySelector("#country-filter");
  countryUi.jumpSelect = countryUi.jumpSelect || document.querySelector("#country-jump");
  countryUi.summary = countryUi.summary || document.querySelector("#country-summary");

  if (countryUi.jumpSelect) {
    const currentValue = countryUi.jumpSelect.value;
    countryUi.jumpSelect.innerHTML = '<option value=""></option>';
    for (const item of countries) {
      const option = document.createElement("option");
      option.value = item._rowId || "";
      option.textContent = `${item.name || "Unknown"}${item.iso3 ? ` (${item.iso3})` : ""}`;
      countryUi.jumpSelect.appendChild(option);
    }
    if ([...countryUi.jumpSelect.options].some((opt) => opt.value === currentValue)) {
      countryUi.jumpSelect.value = currentValue;
    }
  }
}

function updateCountrySummary() {
  if (!countryUi.summary) return;
  countryUi.summary.textContent = "";
  countryUi.summary.hidden = true;
}

async function applyCountryFilter() {
  const rawQuery = String(countryUi.filterInput?.value || "").trim();
  const query = normalizeSearchText(rawQuery);
  const filtered = query ? allCountries.filter((item) => item._search.includes(query)) : allCountries.slice();
  syncCountryControls(filtered);
  await renderCountries(filtered);
  updateCountrySummary(filtered.length, allCountries.length, rawQuery);
}

// Surface runtime failures on-page (helps debug when the globe goes blank).
function reportFatal(err) {
  // Deduplicate and avoid spamming the build tag every frame.
  if (!reportFatal._seen) reportFatal._seen = new Set();
  if (!reportFatal._count) reportFatal._count = 0;
  try {
    const tag = document.getElementById("build-tag");
    const msg = err && typeof err === "object" && "stack" in err && err.stack ? String(err.stack) : String(err);
    if (reportFatal._seen.has(msg)) return;
    reportFatal._seen.add(msg);
    reportFatal._count += 1;
    const line = `\nERROR: ${msg}`;
    if (tag) {
      if (reportFatal._count <= 6) {
        tag.textContent = `${tag.textContent || ""}${line}`;
      } else if (reportFatal._count === 7) {
        tag.textContent = `${tag.textContent || ""}\nERROR: (more errors hidden)`;
      }
      return;
    }
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;padding:10px 12px;border-radius:10px;background:rgba(80,0,0,0.65);color:rgba(255,235,235,0.92);font:12px/1.35 'IBM Plex Mono',monospace;white-space:pre-wrap";
    el.textContent = `ERROR: ${msg}`;
    document.body.appendChild(el);
  } catch {
    // ignore
  }
}

window.addEventListener("error", (e) => reportFatal(e?.error || e?.message || e));
window.addEventListener("unhandledrejection", (e) => reportFatal(e?.reason || e));
const DATA_URL = "./world-data.json";
const WORLD_GEOJSON_URL = "https://unpkg.com/visionscarto-world-atlas@0.0.4/world/50m_countries.geojson";
// Weather grid is generated from NOAA GFS in CI and served as static JSON.
const NOAA_GRID_URL = "./noaa-weather-grid.json";
// Raster overlays are generated from the grid in CI.
const WEATHER_TEMP_RASTER_URL = "./weather-temp.png";
const WEATHER_PRECIP_RASTER_URL = "./weather-precip.png";
const WEATHER_RASTER_META_URL = "./weather-rasters.json";
// NOAA grid is already coarse; local cache avoids refetching on reloads.
const WEATHER_GRID_LAT_STEP = 20;
const WEATHER_GRID_LON_STEP = 20;
const WEATHER_GRID_LAT_MIN = -70;
const WEATHER_GRID_LAT_MAX = 70;
const WEATHER_CACHE_KEY = `world:noaa:grid:v1:${WEATHER_GRID_LAT_STEP}x${WEATHER_GRID_LON_STEP}`;
const WEATHER_CACHE_TTL_MS = 20 * 60 * 1000;

// --- Lo-fi tuning (lower contrast + less motion) ---
const LOFI_WEATHER_INTENSITY = 0.6; // 0..1
const LOFI_WIND_INTENSITY = 0.45; // 0..1
const LOFI_GLOW_INTENSITY = 0.75; // 0..1

// Make the temperature layer read a bit stronger.
const TEMP_OVERLAY_ALPHA_BASE = 0.10;
const TEMP_OVERLAY_ALPHA_RANGE = 0.16;

// Raster overlays can easily wash out the underlying globe.
// Keep them more subtle than the point-sampled overlays.
const TEMP_RASTER_ALPHA_MUL = 0.45;
const PRECIP_RASTER_ALPHA_MUL = 0.85;

// Performance: cap internal resolution and cache expensive overlays.
const MAX_CANVAS_DPR = 1.25;
const WEATHER_OVERLAY_FPS = 6;

// Performance: starfield is full-screen, so keep it cheaper.
const STARFIELD_MAX_DPR = 0.9;
const STARFIELD_FPS = 20;

// Performance: quantize rotation for expensive per-pixel projections.
const TEXTURE_ROT_STEP = 0.03; // ~1.7 degrees

const DEVANAGARI_RE = /[\u0900-\u097F]/;
const HAN_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const PinyinProImportUrl = "https://esm.sh/pinyin-pro@3.26.0?bundle";
let pinyinProPromise = null;
const ENGLISH_TRANSLATION_UNAVAILABLE = "English translation unavailable";
const TONE_SUPERSCRIPTS = {
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
};

const ENGLISH_HINT_WORDS = new Set([
  "the",
  "and",
  "of",
  "to",
  "in",
  "for",
  "with",
  "on",
  "at",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "said",
  "new",
  "after",
  "as",
  "that",
  "this",
  "it",
  "be",
  "been",
  "can",
  "could",
  "will",
  "would",
  "about",
  "into",
  "over",
]);

const DA_ALFABET_TRANSLATOR = {
  core_chart: [
    { id: "trap_cat", ipa: "æ", da: "A", examples: ["and", "cat"], notes: "short A" },
    { id: "schwa", ipa: "ə", da: "Λ", examples: ["the", "about"], notes: "neutral vowel" },
    { id: "strut", ipa: "ʌ", da: "ƛ", examples: ["but", "stuck"], notes: "short U sound" },
    { id: "father_bar", ipa: "aːr", da: "À", examples: ["father", "bar"], notes: "R-colored broad A" },
    { id: "face_day", ipa: "eɪ", da: "A", examples: ["day", "bait"], notes: "duplicate DA symbol with /æ/" },
    { id: "air_chair", ipa: "eər", da: "Æ", examples: ["chair", "aeroplane"], notes: "air sound" },
    { id: "b", ipa: "b", da: "B", examples: ["about", "boat"], notes: "consonant" },
    { id: "d", ipa: "d", da: "D", examples: ["dig"], notes: "consonant" },
    { id: "eth", ipa: "ð", da: "Ð", examples: ["that", "them"], notes: "voiced TH" },
    { id: "dress_bed", ipa: "ɛ", da: "E", examples: ["bed", "egg"], notes: "short E" },
    { id: "fleece_see", ipa: "iː", da: "Ξ", examples: ["see", "cozy"], notes: "long EE" },
    { id: "nurse_bird", ipa: "ɜːr", da: "C", examples: ["nurse", "bird"], notes: "R-colored ER" },
    { id: "f", ipa: "f", da: "F", examples: ["frog"], notes: "consonant" },
    { id: "g", ipa: "g", da: "G", examples: ["go"], notes: "hard G" },
    { id: "h", ipa: "h", da: "H", examples: ["hat"], notes: "consonant" },
    { id: "kit_sit", ipa: "ɪ", da: "I", examples: ["it", "sing"], notes: "short I" },
    { id: "price_night", ipa: "aɪ", da: "Φ", examples: ["night", "sky"], notes: "eye sound" },
    { id: "choice_boy", ipa: "ɔɪ", da: "Ȯ", examples: ["boy", "oil"], notes: "oy sound" },
    { id: "j", ipa: "dʒ", da: "J", examples: ["jump", "age"], notes: "J sound" },
    { id: "ch", ipa: "tʃ", da: "Ҹ", examples: ["chip", "touch"], notes: "CH sound" },
    { id: "sh", ipa: "ʃ", da: "X", examples: ["shop", "squash"], notes: "SH sound" },
    { id: "zh", ipa: "ʒ", da: "Ʒ", examples: ["television", "measure"], notes: "ZH sound" },
    { id: "k", ipa: "k", da: "K", examples: ["tick", "come", "queen"], notes: "K sound" },
    { id: "l", ipa: "l", da: "L", examples: ["lamp", "sell"], notes: "consonant" },
    { id: "m", ipa: "m", da: "M", examples: ["mat"], notes: "consonant" },
    { id: "n", ipa: "n", da: "N", examples: ["now", "stun"], notes: "consonant" },
    { id: "ng", ipa: "ŋ", da: "Ŋ", examples: ["thing", "singing"], notes: "NG sound" },
    { id: "lot_stop", ipa: "ɒ", da: "O", examples: ["stop", "opera"], notes: "short O" },
    { id: "goat_boat", ipa: "əʊ", da: "Ω", examples: ["boat", "slow"], notes: "long O / OH" },
    { id: "thought_store", ipa: ["ɔːr", "ɔː"], da: "Ō", examples: ["store", "all"], notes: "AW / OR sound" },
    { id: "p", ipa: "p", da: "P", examples: ["pin", "apple"], notes: "consonant" },
    { id: "r", ipa: "r", da: "R", examples: ["run", "arrow"], notes: "consonant" },
    { id: "s", ipa: "s", da: "S", examples: ["city", "house"], notes: "S sound" },
    { id: "t", ipa: "t", da: "T", examples: ["top", "sit"], notes: "consonant" },
    { id: "goose_boot", ipa: "uː", da: "U", examples: ["boot", "suit"], notes: "long OO" },
    { id: "foot_put", ipa: "ʊ", da: "ʊ", examples: ["put", "could"], notes: "short OO" },
    { id: "v", ipa: "v", da: "V", examples: ["have", "very"], notes: "consonant" },
    { id: "w", ipa: "w", da: "W", examples: ["what", "way"], notes: "consonant" },
    { id: "mouth_cloud", ipa: "aʊ", da: "Ꝏ", examples: ["cloud", "power"], notes: "OW sound" },
    { id: "y", ipa: "j", da: "Y", examples: ["you"], notes: "Y consonant" },
    { id: "z", ipa: "z", da: "Z", examples: ["zoo", "buzz"], notes: "Z sound" },
    { id: "theta", ipa: "θ", da: "Þ", examples: ["thing", "maths"], notes: "voiceless TH" },
  ],
  universal_kit: {
    "ː": "long sound marker",
    "ʼ": "ejective or sharp release",
    "ʰ": "aspiration",
    "ʲ": "palatalization",
    "~": "nasalization",
    "1": "tone 1",
    "2": "tone 2",
    "3": "tone 3",
    "4": "tone 4",
    "ŋ": "velar nasal fallback",
    "ʃ": "sh fallback",
    "ʒ": "zh fallback",
    "x": "voiceless velar or uvular fricative",
    "q": "uvular stop",
    "ʔ": "glottal stop",
    "ü": "front rounded vowel",
    "ə": "schwa fallback",
    "ṛ": "retroflex or syllabic r",
    "ṭ": "retroflex t",
    "ḍ": "retroflex d",
    "ṇ": "retroflex n",
  },
};

const DA_REPLACEMENTS = [
  [/tion/g, "ʃən"],
  [/sion/g, "ʒən"],
  [/eər/g, "Æ"],
  [/ɔːr/g, "Ō"],
  [/ɜːr/g, "C"],
  [/aɪ/g, "Φ"],
  [/aʊ/g, "Ꝏ"],
  [/ɔɪ/g, "Ȯ"],
  [/əʊ/g, "Ω"],
  [/eɪ/g, "A"],
  [/iː/g, "Ξ"],
  [/uː/g, "U"],
  [/æ/g, "A"],
  [/ə/g, "Λ"],
  [/ʌ/g, "ƛ"],
  [/aːr/g, "À"],
  [/ð/g, "Ð"],
  [/θ/g, "Þ"],
  [/tʃ/g, "Ҹ"],
  [/dʒ/g, "J"],
  [/ʃ/g, "X"],
  [/ʒ/g, "Ʒ"],
  [/ŋ/g, "Ŋ"],
  [/ɒ/g, "O"],
  [/ʊ/g, "ʊ"],
  [/sh/g, "ʃ"],
  [/zh/g, "ʒ"],
  [/ch/g, "tʃ"],
  [/th/g, "θ"],
  [/ng/g, "ŋ"],
  [/kh/g, "x"],
  [/ph/g, "f"],
  [/qu/g, "kw"],
  [/ck/g, "k"],
  [/ee/g, "iː"],
  [/oo/g, "uː"],
  [/aa/g, "aː"],
  [/[áàâä]/g, "a"],
  [/[éèêë]/g, "e"],
  [/[íìîï]/g, "i"],
  [/[óòôö]/g, "o"],
  [/[úùû]/g, "u"],
  [/y/g, "Y"],
  [/j/g, "J"],
  [/c(?=[eiy])/g, "s"],
  [/c/g, "k"],
];

function applyReplacements(input, replacements) {
  let out = String(input);
  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function toDaCore(input = "") {
  return applyReplacements(
    String(input)
      .normalize("NFC")
      .toLowerCase(),
    DA_REPLACEMENTS,
  );
}

function toDaPresentation(input = "") {
  return applyReplacements(String(input), [
    [/iː/g, "ī"],
    [/uː/g, "ū"],
    [/aː/g, "ā"],
    [/eː/g, "ē"],
    [/oː/g, "ō"],
    [/ṛː/g, "ṝ"],
    [/ḷː/g, "ḹ"],
    [/1/g, TONE_SUPERSCRIPTS["1"]],
    [/2/g, TONE_SUPERSCRIPTS["2"]],
    [/3/g, TONE_SUPERSCRIPTS["3"]],
    [/4/g, TONE_SUPERSCRIPTS["4"]],
  ]);
}

function transliterateDevanagari(input = "") {
  const vowels = {
    "अ": "a",
    "आ": "aː",
    "इ": "i",
    "ई": "iː",
    "उ": "u",
    "ऊ": "uː",
    "ऋ": "ṛ",
    "ॠ": "ṛː",
    "ऌ": "ḷ",
    "ॡ": "ḷː",
    "ए": "e",
    "ऐ": "ai",
    "ओ": "o",
    "औ": "au",
  };
  const consonants = {
    "क": "k",
    "ख": "kʰ",
    "ग": "g",
    "घ": "gʰ",
    "ङ": "ŋ",
    "च": "tʃ",
    "छ": "tʃʰ",
    "ज": "dʒ",
    "झ": "dʒʰ",
    "ञ": "nʲ",
    "ट": "ṭ",
    "ठ": "ṭʰ",
    "ड": "ḍ",
    "ढ": "ḍʰ",
    "ण": "ṇ",
    "त": "t",
    "थ": "tʰ",
    "द": "d",
    "ध": "dʰ",
    "न": "n",
    "प": "p",
    "फ": "pʰ",
    "ब": "b",
    "भ": "bʰ",
    "म": "m",
    "य": "y",
    "र": "r",
    "ल": "l",
    "व": "v",
    "श": "ʃ",
    "ष": "ʃ",
    "स": "s",
    "ह": "h",
    "ळ": "ḷ",
  };
  const nuktaConsonants = {
    "क": "q",
    "ख": "x",
    "ग": "g",
    "ज": "z",
    "ड": "ṛ",
    "ढ": "ṛʰ",
    "फ": "f",
    "य": "y",
  };
  const matras = {
    "ा": "aː",
    "ि": "i",
    "ी": "iː",
    "ु": "u",
    "ू": "uː",
    "ृ": "ṛ",
    "ॄ": "ṛː",
    "ॅ": "e",
    "े": "e",
    "ै": "ai",
    "ॉ": "o",
    "ो": "o",
    "ौ": "au",
    "ॆ": "e",
    "ॊ": "o",
  };
  const signs = {
    "ं": "~",
    "ँ": "~",
    "ः": "h",
    "ऽ": "ʔ",
  };

  let out = "";
  for (let i = 0; i < String(input).length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    const next2 = input[i + 2];

    if (vowels[ch]) {
      out += vowels[ch];
      continue;
    }
    if (signs[ch]) {
      out += signs[ch];
      continue;
    }
    if (ch === "्") {
      continue;
    }
    if (ch === "़") {
      continue;
    }

    const baseConsonant = consonants[ch];
    if (baseConsonant) {
      let rendered = baseConsonant;
      const isNukta = next === "़";
      const nextMark = isNukta ? next2 : next;
      if (isNukta && nuktaConsonants[ch]) {
        rendered = nuktaConsonants[ch];
      }
      if (nextMark === "्") {
        out += rendered;
        continue;
      }
      if (matras[nextMark]) {
        out += rendered + matras[nextMark];
        if (isNukta) i += 1;
        i += 1;
        continue;
      }
      out += rendered + "a";
      if (isNukta) i += 1;
      continue;
    }
    if (matras[ch]) {
      out += matras[ch];
      continue;
    }
    out += ch;
  }
  return toDaPresentation(toDaCore(out));
}

async function loadPinyinPro() {
  if (!pinyinProPromise) {
    pinyinProPromise = import(PinyinProImportUrl).catch((err) => {
      pinyinProPromise = null;
      throw err;
    });
  }
  return pinyinProPromise;
}

async function transliterateChinese(input = "") {
  try {
    const mod = await loadPinyinPro();
    const pinyin = mod.pinyin || mod.default?.pinyin || mod.default;
    if (typeof pinyin === "function") {
      const romanized = pinyin(String(input), {
        toneType: "num",
        nonZh: "consecutive",
      });
      const normalized = applyReplacements(String(romanized).toLowerCase(), [
        [/([jqxy])uan/g, "$1üan"],
        [/([jqxy])ue/g, "$1üe"],
        [/([jqxy])un/g, "$1ün"],
        [/([jqxy])u/g, "$1ü"],
        [/zh/g, "ʒ"],
        [/ch/g, "tʃʰ"],
        [/sh/g, "ʃ"],
        [/q/g, "tʃʰ"],
        [/x/g, "ʃ"],
        [/j/g, "dʒ"],
        [/c/g, "tʃʰ"],
      ]);
      return toDaPresentation(toDaCore(normalized));
    }
  } catch (err) {
    console.warn("Chinese transliteration fallback:", err);
  }
  return toDaPresentation(toDaCore(input));
}

const ENGLISH_PHONETIC_REPLACEMENTS = [
  [/eigh/g, "eɪ"],
  [/igh/g, "aɪ"],
  [/tion/g, "ʃən"],
  [/sion/g, "ʒən"],
  [/ture\b/g, "tʃər"],
  [/ph/g, "f"],
  [/kn/g, "n"],
  [/wr/g, "r"],
  [/wh/g, "w"],
  [/qu/g, "kw"],
  [/ck/g, "k"],
  [/ee/g, "iː"],
  [/ea/g, "iː"],
  [/ie\b/g, "aɪ"],
  [/ai/g, "eɪ"],
  [/ay\b/g, "eɪ"],
  [/oa/g, "əʊ"],
  [/ow\b/g, "əʊ"],
  [/ou/g, "aʊ"],
  [/oi/g, "ɔɪ"],
  [/oy\b/g, "ɔɪ"],
  [/au/g, "ɔː"],
  [/aw/g, "ɔː"],
  [/er\b/g, "ɜːr"],
  [/ir/g, "ɜːr"],
  [/ur/g, "ɜːr"],
  [/ar/g, "aːr"],
  [/or/g, "ɔːr"],
  [/our\b/g, "ɔːr"],
  [/oo/g, "uː"],
];

function isAcronymToken(token) {
  const letters = String(token || "").replace(/[^A-Za-z]/g, "");
  return letters.length >= 2 && letters.length <= 6 && letters === letters.toUpperCase();
}

function normalizeEnglishTokenForDa(token = "") {
  const input = String(token || "");
  if (!input || !/[A-Za-z]/.test(input)) return input;
  if (isAcronymToken(input)) return input;

  let word = input.toLowerCase().normalize("NFC").replace(/[’']/g, "");

  // Prefer a few high-signal spelling patterns before the broader phoneme map.
  word = word.replace(/a([bcdfghjklmnpqrstvwxyz])e\b/g, "eɪ$1");
  word = word.replace(/i([bcdfghjklmnpqrstvwxyz])e\b/g, "aɪ$1");
  word = word.replace(/o([bcdfghjklmnpqrstvwxyz])e\b/g, "əʊ$1");
  word = word.replace(/u([bcdfghjklmnpqrstvwxyz])e\b/g, "juː$1");

  word = applyReplacements(word, ENGLISH_PHONETIC_REPLACEMENTS);

  // Final -y commonly behaves like a vowel.
  word = word.replace(/([bcdfghjklmnpqrstvwxyz])y\b/g, "$1i");
  word = word.replace(/y\b/g, "i");

  // Clean up a few stragglers after the broad replacements.
  word = word.replace(/c(?=[eiy])/g, "s");
  word = word.replace(/g(?=[eiy])/g, "dʒ");
  word = word.replace(/x/g, "ks");
  word = word.replace(/e\b/g, "");

  return word;
}

function normalizeEnglishForDa(input = "") {
  const parts = String(input || "").match(/\s+|[^\s]+/g) || [];
  return parts.map((part) => (/^\s+$/.test(part) ? part : normalizeEnglishTokenForDa(part))).join("");
}

function isProbablyEnglishText(text) {
  const input = String(text || "").trim();
  if (!input) return false;
  if (containsNonLatinLetters(input)) return false;

  const words = input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/[a-z']+/g) || [];
  if (words.length < 4) return false;

  let hits = 0;
  for (const word of words) {
    if (ENGLISH_HINT_WORDS.has(word)) hits += 1;
  }
  return hits >= 2;
}

function containsNonLatinLetters(text = "") {
  for (const char of String(text || "")) {
    if (/\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char)) return true;
  }
  return false;
}

function isLikelyAlreadyEnglish(text = "", language = "") {
  const input = String(text || "").trim();
  if (!input) return false;
  if (containsNonLatinLetters(input)) return false;
  if (language === "en") return true;
  return isProbablyEnglishText(input);
}

async function toDaDisplay(input = "", language = "") {
  const text = String(input || "");
  if (!text) return "";
  const { body, suffix } = splitSourceSuffix(text);
  const sourceText = body || text;
  if (DEVANAGARI_RE.test(sourceText)) {
    return `${transliterateDevanagari(sourceText)}${suffix}`.trim();
  }
  if (HAN_RE.test(sourceText)) {
    return `${await transliterateChinese(sourceText)}${suffix}`.trim();
  }
  const normalized = isProbablyEnglishText(sourceText)
    ? normalizeEnglishForDa(sourceText)
    : sourceText;
  return `${toDaPresentation(toDaCore(normalized))}${suffix}`.trim();
}

const englishTranslationCache = new Map();

function splitSourceSuffix(text) {
  const input = String(text || "").trim();
  if (!input) return { body: "", suffix: "" };

  const separators = [" - ", " — ", " | "];
  for (const separator of separators) {
    const index = input.lastIndexOf(separator);
    if (index <= 20) continue;
    const body = input.slice(0, index).trim();
    const suffix = input.slice(index + separator.length).trim();
    if (!body || !suffix) continue;
    if (suffix.length > 80) continue;
    return { body, suffix: `${separator}${suffix}` };
  }

  return { body: input, suffix: "" };
}

async function toEnglishDisplay(input = "", language = "") {
  const text = String(input || "").trim();
  if (!text) return "";
  if (isLikelyAlreadyEnglish(text, language)) return text;
  const cacheKey = `${language || "auto"}::${text}`;
  if (englishTranslationCache.has(cacheKey)) return englishTranslationCache.get(cacheKey);

  const { body, suffix } = splitSourceSuffix(text);
  const sourceText = body || text;
  if (isLikelyAlreadyEnglish(sourceText, language)) {
    const alreadyEnglish = `${sourceText}${suffix}`.trim();
    englishTranslationCache.set(cacheKey, alreadyEnglish);
    return alreadyEnglish;
  }

  try {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", "en");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", sourceText);

    const data = await fetch(url.toString()).then((res) => {
      if (!res.ok) throw new Error(`translate request failed: ${res.status}`);
      return res.json();
    });
    const translated = Array.isArray(data?.[0])
      ? data[0]
          .map((part) => (Array.isArray(part) ? String(part[0] || "") : ""))
          .join("")
          .trim()
      : "";
    if (translated) {
      const merged = `${translated}${suffix}`.trim();
      englishTranslationCache.set(cacheKey, merged);
      return merged;
    }
  } catch (err) {
    console.warn("English translation fallback:", err);
  }

  const fallback = `${ENGLISH_TRANSLATION_UNAVAILABLE}${suffix}`.trim();
  englishTranslationCache.set(cacheKey, fallback);
  return fallback;
}

const STARS_URL = "./stars.json";
const STAR_CATALOG = [];

async function loadStarCatalog() {
  try {
    const res = await fetch(STARS_URL);
    const data = await res.json();
    for (const s of data) {
      if (s.m < -20) continue; // skip Sun
      STAR_CATALOG.push({
        ra: s.ra,
        dec: s.dec,
        size: Math.max(0.25, 2.8 - s.m * 0.38),
        baseAlpha: Math.max(0.07, 1.0 - s.m * 0.14),
        r: s.r, g: s.g, b: s.b,
        phase: (s.ra * 13.7 + s.dec * 7.3) % 6.2832,
        speed: 0.3 + (s.m % 1) * 1.2,
      });
    }
  } catch (e) {
    console.warn("Failed to load star catalog", e);
  }
}

const debugState = {
  earthRenderMode: "base-sphere",
  tempRasterLoaded: false,
  precipRasterLoaded: false,
};

// --- Weather raster overlays (generated by CI) ---
const weatherRaster = {
  temp: { img: null },
  precip: { img: null },
};

let _tempRasterData = null;
let _precipRasterData = null;
let _tempRasterCache = { offscreen: null, r: 0, rotY: null, rotX: null };
let _precipRasterCache = { offscreen: null, r: 0, rotY: null, rotX: null };

function loadWeatherRasters() {
  const load = (url, target, onData) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      target.img = img;
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const cx = c.getContext("2d");
      cx.drawImage(img, 0, 0);
      try {
        onData(cx.getImageData(0, 0, img.width, img.height));
      } catch {
        onData(null);
      }
    };
    img.onerror = () => {
      target.img = null;
      onData(null);
    };
    img.src = url;
  };

  // Use meta as a cache-buster so GitHub Pages updates show up without a hard refresh.
  fetch(WEATHER_RASTER_META_URL, { cache: "no-store" })
    .then((r) => r.json())
    .then((meta) => {
      const v = typeof meta?.validTime === "string" && meta.validTime
        ? meta.validTime
        : typeof meta?.generatedAt === "string" && meta.generatedAt
          ? meta.generatedAt
          : String(Date.now());
      const ver = encodeURIComponent(v);
      load(`${WEATHER_TEMP_RASTER_URL}?v=${ver}`, weatherRaster.temp, (d) => { _tempRasterData = d; debugState.tempRasterLoaded = !!d; });
      load(`${WEATHER_PRECIP_RASTER_URL}?v=${ver}`, weatherRaster.precip, (d) => { _precipRasterData = d; debugState.precipRasterLoaded = !!d; });
    })
    .catch(() => {
      load(WEATHER_TEMP_RASTER_URL, weatherRaster.temp, (d) => { _tempRasterData = d; debugState.tempRasterLoaded = !!d; });
      load(WEATHER_PRECIP_RASTER_URL, weatherRaster.precip, (d) => { _precipRasterData = d; debugState.precipRasterLoaded = !!d; });
    });
}

function rastersEnabled() {
  try {
    // Raster overlays are opt-in because they can wash out the base globe.
    return new URLSearchParams(location.search).get("rasters") === "1";
  } catch {
    return false;
  }
}

function drawDebugHud(ctx, canvas) {
  const tag = document.getElementById("build-tag")?.textContent || "";
  const lines = [
    tag,
    `earth render: ${debugState.earthRenderMode}`,
    `weather rasters: temp=${debugState.tempRasterLoaded ? "yes" : "no"} precip=${debugState.precipRasterLoaded ? "yes" : "no"}`,
    `rasters enabled: ${rastersEnabled() ? "yes" : "no"}`,
  ].filter(Boolean);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = "12px 'IBM Plex Mono', monospace";
  ctx.textBaseline = "top";
  const padX = 12;
  const padY = 34;
  const lh = 15;
  const maxW = Math.min(canvas.width - padX * 2, 900);
  const boxH = lines.length * lh + 10;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(padX - 8, padY - 6, maxW, boxH);
  ctx.fillStyle = "rgba(210,230,255,0.78)";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], padX, padY + i * lh);
  }

  ctx.restore();
}

function _renderTexture3DAlpha(cache, data, ctx, cx, cy, r, rotY, rotX, alphaMul) {
  if (!data) return;
  if (!Number.isFinite(r) || r <= 0) return;
  const size = Math.max(1, Math.round(r * 2));
  const half = size / 2;
  if (cache.size === size && cache.rotY === rotY && cache.rotX === rotX && cache.offscreen) {
    ctx.drawImage(cache.offscreen, cx - half, cy - half);
    return;
  }
  if (!cache.offscreen || cache.offscreen.width !== size) {
    cache.offscreen = document.createElement("canvas");
    cache.offscreen.width = size;
    cache.offscreen.height = size;
  }
  const octx = cache.offscreen.getContext("2d");
  if (!octx) return;
  const imgData = octx.createImageData(size, size);
  const pixels = imgData.data;
  const d = data.data, iw = data.width, ih = data.height;
  const cY = Math.cos(-rotY), sY = Math.sin(-rotY);
  const cX = Math.cos(-rotX), sX = Math.sin(-rotX);
  const invR = 1 / half;
  const aMul = Number.isFinite(alphaMul) ? alphaMul : 1;

  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const px = (dx - half) * invR, py = (dy - half) * invR;
      const r2 = px * px + py * py;
      if (r2 > 1) continue;
      const pz = Math.sqrt(1 - r2);
      const x1 = px;
      const y1 = py * cX - pz * sX;
      const z1 = py * sX + pz * cX;
      const x2 = x1 * cY + z1 * sY;
      const y2 = y1;
      const z2 = -x1 * sY + z1 * cY;
      const lat = Math.asin(Math.max(-1, Math.min(1, y2)));
      const lon = Math.atan2(x2, z2);
      const u = ((lon / (2 * Math.PI)) % 1 + 1) % 1;
      const v = 0.5 + lat / Math.PI;
      const si = Math.round(u * (iw - 1));
      const sj = Math.round(v * (ih - 1));
      const ii = (sj * iw + si) * 4;
      const pi = (dy * size + dx) * 4;
      const a = d[ii + 3];
      if (a === 0) continue;
      pixels[pi] = d[ii];
      pixels[pi + 1] = d[ii + 1];
      pixels[pi + 2] = d[ii + 2];
      pixels[pi + 3] = Math.max(0, Math.min(255, Math.round(a * aMul)));
    }
  }
  octx.putImageData(imgData, 0, 0);
  cache.size = size;
  cache.rotY = rotY;
  cache.rotX = rotX;
  ctx.drawImage(cache.offscreen, cx - half, cy - half);
}

function renderWeatherTempRaster(ctx, cx, cy, r, rotY, rotX) {
  if (_tempRasterData) _renderTexture3DAlpha(
    _tempRasterCache,
    _tempRasterData,
    ctx,
    cx,
    cy,
    r,
    rotY,
    rotX,
    TEMP_RASTER_ALPHA_MUL * LOFI_WEATHER_INTENSITY,
  );
}

function renderWeatherPrecipRaster(ctx, cx, cy, r, rotY, rotX) {
  if (_precipRasterData) _renderTexture3DAlpha(
    _precipRasterCache,
    _precipRasterData,
    ctx,
    cx,
    cy,
    r,
    rotY,
    rotX,
    PRECIP_RASTER_ALPHA_MUL * LOFI_WEATHER_INTENSITY,
  );
}

function _renderTexture3D(cache, data, ctx, cx, cy, r, rotY, rotX) {
  if (!data) return;
  if (!Number.isFinite(r) || r <= 0) return;
  const size = Math.max(1, Math.round(r * 2));
  const half = size / 2;
  if (cache.size === size && cache.rotY === rotY && cache.rotX === rotX && cache.offscreen) {
    ctx.drawImage(cache.offscreen, cx - half, cy - half);
    return;
  }
  if (!cache.offscreen || cache.offscreen.width !== size) {
    cache.offscreen = document.createElement("canvas");
    cache.offscreen.width = size;
    cache.offscreen.height = size;
  }
  const octx = cache.offscreen.getContext("2d");
  if (!octx) return;
  const imgData = octx.createImageData(size, size);
  const pixels = imgData.data;
  const d = data.data, iw = data.width, ih = data.height;
  // Slight lift so the raster overlays read better on dark themes.
  const boost = 1.08;
  const lift = 6;
  const cY = Math.cos(-rotY), sY = Math.sin(-rotY);
  const cX = Math.cos(-rotX), sX = Math.sin(-rotX);
  const invR = 1 / half;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const px = (dx - half) * invR, py = (dy - half) * invR;
      const r2 = px * px + py * py;
      if (r2 > 1) continue;
      const pz = Math.sqrt(1 - r2);
      const x1 = px;
      const y1 = py * cX - pz * sX;
      const z1 = py * sX + pz * cX;
      const x2 = x1 * cY + z1 * sY;
      const y2 = y1;
      const z2 = -x1 * sY + z1 * cY;
      const lat = Math.asin(Math.max(-1, Math.min(1, y2)));
      const lon = Math.atan2(x2, z2);
      const u = ((lon / (2 * Math.PI)) % 1 + 1) % 1;
      const v = 0.5 + lat / Math.PI;
      const si = Math.round(u * (iw - 1));
      const sj = Math.round(v * (ih - 1));
      const ii = (sj * iw + si) * 4;
      const pi = (dy * size + dx) * 4;
      const rr = Math.min(255, d[ii] * boost + lift);
      const gg = Math.min(255, d[ii + 1] * boost + lift);
      const bb = Math.min(255, d[ii + 2] * boost + lift);
      pixels[pi] = rr;
      pixels[pi + 1] = gg;
      pixels[pi + 2] = bb;
      pixels[pi + 3] = 255;
    }
  }
  octx.putImageData(imgData, 0, 0);
  cache.size = size;
  cache.rotY = rotY;
  cache.rotX = rotX;
  ctx.drawImage(cache.offscreen, cx - half, cy - half);
}

function renderEarthTexture(ctx, cx, cy, r, rotY, rotX) {
  debugState.earthRenderMode = "base-sphere";

  const g = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.25, r * 0.15, cx, cy, r);
  g.addColorStop(0, "rgba(70, 120, 170, 0.55)");
  g.addColorStop(0.55, "rgba(22, 58, 94, 0.95)");
  g.addColorStop(1, "rgba(8, 20, 34, 1)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 6.2832);
  ctx.fill();
  drawGlobeAtmosphere(ctx, cx, cy, r);
}

function drawGlobeAtmosphere(ctx, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  const lift = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.42, r * 0.12, cx, cy, r);
  lift.addColorStop(0, "rgba(175, 215, 255, 0.18)");
  lift.addColorStop(0.55, "rgba(46, 118, 174, 0.07)");
  lift.addColorStop(1, "rgba(0, 0, 0, 0.18)");
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = lift;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  ctx.globalCompositeOperation = "source-over";
  const rim = ctx.createRadialGradient(cx, cy, r * 0.72, cx, cy, r);
  rim.addColorStop(0, "rgba(0, 0, 0, 0)");
  rim.addColorStop(0.72, "rgba(69, 147, 214, 0.08)");
  rim.addColorStop(1, "rgba(138, 199, 255, 0.28)");
  ctx.fillStyle = rim;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  ctx.restore();
}

// --- Solar system orbits (actual celestial positions) ---
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const OBLIQUITY = 23.439292 * Math.PI / 180;

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function normalizeAngleRad(a) {
  a %= 2 * Math.PI;
  if (a < 0) a += 2 * Math.PI;
  return a;
}

function degToRad(d) {
  return d * Math.PI / 180;
}

function eqToUnitVec(ra, dec) {
  const cDec = Math.cos(dec);
  return {
    x: cDec * Math.sin(ra),
    y: Math.sin(dec),
    z: cDec * Math.cos(ra),
  };
}

function rotateVecToView(v, rotY, rotX) {
  // Matches the globe's latLonProjection orientation:
  // rotate around X (pitch) then around Y (yaw).
  const cX = Math.cos(rotX), sX = Math.sin(rotX);
  const y1 = v.y * cX + v.z * sX;
  const z1 = -v.y * sX + v.z * cX;
  const cY = Math.cos(rotY), sY = Math.sin(rotY);
  return {
    x: v.x * cY - z1 * sY,
    y: y1,
    z: v.x * sY + z1 * cY,
  };
}

const PLANET_ORBITS = [
  { name: 'Mercury', L: 252.250906, a: 0.387098, e: 0.205635, i: 7.004979, w: 77.457796, O: 48.330765, n: 4.092334, c: [210, 200, 180], s: 1.8 },
  { name: 'Venus',   L: 181.979801, a: 0.723332, e: 0.006772, i: 3.394662, w: 131.767557, O: 76.679843, n: 1.602130, c: [245, 235, 205], s: 3.5 },
  { name: 'Mars',    L: 355.453000, a: 1.523679, e: 0.093401, i: 1.849726, w: 336.060234, O: 49.558093, n: 0.524033, c: [230, 165, 125], s: 2.5 },
  { name: 'Jupiter', L: 34.351484,  a: 5.202603, e: 0.048498, i: 1.303267, w: 14.331309,  O: 100.464441, n: 0.083085, c: [225, 205, 170], s: 4.2 },
  { name: 'Saturn',  L: 49.317954,  a: 9.554909, e: 0.055546, i: 2.488879, w: 93.056787,  O: 113.665502, n: 0.033444, c: [215, 205, 175], s: 3.2 },
  { name: 'Uranus',  L: 313.232324, a: 19.218446, e: 0.046295, i: 0.773125, w: 173.005291, O: 74.005957, n: 0.011730, c: [180, 210, 230], s: 2.2 },
  { name: 'Neptune', L: 304.867234, a: 30.110387, e: 0.008986, i: 1.769953, w: 48.120276, O: 131.784226, n: 0.005981, c: [150, 185, 235], s: 2.0 },
];

const EARTH_ORBIT = { L: 100.466, a: 1.000001, e: 0.016708, i: 0, w: 282.938, O: 0, n: 0.9856 };

function heliocentricPos(d, body) {
  const M = ((body.L - body.w + body.n * d) % 360) * Math.PI / 180;
  let E = M;
  for (let i = 5; i--;)
    E -= (E - body.e * Math.sin(E) - M) / (1 - body.e * Math.cos(E));
  const xp = body.a * (Math.cos(E) - body.e);
  const yp = body.a * Math.sqrt(1 - body.e * body.e) * Math.sin(E);
  const wR = body.w * Math.PI / 180, OR = body.O * Math.PI / 180, iR = body.i * Math.PI / 180;
  const cW = Math.cos(wR), sW = Math.sin(wR), cO = Math.cos(OR), sO = Math.sin(OR), cI = Math.cos(iR), sI = Math.sin(iR);
  return {
    x: (cW * cO - sW * sO * cI) * xp + (-sW * cO - cW * sO * cI) * yp,
    y: (cW * sO + sW * cO * cI) * xp + (-sW * sO + cW * cO * cI) * yp,
    z: (sW * sI) * xp + (cW * sI) * yp,
  };
}

function eclipticToEq(lon, lat) {
  const sl = Math.sin(lon);
  return {
    ra: Math.atan2(sl * Math.cos(OBLIQUITY) - Math.tan(lat) * Math.sin(OBLIQUITY), Math.cos(lon)),
    dec: Math.asin(Math.sin(lat) * Math.cos(OBLIQUITY) + Math.cos(lat) * Math.sin(OBLIQUITY) * sl),
  };
}

// Geocentric Moon position (approximate; good enough for phase + general placement).
// Based on a compact subset of Meeus periodic terms.
function computeMoonGeocentricEq(d) {
  const Lp = degToRad(218.316 + 13.176396 * d);
  const M = degToRad(134.963 + 13.064993 * d);
  const D = degToRad(297.850 + 12.190749 * d);
  const F = degToRad(93.272 + 13.229350 * d);

  const lon =
    Lp +
    degToRad(6.289) * Math.sin(M) +
    degToRad(1.274) * Math.sin(2 * D - M) +
    degToRad(0.658) * Math.sin(2 * D) +
    degToRad(0.214) * Math.sin(2 * M) +
    degToRad(0.110) * Math.sin(D);

  const lat =
    degToRad(5.128) * Math.sin(F) +
    degToRad(0.280) * Math.sin(M + F) +
    degToRad(0.277) * Math.sin(M - F) +
    degToRad(0.173) * Math.sin(2 * D - F);

  const distKm =
    385001 -
    20905 * Math.cos(M) -
    3699 * Math.cos(2 * D - M) -
    2956 * Math.cos(2 * D) -
    570 * Math.cos(2 * M);

  const eq = eclipticToEq(lon, lat);
  eq.ra = normalizeAngleRad(eq.ra);
  return { ra: eq.ra, dec: eq.dec, distKm, eclLon: lon, eclLat: lat };
}

let celestialBodies = null;
let celestialEpoch = 0;

function computeCelestialBodies() {
  const d = (Date.now() - J2000_MS) / 86400000;
  const earth = heliocentricPos(d, EARTH_ORBIT);
  const bodies = [];

  const sgx = -earth.x, sgy = -earth.y, sgz = -earth.z;
  const sd = Math.sqrt(sgx * sgx + sgy * sgy + sgz * sgz);
  const sl = Math.atan2(sgy, sgx);
  const sa = Math.asin(sgz / sd);
  const se = eclipticToEq(sl, sa);
  if (se.ra < 0) se.ra += 2 * Math.PI;
  bodies.push({ name: 'Sun', ra: se.ra, dec: se.dec, c: [255, 245, 230], s: 28, sun: true });

  for (const p of PLANET_ORBITS) {
    const pos = heliocentricPos(d, p);
    const gx = pos.x - earth.x, gy = pos.y - earth.y, gz = pos.z - earth.z;
    const gd = Math.sqrt(gx * gx + gy * gy + gz * gz);
    const lon = Math.atan2(gy, gx);
    const lat = Math.asin(gz / gd);
    const eq = eclipticToEq(lon, lat);
    if (eq.ra < 0) eq.ra += 2 * Math.PI;
    bodies.push({ name: p.name, ra: eq.ra, dec: eq.dec, c: p.c, s: p.s });
  }

  return bodies;
}

function getCelestialBodies() {
  const now = Date.now();
  if (!celestialBodies || now - celestialEpoch > 600000) {
    celestialBodies = computeCelestialBodies();
    celestialEpoch = now;
  }
  return celestialBodies;
}

const CITIES = [
  [35.68, 139.65, 37], [34.69, 135.50, 19], [37.57, 126.98, 10],
  [31.23, 121.47, 28], [39.90, 116.41, 22], [23.13, 113.26, 25],
  [22.54, 114.06, 12], [25.03, 121.56, 8], [30.57, 104.07, 16],
  [29.56, 106.55, 15], [36.07, 120.38, 9], [45.75, 126.63, 11],
  [28.70, 77.10, 32], [19.08, 72.88, 21], [22.57, 88.36, 15],
  [12.97, 77.59, 12], [13.08, 80.27, 10], [17.39, 78.49, 9],
  [23.81, 90.41, 23], [24.86, 67.01, 16], [31.55, 74.34, 13],
  [33.68, 73.05, 2], [13.76, 100.50, 11], [14.60, 120.98, 14],
  [-6.21, 106.85, 11], [1.35, 103.82, 6], [10.82, 106.63, 9],
  [3.14, 101.69, 8], [16.84, 96.13, 5], [21.03, 105.85, 8],
  [41.01, 28.98, 15], [35.69, 51.39, 9], [33.32, 44.38, 7],
  [24.71, 46.68, 8], [25.20, 55.27, 3], [21.49, 39.19, 4],
  [30.04, 31.24, 22], [6.52, 3.38, 21],
  [55.76, 37.62, 12], [59.93, 30.34, 5], [50.45, 30.52, 3],
  [51.51, -0.13, 14], [48.86, 2.35, 11], [52.52, 13.41, 4],
  [40.42, -3.70, 6], [41.90, 12.50, 4], [45.46, 9.19, 3],
  [41.39, 2.17, 5], [52.37, 4.89, 2], [50.85, 4.35, 2],
  [48.21, 16.37, 2], [52.23, 21.01, 2], [38.72, -9.14, 3],
  [37.98, 23.73, 4], [53.35, -6.26, 2],
  [40.71, -74.01, 20], [34.05, -118.24, 13], [41.88, -87.63, 9],
  [43.65, -79.38, 6], [19.43, -99.13, 22], [20.68, -103.35, 5],
  [25.76, -80.19, 6], [29.76, -95.37, 7], [32.78, -96.81, 7],
  [42.36, -71.06, 5], [47.61, -122.33, 4], [49.28, -123.12, 3],
  [38.91, -77.04, 6], [33.75, -84.39, 6], [45.50, -73.57, 4],
  [-23.55, -46.63, 22], [-22.91, -43.17, 13], [-34.60, -58.38, 15],
  [-33.45, -70.65, 7], [-12.05, -77.04, 10], [4.71, -74.07, 11],
  [10.48, -66.90, 6], [-15.79, -47.86, 4], [-19.92, -43.94, 6],
  [-4.44, 15.27, 15], [-26.20, 28.05, 6], [-33.92, 18.42, 5],
  [-1.29, 36.82, 5], [9.03, 38.75, 5], [5.60, -0.19, 5],
  [14.72, -17.47, 4], [15.55, 32.53, 5],
  [-33.87, 151.21, 5], [-37.81, 144.96, 5], [-27.47, 153.03, 2],
  [-31.95, 115.86, 2],
];

const weatherOrbState = {
  features: [],
  loading: false,
  loaded: false,
  weatherGrid: new Map(),
  weatherTimestamp: "",
  weatherSource: "NOAA GFS grid (loading)",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function mixColor(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}

function rgba(color, alpha) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

function hash2D(x, y) {
  let n = x * 374761393 + y * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) & 0x7fffffff) / 0x7fffffff;
}

function smoothNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return lerp(lerp(hash2D(ix, iy), hash2D(ix + 1, iy), sx), lerp(hash2D(ix, iy + 1), hash2D(ix + 1, iy + 1), sx), sy);
}

function normalizeLongitude(lon) {
  let normalized = lon;
  while (normalized < -180) normalized += 360;
  while (normalized > 180) normalized -= 360;
  return normalized;
}

function getGridKey(lat, lon) {
  return `${lat}:${lon}`;
}

function snapLatitude(lat) {
  return clamp(
    Math.round(lat / WEATHER_GRID_LAT_STEP) * WEATHER_GRID_LAT_STEP,
    WEATHER_GRID_LAT_MIN,
    WEATHER_GRID_LAT_MAX,
  );
}

function snapLongitude(lon) {
  let snapped = Math.round(normalizeLongitude(lon) / WEATHER_GRID_LON_STEP) * WEATHER_GRID_LON_STEP;
  if (snapped >= 180) snapped -= 360;
  if (snapped < -180) snapped += 360;
  return snapped;
}

function getWeatherLayerNodes() {
  return {
    canvas: document.querySelector("#weather-orb-canvas"),
    name: document.querySelector("#weather-layer-name"),
    detail: document.querySelector("#weather-layer-detail"),
    source: document.querySelector("#weather-hud-source"),
    updated: document.querySelector("#weather-hud-updated"),
    temp: document.querySelector("#weather-hud-temp"),
    wind: document.querySelector("#weather-hud-wind"),
    rain: document.querySelector("#weather-hud-rain"),
  };
}

function simplifyRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return [];
  const step = ring.length > 220 ? 4 : ring.length > 120 ? 3 : ring.length > 48 ? 2 : 1;
  const simplified = [];
  for (let index = 0; index < ring.length; index += step) {
    simplified.push(ring[index]);
  }
  const last = ring[ring.length - 1];
  const first = simplified[0];
  if (
    simplified.length &&
    (first[0] !== last[0] || first[1] !== last[1])
  ) {
    simplified.push(last);
  }
  return simplified;
}

function preprocessWorldGeometry(geojson) {
  if (!geojson?.features) return [];

  return geojson.features
    .flatMap((feature) => {
      const geometry = feature?.geometry;
      if (!geometry) return [];
      if (geometry.type === "Polygon") return [geometry.coordinates.map(simplifyRing)];
      if (geometry.type === "MultiPolygon") {
        return geometry.coordinates.map((polygon) => polygon.map(simplifyRing));
      }
      return [];
    })
    .filter(Boolean);
}

async function loadWeatherGeometry() {
  if (weatherOrbState.loading || weatherOrbState.loaded) return;
  weatherOrbState.loading = true;

  try {
    const response = await fetch(WORLD_GEOJSON_URL);
    const geojson = await response.json();
    weatherOrbState.features = preprocessWorldGeometry(geojson);
    weatherOrbState.loaded = true;

    weatherOrbState.countryShapes = new Map();
    if (geojson?.features) {
      for (const feature of geojson.features) {
        const iso3 = feature.properties?.iso_a3;
        if (!iso3) continue;
        const geometry = feature.geometry;
        if (!geometry) continue;
        let polygons = [];
        if (geometry.type === "Polygon") {
          polygons = [geometry.coordinates.map(simplifyRing)];
        } else if (geometry.type === "MultiPolygon") {
          polygons = geometry.coordinates.map((poly) => poly.map(simplifyRing));
        }
        if (polygons.length) weatherOrbState.countryShapes.set(iso3, polygons);
      }
    }
  } catch (_error) {
    weatherOrbState.features = [];
    weatherOrbState.loaded = false;
  } finally {
    weatherOrbState.loading = false;
  }
}

async function loadNoaaWeatherGrid() {
  // Try cached grid first (keeps the page usable offline + avoids refetch loops).
  try {
    const cachedRaw = localStorage.getItem(WEATHER_CACHE_KEY);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw);
      if (
        cached &&
        typeof cached.savedAtMs === "number" &&
        Date.now() - cached.savedAtMs < WEATHER_CACHE_TTL_MS &&
        Array.isArray(cached.entries)
      ) {
        const grid = new Map();
        for (const entry of cached.entries) {
          if (!entry || typeof entry.key !== "string" || typeof entry.value !== "object") continue;
          grid.set(entry.key, entry.value);
        }
        if (grid.size) {
          weatherOrbState.weatherGrid = grid;
          weatherOrbState.weatherTimestamp = typeof cached.timestamp === "string" ? cached.timestamp : "";
          weatherOrbState.weatherSource = "NOAA GFS grid (cached)";
          return;
        }
      }
    }
  } catch {
    // ignore cache corruption
  }

  const response = await fetch(NOAA_GRID_URL, { cache: "no-store" });
  const payload = await response.json();
  const rows = payload?.grid;
  if (!Array.isArray(rows)) {
    throw new Error("invalid NOAA grid payload");
  }

  const grid = new Map();
  for (const row of rows) {
    const lat = snapLatitude(row?.lat);
    const lon = snapLongitude(row?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    grid.set(getGridKey(lat, lon), {
      temperature: row.temperatureC,
      precipitation: row.precipMmPerHr,
      cloudCover: row.cloudCoverPct,
      windU: row.windU,
      windV: row.windV,
      // Keep these for potential HUD wiring later.
      windSpeed: row.windSpeed,
      windDirection: row.windDirection,
    });
  }

  if (!grid.size) {
    throw new Error("empty NOAA grid");
  }

  weatherOrbState.weatherGrid = grid;
  weatherOrbState.weatherTimestamp =
    typeof payload?.validTime === "string" ? payload.validTime : typeof payload?.generatedAt === "string" ? payload.generatedAt : "";
  weatherOrbState.weatherSource =
    typeof payload?.source === "string" ? payload.source : "NOAA GFS grid";

  try {
    localStorage.setItem(
      WEATHER_CACHE_KEY,
      JSON.stringify({
        savedAtMs: Date.now(),
        timestamp: weatherOrbState.weatherTimestamp,
        entries: Array.from(grid.entries()).map(([key, value]) => ({ key, value })),
      }),
    );
  } catch {
    // ignore quota / serialization errors
  }
}

function latLonProjection(latDeg, lonDeg, rotY, rotX) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  let x = Math.cos(lat) * Math.sin(lon);
  let y = Math.sin(lat);
  let z = Math.cos(lat) * Math.cos(lon);
  const cY = Math.cos(rotY), sY = Math.sin(rotY);
  const x1 = x * cY + z * sY;
  const y1 = y;
  const z1 = -x * sY + z * cY;
  const cX = Math.cos(rotX), sX = Math.sin(rotX);
  const x2 = x1;
  const y2 = y1 * cX - z1 * sX;
  const z2 = y1 * sX + z1 * cX;
  return { x: x2, y: y2, z: z2, lat, lon };
}

function sampleTemperature(latDeg, lonDeg, timeMs) {
  const v = interpolateGridField(latDeg, lonDeg, "temperature");
  if (v != null) return clamp((v + 35) / 80, 0, 1);
  const live = getLiveWeatherPoint(latDeg, lonDeg);
  if (live && typeof live.temperature === "number") return clamp((live.temperature + 35) / 80, 0, 1);
  return null;
}

function sampleRainfall(latDeg, lonDeg, timeMs) {
  const v = interpolateGridField(latDeg, lonDeg, "precipitation");
  if (v != null) return clamp(v / 5, 0, 1);
  const live = getLiveWeatherPoint(latDeg, lonDeg);
  if (live && typeof live.precipitation === "number") return clamp(live.precipitation / 5, 0, 1);
  return null;
}

function sampleClouds(latDeg, lonDeg, timeMs) {
  const v = interpolateGridField(latDeg, lonDeg, "cloudCover");
  if (v != null) return clamp(v / 100, 0, 1);
  const live = getLiveWeatherPoint(latDeg, lonDeg);
  if (live && typeof live.cloudCover === "number") return clamp(live.cloudCover / 100, 0, 1);
  return null;
}

function sampleWind(latDeg, lonDeg, timeMs) {
  const speed = interpolateGridField(latDeg, lonDeg, "windSpeed");
  const dir = interpolateGridField(latDeg, lonDeg, "windDirection");
  if (speed != null && dir != null) {
    const cs = clamp(speed / 18, 0.12, 1.2);
    const rad = ((dir + 180) * Math.PI) / 180;
    return { zonal: Math.sin(rad) * cs, meridional: Math.cos(rad) * cs, speed: cs };
  }
  const live = getLiveWeatherPoint(latDeg, lonDeg);
  if (live && typeof live.windSpeed === "number" && typeof live.windDirection === "number") {
    const cs = clamp(live.windSpeed / 18, 0.12, 1.2);
    const rad = ((live.windDirection + 180) * Math.PI) / 180;
    return { zonal: Math.sin(rad) * cs, meridional: Math.cos(rad) * cs, speed: cs };
  }
  return null;
}

function getLiveWindUV(latDeg, lonDeg) {
  const point = getLiveWeatherPoint(latDeg, lonDeg);
  if (point && typeof point.windU === "number" && typeof point.windV === "number") {
    return point;
  }
  return null;
}

function sampleWindUV(latDeg, lonDeg, timeMs) {
  const uGrid = interpolateGridField(latDeg, lonDeg, "windU");
  const vGrid = interpolateGridField(latDeg, lonDeg, "windV");
  if (uGrid != null && vGrid != null) {
    return { u: uGrid, v: vGrid, speed: Math.sqrt(uGrid * uGrid + vGrid * vGrid) };
  }
  const live = getLiveWindUV(latDeg, lonDeg);
  if (live) {
    return { u: live.windU, v: live.windV, speed: Math.sqrt(live.windU ** 2 + live.windV ** 2) };
  }
  const w = sampleWind(latDeg, lonDeg, timeMs);
  if (w) {
    return { u: w.zonal, v: w.meridional, speed: w.speed };
  }
  return null;
}

const WIND_LAYERS = [
  // Snapshot mode (option 1): surface winds only.
  { name: "surface", u: "windU", v: "windV", c: [160, 210, 255], a: 0.22, w: 0.55, count: 1100 },
];

const windLayerParticles = new Map();

function initWindParticles(count) {
  const p = [];
  for (let i = 0; i < count; i++) {
    p.push({ lat: Math.random() * 140 - 70, lon: Math.random() * 360 - 180, prevLat: 0, prevLon: 0, age: 0 });
  }
  return p;
}

function sampleWindUVLayer(latDeg, lonDeg, timeMs, layer) {
  const uGrid = interpolateGridField(latDeg, lonDeg, layer.u);
  const vGrid = interpolateGridField(latDeg, lonDeg, layer.v);
  if (uGrid != null && vGrid != null) {
    return { u: uGrid, v: vGrid, speed: Math.sqrt(uGrid * uGrid + vGrid * vGrid) };
  }
  // Only the surface layer has reasonable fallbacks.
  if (layer.name === "surface") return sampleWindUV(latDeg, lonDeg, timeMs);
  return null;
}

function drawWindLayer(ctx, rotY, rotX, radius, centerX, centerY, timeMs, layer) {
  let particles = windLayerParticles.get(layer.name);
  if (!particles) {
    particles = initWindParticles(layer.count);
    windLayerParticles.set(layer.name, particles);
  }

  const step = 0.26;
  for (const p of particles) {
    const wind = sampleWindUVLayer(p.lat, p.lon, timeMs, layer);
    if (!wind || wind.speed < 0.03) {
      p.lat = Math.random() * 140 - 70;
      p.lon = Math.random() * 360 - 180;
      p.prevLat = p.lat;
      p.prevLon = p.lon;
      p.age = 0;
      continue;
    }

    p.prevLat = p.lat;
    p.prevLon = p.lon;

    const lf = 1 / Math.cos(p.lat * Math.PI / 180 + 0.01);
    p.lat += wind.v * step * 0.07;
    p.lon += wind.u * step * 0.07 * lf;

    if (p.lon > 180) p.lon -= 360;
    if (p.lon < -180) p.lon += 360;
    if (Math.abs(p.lat) > 85) {
      p.lat = Math.random() * 140 - 70;
      p.lon = Math.random() * 360 - 180;
      p.prevLat = p.lat;
      p.prevLon = p.lon;
      p.age = 0;
      continue;
    }

    const pos = latLonProjection(p.lat, p.lon, rotY, rotX);
    const prevPos = latLonProjection(p.prevLat, p.prevLon, rotY, rotX);

    if (pos.z <= 0.01 || prevPos.z <= 0.01) {
      p.lat = Math.random() * 140 - 70;
      p.lon = Math.random() * 360 - 180;
      p.prevLat = p.lat;
      p.prevLon = p.lon;
      p.age = 0;
      continue;
    }

    const x = centerX + pos.x * radius;
    const y = centerY - pos.y * radius;
    const px = centerX + prevPos.x * radius;
    const py = centerY - prevPos.y * radius;

    const alpha = Math.min(layer.a, wind.speed * 0.07) * LOFI_WIND_INTENSITY;
    ctx.strokeStyle = rgba(layer.c, alpha);
    ctx.lineWidth = Math.max(0.3, wind.speed * layer.w);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(x, y);
    ctx.stroke();

    p.age++;
  }
}

function drawWindParticles(ctx, rotY, rotX, radius, centerX, centerY, timeMs) {
  ctx.lineCap = "round";
  // Draw higher layers first, so the surface field reads on top.
  for (const layer of [...WIND_LAYERS].reverse()) {
    drawWindLayer(ctx, rotY, rotX, radius, centerX, centerY, timeMs, layer);
  }
}

function getTemperatureColor(value) {
  if (value < 0.2) return mixColor([30, 60, 180], [50, 130, 230], value / 0.2);
  if (value < 0.4) return mixColor([50, 130, 230], [80, 210, 240], (value - 0.2) / 0.2);
  if (value < 0.5) return mixColor([80, 210, 240], [160, 230, 140], (value - 0.4) / 0.1);
  if (value < 0.6) return mixColor([160, 230, 140], [230, 230, 100], (value - 0.5) / 0.1);
  if (value < 0.75) return mixColor([230, 230, 100], [240, 170, 70], (value - 0.6) / 0.15);
  if (value < 0.9) return mixColor([240, 170, 70], [230, 100, 60], (value - 0.75) / 0.15);
  return mixColor([230, 100, 60], [180, 40, 40], Math.min(1, (value - 0.9) / 0.1));
}

function getRainRadarColor(value) {
  if (value < 0.1) return null;
  // Softer alpha for a more lo-fi look.
  if (value < 0.2) return [[80, 200, 255], 0.05 * LOFI_WEATHER_INTENSITY];
  if (value < 0.35) return [[60, 230, 130], 0.09 * LOFI_WEATHER_INTENSITY];
  if (value < 0.5) return [[255, 235, 70], 0.14 * LOFI_WEATHER_INTENSITY];
  if (value < 0.7) return [[255, 150, 40], 0.18 * LOFI_WEATHER_INTENSITY];
  return [[255, 50, 50], 0.22 * LOFI_WEATHER_INTENSITY];
}
function getCloudColor(value) {
  return mixColor([110, 136, 156], [240, 247, 255], clamp(value, 0, 1));
}

function getLiveWeatherPoint(latDeg, lonDeg) {
  if (!weatherOrbState.weatherGrid.size) return null;
  const lat = snapLatitude(latDeg);
  const lon = snapLongitude(lonDeg);
  return weatherOrbState.weatherGrid.get(getGridKey(lat, lon)) || null;
}

function interpolateGridField(latDeg, lonDeg, field) {
  if (!weatherOrbState.weatherGrid.size) return null;
  const grid = weatherOrbState.weatherGrid;
  const step = WEATHER_GRID_LAT_STEP;

  const lat0 = snapLatitude(latDeg - step / 2);
  const lat1 = snapLatitude(latDeg + step / 2);
  const lon0 = snapLongitude(lonDeg - step / 2);
  const lon1 = snapLongitude(lonDeg + step / 2);

  if (lat0 === lat1 && lon0 === lon1) {
    const p = grid.get(getGridKey(lat0, lon0));
    return p ? p[field] ?? null : null;
  }

  const gv = (lat, lon) => {
    const p = grid.get(getGridKey(lat, lon));
    return p ? p[field] ?? null : null;
  };

  let fx, latT, latB;
  if (lat0 <= lat1) { fx = (latDeg - lat0) / (lat1 - lat0); latT = lat0; latB = lat1; }
  else { fx = (latDeg - lat1) / (lat0 - lat1); latT = lat1; latB = lat0; }
  fx = clamp(fx, 0, 1);

  let fy, lonL, lonR;
  if (lon0 <= lon1) { fy = (lonDeg - lon0) / (lon1 - lon0); lonL = lon0; lonR = lon1; }
  else { fy = (lonDeg - lon0) / (lon1 + 360 - lon0); lonL = lon0; lonR = lon1; }
  fy = clamp(fy, 0, 1);

  const v00 = gv(latT, lonL);
  const v10 = gv(latB, lonL);
  const v01 = gv(latT, lonR);
  const v11 = gv(latB, lonR);

  const lerpV = (a, b, t) => {
    if (a == null && b == null) return null;
    if (a == null) return b;
    if (b == null) return a;
    return a + (b - a) * t;
  };

  const top = lerpV(v00, v01, fy);
  const bot = lerpV(v10, v11, fy);
  if (top == null && bot == null) return null;
  return lerpV(top, bot, fx);
}

function getWeatherSummary() {
  if (!weatherOrbState.weatherGrid.size) return null;

  let tempTotal = 0;
  let windTotal = 0;
  let maxRain = 0;
  let count = 0;

  weatherOrbState.weatherGrid.forEach((point) => {
    if (typeof point.temperature === "number") tempTotal += point.temperature;
    if (typeof point.windSpeed === "number") windTotal += point.windSpeed;
    if (typeof point.precipitation === "number") maxRain = Math.max(maxRain, point.precipitation);
    count += 1;
  });

  if (!count) return null;
  return {
    averageTemp: tempTotal / count,
    averageWind: windTotal / count,
    maxRain,
  };
}

function drawWeatherLayers(ctx, rotY, rotX, radius, centerX, centerY, timeMs) {
  // Prefer precomputed raster overlays when available (much cheaper than sampling
  // and drawing thousands of points).
  if (rastersEnabled() && (_tempRasterData || _precipRasterData)) {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    renderWeatherTempRaster(ctx, centerX, centerY, radius, rotY, rotX);
    ctx.globalCompositeOperation = "lighter";
    renderWeatherPrecipRaster(ctx, centerX, centerY, radius, rotY, rotX);
    ctx.restore();
    return;
  }

  // Temperature overlay (semi-transparent gradient, always visible)
  for (let lat = -76; lat <= 76; lat += 3) {
    for (let lon = -180; lon < 180; lon += 3) {
      const point = latLonProjection(lat, lon, rotY, rotX);
      if (point.z <= 0) continue;
      const value = sampleTemperature(lat, lon, timeMs);
      if (value === null) continue;
      const x = centerX + point.x * radius;
      const y = centerY - point.y * radius;
      const a = (TEMP_OVERLAY_ALPHA_BASE + value * TEMP_OVERLAY_ALPHA_RANGE) * LOFI_WEATHER_INTENSITY;
      ctx.fillStyle = rgba(getTemperatureColor(value), a);
      ctx.beginPath();
      ctx.arc(x, y, lerp(1.8, 4.6, point.z), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Precipitation overlay (radar-style, always visible)
  for (let lat = -76; lat <= 76; lat += 3) {
    for (let lon = -180; lon < 180; lon += 3) {
      const point = latLonProjection(lat, lon, rotY, rotX);
      if (point.z <= 0) continue;
      let value = sampleRainfall(lat, lon, timeMs);
      if (value === null || value < 0.10) continue;
      const x = centerX + point.x * radius;
      const y = centerY - point.y * radius;
      const size = lerp(2.2, 4.4, point.z);
      const radar = getRainRadarColor(value);
      if (!radar) continue;
      ctx.fillStyle = rgba(radar[0], radar[1]);
      ctx.beginPath();
      ctx.arc(x, y, size * 1.15, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Cloud cover overlay (subtle, always visible)
  for (let lat = -76; lat <= 76; lat += 3) {
    for (let lon = -180; lon < 180; lon += 3) {
      const point = latLonProjection(lat, lon, rotY, rotX);
      if (point.z <= 0) continue;
      const value = sampleClouds(lat, lon, timeMs);
      if (value === null || value < 0.26) continue;
      const x = centerX + point.x * radius;
      const y = centerY - point.y * radius;
      const s = lerp(2.6, 6.4, point.z);
      // Light mist instead of dark blotches.
      ctx.fillStyle = `rgba(240, 246, 255, ${(0.016 * value) * LOFI_WEATHER_INTENSITY})`;
      ctx.beginPath();
      ctx.arc(x, y, s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawWorldGeometry(ctx, rotY, rotX, radius, centerX, centerY) {
  if (!weatherOrbState.features.length) return false;

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const polygon of weatherOrbState.features) {
    for (const [ringIndex, ring] of polygon.entries()) {
      let started = false;
      ctx.beginPath();
      for (const [lon, lat] of ring) {
        const point = latLonProjection(lat, lon, rotY, rotX);
        if (point.z <= 0) {
          started = false;
          continue;
        }
        const x = centerX + point.x * radius;
        const y = centerY - point.y * radius;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (started) {
        ctx.strokeStyle = ringIndex === 0
          ? "rgba(180, 200, 220, 0.30)"
          : "rgba(140, 170, 200, 0.12)";
        ctx.lineWidth = ringIndex === 0 ? 0.8 : 0.3;
        ctx.stroke();
      }
    }
  }

  return true;
}

let weatherOverlayOffscreen = null;
let weatherOverlayCache = {
  w: 0,
  h: 0,
  // Quantized rotation reduces rebuild churn while dragging.
  qRotY: null,
  qRotX: null,
  radius: 0,
  lastDrawMs: 0,
};

function getWeatherOverlayOffscreen(w, h) {
  if (!weatherOverlayOffscreen || weatherOverlayOffscreen.width !== w || weatherOverlayOffscreen.height !== h) {
    weatherOverlayOffscreen = document.createElement("canvas");
    weatherOverlayOffscreen.width = w;
    weatherOverlayOffscreen.height = h;
    weatherOverlayCache = { w, h, qRotY: null, qRotX: null, radius: 0, lastDrawMs: 0 };
  }
  return weatherOverlayOffscreen;
}

function quantizeRotation(rad) {
  return Math.round(rad / TEXTURE_ROT_STEP) * TEXTURE_ROT_STEP;
}

let globeRotY = 0;
let globeRotX = 0;
let globeZoom = 1;
let globeDrag = { active: false, startX: 0, startY: 0, startRotY: 0, startRotX: 0 };

function setupGlobeInteraction(canvas) {
  globeDrag.active = false;
  globeRotY = 0;
  globeRotX = 0;
  globeZoom = 1;
  return () => {};
}

function drawWeatherOrbFrame(ctx, canvas, timeMs) {
  const width = canvas.width;
  const height = canvas.height;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.34 * globeZoom;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#09131f";
  ctx.fillRect(0, 0, width, height);

  // Base fill behind the globe keeps the dark theme, but avoids crushing blacks.
  ctx.fillStyle = "#0b253c";
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fill();

  const rotY = 0;
  const rotX = 0;

  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.clip();

  renderEarthTexture(ctx, centerX, centerY, radius, rotY, rotX);

  ctx.restore();

  // Toggle HUD with ?debug=1
  if (drawWeatherOrbFrame._debug == null) {
    try {
      drawWeatherOrbFrame._debug = new URLSearchParams(location.search).get("debug") === "1";
    } catch {
      drawWeatherOrbFrame._debug = false;
    }
  }
  if (drawWeatherOrbFrame._debug) drawDebugHud(ctx, canvas);
}

function renderStarfield(timeMs) {
  const canvas = document.getElementById("starfield-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, STARFIELD_MAX_DPR);
  const w = Math.round(window.innerWidth);
  const h = Math.round(window.innerHeight);
  const targetWidth = Math.round(w * dpr);
  const targetHeight = Math.round(h * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  // Throttle starfield rendering; it's the most expensive full-screen layer.
  const minDt = 1000 / STARFIELD_FPS;
  if (renderStarfield._lastMs && timeMs - renderStarfield._lastMs < minDt) return;
  renderStarfield._lastMs = timeMs;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Milky Way glow at correct celestial position
  const bodies = getCelestialBodies();
  // Defensive: if anything corrupts the cached celestial array, don't crash rendering.
  const firstRa = Array.isArray(bodies) && bodies.length && bodies[0] && Number.isFinite(bodies[0].ra) ? bodies[0].ra : 0;
  const raOffset = firstRa - 1.5 * Math.PI;

  // Milky Way glow at correct celestial position
  const glowA = (0.004 + 0.003 * Math.sin(timeMs * 0.00004)) * LOFI_GLOW_INTENSITY;

  for (let ra = 0; ra < 2 * Math.PI; ra += 0.06) {
    const mwDec = Math.atan(-1.966 * Math.cos(ra - 3.366));
    // Keep the background sky fixed; only the globe should rotate.
    let nra = ((ra - raOffset) % (2 * Math.PI)) / (2 * Math.PI);
    if (nra < 0) nra += 1;
    const cx = nra * canvas.width;
    const cy = (0.5 - mwDec / Math.PI) * canvas.height;
    if (cx < -200 || cx > canvas.width + 200 || cy < -200 || cy > canvas.height + 200) continue;
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, 160 * dpr);
    gr.addColorStop(0, `rgba(160, 175, 220, ${glowA})`);
    gr.addColorStop(1, "rgba(160, 175, 220, 0)");
    ctx.fillStyle = gr;
    ctx.fillRect(cx - 160 * dpr, cy - 160 * dpr, 320 * dpr, 320 * dpr);
  }

  // Stars from HYG catalog

  let i = STAR_CATALOG.length;
  while (i--) {
    const s = STAR_CATALOG[i];
    if (!s || !Number.isFinite(s.ra) || !Number.isFinite(s.dec)) continue;
    const speed = Number.isFinite(s.speed) ? s.speed : 0;
    const phase = Number.isFinite(s.phase) ? s.phase : 0;
    const baseAlpha = Number.isFinite(s.baseAlpha) ? s.baseAlpha : 0;
    const size = Number.isFinite(s.size) ? s.size : 0.8;
    const r = Number.isFinite(s.r) ? s.r : 255;
    const g = Number.isFinite(s.g) ? s.g : 255;
    const b = Number.isFinite(s.b) ? s.b : 255;
    const twinkle = 0.65 + 0.35 * Math.sin(timeMs * 0.001 * speed + phase);
    const alpha = baseAlpha * twinkle * 0.72;
    if (alpha < 0.01) continue;

    let nra = ((s.ra - raOffset) % (2 * Math.PI)) / (2 * Math.PI);
    if (nra < 0) nra += 1;
    const sx = nra * canvas.width;
    const sy = (0.5 - s.dec / Math.PI) * canvas.height;
    if (sx < -5 || sx > canvas.width + 5 || sy < -5 || sy > canvas.height + 5) continue;

    ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.beginPath();
    ctx.arc(sx, sy, size * dpr, 0, 6.2832);
    ctx.fill();
  }

  // Sun and planets at actual celestial positions
  if (Array.isArray(bodies) && bodies.length) {
    for (const b of bodies) {
      if (!b || !Number.isFinite(b.ra) || !Number.isFinite(b.dec)) continue;
      let nra = ((b.ra - raOffset) % (2 * Math.PI)) / (2 * Math.PI);
      if (nra < 0) nra += 1;
      const bx = nra * canvas.width;
      const by = (0.5 - b.dec / Math.PI) * canvas.height;
      if (bx < -100 || bx > canvas.width + 100 || by < -100 || by > canvas.height + 100) continue;

      if (b.sun) {
        const gr1 = ctx.createRadialGradient(bx, by, 0, bx, by, b.s * 8 * dpr);
        gr1.addColorStop(0, "rgba(255, 250, 240, 0.04)");
        gr1.addColorStop(1, "rgba(255, 250, 240, 0)");
        ctx.fillStyle = gr1;
        ctx.fillRect(bx - b.s * 8 * dpr, by - b.s * 8 * dpr, b.s * 16 * dpr, b.s * 16 * dpr);

        const gr2 = ctx.createRadialGradient(bx, by, 0, bx, by, b.s * 2.5 * dpr);
        gr2.addColorStop(0, "rgba(255, 250, 235, 0.25)");
        gr2.addColorStop(0.5, "rgba(255, 240, 220, 0.08)");
        gr2.addColorStop(1, "rgba(255, 240, 220, 0)");
        ctx.fillStyle = gr2;
        ctx.fillRect(bx - b.s * 2.5 * dpr, by - b.s * 2.5 * dpr, b.s * 5 * dpr, b.s * 5 * dpr);

        const coreEnd = 1 - 3 / (b.s * dpr);
        const gr3 = ctx.createRadialGradient(bx, by, 0, bx, by, b.s * dpr);
        gr3.addColorStop(0, "rgba(255, 250, 240, 1)");
        gr3.addColorStop(coreEnd * 0.5, "rgba(255, 245, 230, 0.95)");
        gr3.addColorStop(coreEnd, "rgba(255, 240, 215, 0.3)");
        gr3.addColorStop(1, "rgba(255, 240, 215, 0)");
        ctx.fillStyle = gr3;
        ctx.beginPath();
        ctx.arc(bx, by, b.s * dpr, 0, 6.2832);
        ctx.fill();
      } else {
        if (!b.c || !Array.isArray(b.c) || b.c.length < 3 || !Number.isFinite(b.s)) continue;
        const glow = ctx.createRadialGradient(bx, by, 0, bx, by, b.s * 3 * dpr);
        glow.addColorStop(0, `rgba(${b.c[0]},${b.c[1]},${b.c[2]},0.2)`);
        glow.addColorStop(1, `rgba(${b.c[0]},${b.c[1]},${b.c[2]},0)`);
        ctx.fillStyle = glow;
        ctx.fillRect(bx - b.s * 3 * dpr, by - b.s * 3 * dpr, b.s * 6 * dpr, b.s * 6 * dpr);

        ctx.fillStyle = `rgba(${b.c[0]},${b.c[1]},${b.c[2]},0.85)`;
        ctx.beginPath();
        ctx.arc(bx, by, b.s * dpr, 0, 6.2832);
        ctx.fill();
      }
    }
  }
}

// Static property used for render throttling.
renderStarfield._lastMs = 0;

function initializeWeatherOrb() {
  const { canvas } = getWeatherLayerNodes();
  if (!canvas) {
    reportFatal("Could not find #weather-orb-canvas");
    return;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    reportFatal("Could not get 2D context for #weather-orb-canvas");
    return;
  }

  // Render the orb at a capped DPR for performance.
  const resizeOrb = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  };
  resizeOrb();
  window.addEventListener("resize", resizeOrb);

  loadStarCatalog();
  loadWeatherGeometry();

  setupGlobeInteraction(canvas);

  const render = (timestamp) => {
    try {
      renderStarfield(timestamp);
    } catch (err) {
      reportFatal(err);
    }
    try {
      drawWeatherOrbFrame(ctx, canvas, timestamp);
    } catch (err) {
      reportFatal(err);
    }
    window.requestAnimationFrame(render);
  };

  window.requestAnimationFrame(render);
}

function getCountryThumbnailDataURL(iso3, w, h) {
  const polygons = weatherOrbState.countryShapes?.get(iso3);
  if (!polygons || !polygons.length) return null;

  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
  }
  if (minLat >= maxLat || minLon >= maxLon) return null;

  const pad = 3;
  const rangeLon = maxLon - minLon || 1;
  const rangeLat = maxLat - minLat || 1;
  const scale = Math.min((w - pad * 2) / rangeLon, (h - pad * 2) / rangeLat);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  const cx = w / 2, cy = h / 2;
  const midLon = (minLon + maxLon) / 2, midLat = (minLat + maxLat) / 2;

  for (const polygon of polygons) {
    for (const [ringIdx, ring] of polygon.entries()) {
      ctx.beginPath();
      let started = false;
      for (const [lon, lat] of ring) {
        const x = cx + (lon - midLon) * scale;
        const y = cy - (lat - midLat) * scale;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      if (ringIdx === 0) {
        ctx.fillStyle = "rgba(180, 200, 220, 0.10)";
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(180, 200, 220, 0.40)";
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  }

  return canvas.toDataURL();
}

const WORD_SEGMENTER = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "word" })
  : null;
const SYLLABLE_VOWEL_CHARS = "aeiouyāēīōūæœəɨɪʊɔɒàáâäãåèéêëìíîïòóôöõøùúûüýÿṛḷḹ";
const SYLLABLE_VOWEL_RE = new RegExp(`[${SYLLABLE_VOWEL_CHARS}]`, "i");
const SYLLABLE_WORD_RE = new RegExp(
  `[^${SYLLABLE_VOWEL_CHARS}]*[${SYLLABLE_VOWEL_CHARS}]+(?:[^${SYLLABLE_VOWEL_CHARS}]+(?=[${SYLLABLE_VOWEL_CHARS}]|$))?`,
  "gi",
);

function isWordToken(text) {
  return /[\p{L}\p{N}]/u.test(String(text || ""));
}

function splitSyllableLikeWord(word) {
  const input = String(word || "");
  if (input.length <= 4) return [input];
  if (!SYLLABLE_VOWEL_RE.test(input)) return [input];
  const chunks = input.match(SYLLABLE_WORD_RE);
  return chunks && chunks.length > 1 ? chunks : [input];
}

function splitColorSegments(text, mode = "word") {
  const input = String(text || "");
  if (!input) return [];

  const rawSegments = WORD_SEGMENTER
    ? Array.from(WORD_SEGMENTER.segment(input), (part) => ({
        text: part.segment,
        wordLike: !!part.isWordLike,
      }))
    : (input.match(/\s+|[^\s]+/g) || []).map((segment) => ({
        text: segment,
        wordLike: isWordToken(segment),
      }));

  const segments = [];
  for (const segment of rawSegments) {
    if (!segment.text) continue;
    if (/^\s+$/.test(segment.text)) {
      segments.push({ text: segment.text, colorable: false });
      continue;
    }

    if (mode === "syllable" && segment.wordLike) {
      const pieces = splitSyllableLikeWord(segment.text);
      if (pieces.length > 1) {
        for (const piece of pieces) {
          segments.push({ text: piece, colorable: true });
        }
        continue;
      }
    }

    segments.push({ text: segment.text, colorable: segment.wordLike });
  }

  return segments;
}

const NEWS_SEGMENT_COLORS = [
  "255 107 107", // red
  "254 202 87",  // amber
  "72 219 251",  // cyan
  "29 209 161",  // mint
  "84 160 255",  // blue
  "95 39 205",   // indigo
  "200 214 229", // silver
];

function hashSegmentText(text, mode = "word") {
  let hash = 2166136261;
  const input = `${mode}::${String(text || "").normalize("NFC")}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function setColorCodedSegments(target, text, className, mode = "word") {
  target.textContent = "";
  const parts = splitColorSegments(text, mode);
  for (const part of parts) {
    if (!part?.text) continue;
    if (!part.colorable) {
      target.appendChild(document.createTextNode(part.text));
      continue;
    }
    const span = document.createElement("span");
    span.className = className;
    const colorIndex = hashSegmentText(part.text, mode) % NEWS_SEGMENT_COLORS.length;
    span.style.setProperty("--seg-color", NEWS_SEGMENT_COLORS[colorIndex]);
    span.textContent = part.text;
    target.appendChild(span);
  }
}

function renderNewsItem(item) {
  const row = document.createElement("li");
  row.className = "news-row";

  const original = document.createElement("div");
  original.className = "news-original";

  const da = document.createElement("div");
  da.className = "news-da";

  const english = document.createElement("div");
  english.className = "news-en";

  const originalText = item.title || item.headline || item.text || "";
  const daText = item.da || "Translating…";
  const englishText = item.english || "Translating…";
  const language = item.language || "";
  const originalMode = language === "en" || isProbablyEnglishText(originalText) ? "word" : "syllable";

  // Color-code segments by position so each original segment maps visually to its transliteration.
  setColorCodedSegments(original, originalText, "syllable", originalMode);
  setColorCodedSegments(da, daText, "translation", "syllable");
  setColorCodedSegments(english, englishText, "translation", "word");

  row.append(original, da, english);
  return row;
}

async function hydrateNewsItem(row, originalText, language = "") {
  const daEl = row.querySelector(".news-da");
  const englishEl = row.querySelector(".news-en");
  if (!daEl || !englishEl) return;

  const [daText, englishText] = await Promise.all([
    toDaDisplay(originalText, language),
    toEnglishDisplay(originalText, language),
  ]);

  setColorCodedSegments(daEl, daText || originalText, "translation", "syllable");
  setColorCodedSegments(englishEl, englishText || originalText, "translation", "word");
}

async function renderCountries(countries) {
  const root = countryUi.root || document.querySelector("#country-list");
  root.innerHTML = "";
  const frag = document.createDocumentFragment();

  if (!countries.length) {
    const article = document.createElement("article");
    article.className = "country-row";
    article.tabIndex = -1;
    const rank = document.createElement("div");
    rank.className = "country-rank";
    rank.textContent = "—";
    const body = document.createElement("div");
    body.className = "country-copy";
    const name = document.createElement("p");
    name.className = "country-headline";
    name.textContent = "No matches found.";
    const desc = document.createElement("p");
    desc.className = "country-description";
    desc.textContent = "Try a broader search or clear the filter to restore the full list.";
    body.append(name, desc);
    const pop = document.createElement("div");
    pop.className = "country-population";
    pop.textContent = "0";
    article.append(rank, document.createElement("div"), body, pop);
    frag.appendChild(article);
    root.appendChild(frag);
    return;
  }

  for (let index = 0; index < countries.length; index += 1) {
    const item = countries[index];
    const thumbUrl = getCountryThumbnailDataURL(item.iso3, 52, 39);
    const rowId = item._rowId || buildCountryRowId(item, index);

    const article = document.createElement("article");
    article.className = "country-row";
    article.id = rowId;
    article.tabIndex = -1;

    const rank = document.createElement("div");
    rank.className = "country-rank";
    rank.textContent = `#${index + 1}`;

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "country-thumb-wrap";
    if (thumbUrl) {
      const img = document.createElement("img");
      img.className = "country-thumb";
      img.src = thumbUrl;
      img.width = 52;
      img.height = 39;
      img.alt = "";
      thumbWrap.appendChild(img);
    }

    const body = document.createElement("div");
    body.className = "country-copy";

    const name = document.createElement("p");
    name.className = "country-headline";
    name.id = `${rowId}-title`;
    name.textContent = item.name || "";

    const code = document.createElement("span");
    code.className = "country-code";
    code.textContent = item.iso3 || "";

    const header = document.createElement("div");
    header.className = "news-list-header";
    const h1 = document.createElement("span");
    h1.textContent = "Original";
    const h2 = document.createElement("span");
    h2.textContent = "ÐΛ Core + kit";
    const h3 = document.createElement("span");
    h3.textContent = "English translation";
    header.append(h1, h2, h3);

    const newsList = document.createElement("ul");
    newsList.className = "news-list";

    const headlineText = item.title || item.headline || item.text || "No headline.";
    const row = renderNewsItem({ headline: headlineText, language: item.language || "" });
    newsList.appendChild(row);
    hydrateNewsItem(row, headlineText, item.language || "").catch((err) => reportFatal(err));

    body.append(name, code, header, newsList);

    const population = document.createElement("div");
    population.className = "country-population";
    population.appendChild(document.createTextNode(populationFormatter.format(item.population)));
    const year = document.createElement("span");
    year.textContent = item.year || "";
    population.appendChild(year);

    article.setAttribute("aria-labelledby", name.id);
    article.append(rank, thumbWrap, body, population);
    frag.appendChild(article);
  }

  root.appendChild(frag);
}

function renderLoading() {
  const root = document.querySelector("#country-list");
  root.innerHTML = "";
  const article = document.createElement("article");
  article.className = "country-row";
  const rank = document.createElement("div");
  rank.className = "country-rank";
  rank.textContent = "...";
  const thumbWrap = document.createElement("div");
  thumbWrap.className = "country-thumb-wrap";
  const body = document.createElement("div");
  const title = document.createElement("p");
  title.className = "country-headline";
  title.textContent = "Loading";
  body.appendChild(title);
  const pop = document.createElement("div");
  pop.className = "country-population";
  pop.textContent = "...";
  article.append(rank, thumbWrap, body, pop);
  root.appendChild(article);
}

function renderError() {
  const root = document.querySelector("#country-list");
  root.innerHTML = "";
  const article = document.createElement("article");
  article.className = "country-row";
  const rank = document.createElement("div");
  rank.className = "country-rank";
  rank.textContent = "!";
  const thumbWrap = document.createElement("div");
  thumbWrap.className = "country-thumb-wrap";
  const body = document.createElement("div");
  const title = document.createElement("p");
  title.className = "country-headline";
  title.textContent = "Could not load data.";
  body.appendChild(title);
  const pop = document.createElement("div");
  pop.className = "country-population";
  pop.textContent = "ERR";
  article.append(rank, thumbWrap, body, pop);
  root.appendChild(article);
}

async function loadCountries() {
  const response = await fetch(DATA_URL);
  const countries = await response.json();
  allCountries = countries.map((item, index) => ({
    ...item,
    _rowId: buildCountryRowId(item, index),
    _search: buildCountrySearchIndex(item),
  }));
  syncCountryControls(allCountries);
  if (countryUi.filterInput && !countryUi.filterInput.dataset.bound) {
    countryUi.filterInput.dataset.bound = "1";
    countryUi.filterInput.addEventListener("input", () => {
      applyCountryFilter().catch((err) => reportFatal(err));
    });
  }
  if (countryUi.jumpSelect && !countryUi.jumpSelect.dataset.bound) {
    countryUi.jumpSelect.dataset.bound = "1";
    countryUi.jumpSelect.addEventListener("change", () => {
      const targetId = countryUi.jumpSelect.value;
      if (!targetId) return;
      const target = document.getElementById(targetId);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        target.focus({ preventScroll: true });
      }
      countryUi.jumpSelect.value = "";
    });
  }
  await applyCountryFilter();
}

initializeWeatherOrb();
renderLoading();
updateCountrySummary(0, 0);
loadCountries().catch((err) => {
  console.error("Failed to load country data:", err);
  renderError();
  if (countryUi.summary) countryUi.summary.textContent = "Could not load country data.";
});
