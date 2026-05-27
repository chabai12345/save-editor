#!/usr/bin/env node
/**
 * 存档分析编辑工具 — Universal Save File Analyzer & Editor
 * 用法: node analyze_save.js <命令> <存档路径> [参数...]
 *
 * 支持的引擎/格式:
 *   RPG Maker, Ren'Py, Unity, Unreal, Godot, AGS, Smile Game Builder,
 *   Wolf RPG, TyranoBuilder, KiriKiri, QSP, Flash SOL, The Witcher 3, 等
 *   序列化: JSON, CBOR, MessagePack, BSON, Python Pickle, .NET NRBF
 *   压缩: ZIP, GZip, BZip2, Zstd, LZ4, Brotli, Deflate, Base64, LZString
 *   编码: UTF-8, UTF-16, Shift-JIS, GB18030, 等
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const LZString = require(path.join(__dirname, "node_modules/lz-string"));
const iconv = require("iconv-lite");

// 延迟加载（部分解析器只在需要时加载）
let cbor, msgpackr, unbzip2, lz4js;

function lazyCbor() { if (!cbor) cbor = require("cbor"); return cbor; }
function lazyMsgpack() { if (!msgpackr) msgpackr = require("msgpackr"); return msgpackr; }
function lazyBzip2() { if (!unbzip2) unbzip2 = require("unbzip2-stream"); return unbzip2; }
function lazyLz4() { if (!lz4js) lz4js = require("lz4js"); return lz4js; }

// ===================== 格式注册表 =====================
// 每种格式包含: name, extensions, magic (可选), check (可选函数), desc, group

const FORMATS = [
  // === RPG Maker 系列 ===
  { name: "RPG Maker MZ", exts: [".rmmzsave"], magic: [], group: "rpgmaker", desc: "RPG Maker MZ 存档 (LZ-String 压缩 JSON)" },
  { name: "RPG Maker MV", exts: [".rpgsave"],  magic: [], group: "rpgmaker", desc: "RPG Maker MV 存档 (LZ-String 压缩 JSON)" },
  { name: "RPG Maker VX Ace", exts: [".rvdata2"], magic: [], group: "ruby_marshal", desc: "RPG Maker VX Ace 存档 (Ruby Marshal 序列化)" },
  { name: "RPG Maker VX", exts: [".rvdata"], magic: [], group: "ruby_marshal", desc: "RPG Maker VX 存档 (Ruby Marshal 序列化)" },
  { name: "RPG Maker XP", exts: [".rxdata"], magic: [], group: "ruby_marshal", desc: "RPG Maker XP 存档 (Ruby Marshal 序列化)" },
  { name: "RPG Maker 2000/2003", exts: [".lsd"], magic: [], group: "rpgmaker2k", desc: "RPG Maker 2000/2003 存档" },
  { name: "Pixel Game Maker MV", exts: [".sav", ".dat"], check: (buf) => buf.slice(0,4).toString() === "PGMV", group: "pgmmv", desc: "Pixel Game Maker MV 存档" },

  // === Ren'Py ===
  { name: "Ren'Py", exts: [".save"], check: (buf) => buf.slice(0,2).toString() === "PK", zipHint: "renpy_version", group: "renpy", desc: "Ren'Py 存档 (ZIP 容器, 含截图+序列化数据)" },
  { name: "Ren'Py (旧格式)", exts: [".save"], check: (buf) => buf.slice(0,9).toString() === "RENPYSAVE", group: "renpy_old", desc: "Ren'Py 存档 (旧格式)" },

  // === ZIP 基容器 ===
  { name: "ZIP Archive", exts: [], magic: [[0x50,0x4B,0x03,0x04]], group: "zip", desc: "ZIP 压缩存档" },
  { name: "TyranoBuilder", exts: [".sav"], check: (buf) => buf.slice(0,2).toString() === "PK" && buf.slice(0x1E,0x22).toString().includes("tyrano"), group: "tyrano", desc: "TyranoBuilder 存档 (ZIP 容器)" },

  // === Unity 系列 ===
  { name: "Unity Easy Save 3", exts: [".es3"], magic: [], group: "es3", desc: "Unity Easy Save 3 存档" },
  { name: "Unity/NET (可能)", exts: [".save", ".dat", ".sav"], check: (buf) => buf.slice(0,2).toString() === "PK" && !buf.slice(0x1E,0x22).toString().includes("tyrano"), group: "unity_zip", desc: "Unity / .NET 游戏存档 (ZIP 容器)" },
  { name: "Adventure Creator", exts: [".save", ".dat"], check: (buf) => buf.toString("utf8",0,200).includes("ACDebug"), group: "adventure_creator", desc: "Adventure Creator (Unity) 存档" },
  { name: ".NET BinaryFormatter", exts: [], check: (buf) => buf.slice(0,2).toString("hex") === "0001", group: "net_nrbf", desc: ".NET BinaryFormatter (NRBF) 序列化" },

  // === 压缩格式 ===
  { name: "GZip", exts: [".gz"], magic: [[0x1F,0x8B]], group: "gzip", desc: "GZip 压缩" },
  { name: "BZip2", exts: [".bz2"], magic: [[0x42,0x5A]], group: "bzip2", desc: "BZip2 压缩" },
  { name: "Zstd", exts: [".zst"], magic: [[0x28,0xB5,0x2F,0xFD]], group: "zstd", desc: "Zstd 压缩" },
  { name: "LZ4", exts: [".lz4"], magic: [[0x04,0x22,0x4D,0x18]], group: "lz4", desc: "LZ4 压缩" },
  { name: "Brotli", exts: [".br"], magic: [[0xCE,0xB2,0xCF,0x81]], group: "brotli", desc: "Brotli 压缩" },
  { name: "raw Deflate", exts: [], check: (buf) => { try { zlib.inflateSync(buf.slice(0,100)); return true; } catch { return false; }}, group: "deflate", desc: "raw Deflate 数据" },

  // === Unreal Engine ===
  { name: "Unreal Engine 4/5", exts: [".sav"], check: (buf) => buf.toString("utf8", 0, 50).includes("GVAS"), group: "unreal", desc: "Unreal Engine 4/5 存档 (GVAS 格式)" },

  // === Godot ===
  { name: "Godot Engine", exts: [".save", ".dat", ".cfg", ".ini"], check: (buf) => buf.slice(0,4).toString() === "GDPC", group: "godot", desc: "Godot Engine 存档" },

  // === Wolf RPG ===
  { name: "Wolf RPG Editor", exts: [".sav"], check: (buf) => buf.slice(0,8).toString("hex").toUpperCase() === "574F4C460000", group: "wolf", desc: "Wolf RPG Editor 存档" },

  // === 其他引擎 ===
  { name: "Adventure Game Studio", exts: [], check: (buf) => buf.toString("utf8",0,50).includes("Adventure Game Studio"), group: "ags", desc: "Adventure Game Studio 存档" },
  { name: "Smile Game Builder", exts: [".sgs"], magic: [], group: "sgb", desc: "Smile Game Builder / YUKAR SGS 存档" },
  { name: "The Witcher 3", exts: [".sav"], magic: [[0x03,0x00,0x00,0x00,0x00,0x00]], group: "witcher3", desc: "The Witcher 3 存档" },
  { name: "QSP", exts: [".sav"], check: (buf) => buf.slice(0,3).toString() === "QSP", group: "qsp", desc: "QSP 存档" },
  { name: "Flash Shared Object", exts: [".sol"], magic: [[0x00,0xBF]], group: "flash_sol", desc: "Flash Shared Object (.sol)" },
  { name: "RAGS Player", exts: [".rsv"], magic: [], group: "rags", desc: "RAGS Player 存档" },
  { name: "KiriKiri / KAG", exts: [".ksd"], magic: [], group: "kirikiri", desc: "KiriKiri / KAG 存档" },
  { name: "Naninovel", exts: [".json", ".nson"], magic: [], group: "naninovel", desc: "Naninovel 存档 (JSON/NSON)" },
  { name: "Visionaire Studio", exts: [".dat"], check: (buf) => buf.slice(0,4).toString() === "VISI", group: "visionaire", desc: "Visionaire Studio 存档" },
  { name: "Artemis Engine", exts: [".dat"], check: (buf) => buf.slice(0,4).toString() === "ARTM", group: "artemis", desc: "Artemis Engine 存档" },

  // === 序列化格式 ===
  { name: "CBOR", exts: [], check: (buf) => { const b = buf[0]; return (b >= 0x00 && b <= 0x1F) || b === 0x60 || b >= 0x80; }, group: "cbor", desc: "CBOR 二进制序列化" },
  { name: "MessagePack", exts: [], check: (buf) => { const b = buf[0]; return (b >= 0x80 && b <= 0x8F) || (b >= 0xA0 && b <= 0xBF) || (b >= 0xC0 && b <= 0xDF) || (b >= 0xE0 && b <= 0xFF); }, group: "msgpack", desc: "MessagePack 二进制序列化" },
  { name: "BSON", exts: [".bson"], check: (buf) => buf.length > 8 && buf[4] === 0x05 && buf[5] === 0x00 && buf[6] === 0x00 && buf[7] === 0x00, group: "bson", desc: "BSON 二进制 JSON" },
  { name: "plist (XML)", exts: [".plist"], check: (buf) => buf.toString("utf8",0,100).includes("<!DOCTYPE plist"), group: "plist", desc: "Apple plist (XML)" },
  { name: "plist (二进制)", exts: [".plist"], check: (buf) => buf.slice(0,6).toString() === "bplist", group: "bplist", desc: "Apple plist (二进制)" },
  { name: "SQLite DB", exts: [], check: (buf) => buf.toString("utf8",0,16) === "SQLite format 3\0", group: "sqlite", desc: "SQLite 数据库" },

  // === 通用 ===
  { name: "JSON", exts: [".json"], check: (buf) => { const s = buf.toString("utf8",0,100).trim(); return s.startsWith("{") || s.startsWith("["); }, group: "json", desc: "JSON 格式" },
  { name: "Base64 文本", exts: [], check: (buf) => { const s = buf.toString("utf8",0,200).trim(); return /^[A-Za-z0-9+/]{50,}={0,2}$/.test(s); }, group: "base64", desc: "Base64 编码数据" },
];

// ===================== 格式检测引擎 =====================

function detectFormat(filepath) {
  const raw = fs.readFileSync(filepath);
  const ext = path.extname(filepath).toLowerCase();
  const head = raw.slice(0, Math.min(raw.length, 4096));

  // 对每种格式，累积所有匹配类型
  const matched = {}; // name -> { fmt, matchTypes: Set }

  function addMatch(fmt, type) {
    if (!matched[fmt.name]) matched[fmt.name] = { fmt, matchTypes: new Set() };
    matched[fmt.name].matchTypes.add(type);
  }

  // 1) magic bytes
  for (const fmt of FORMATS) {
    if (fmt.magic && fmt.magic.length) {
      for (const m of fmt.magic) {
        if (m.length <= head.length && m.every((b, i) => head[i] === b)) {
          addMatch(fmt, "magic");
        }
      }
    }
    if (fmt.check) {
      try { if (fmt.check(head)) addMatch(fmt, "check"); }
      catch { /* skip */ }
    }
  }

  // 2) 扩展名匹配
  for (const fmt of FORMATS) {
    if (fmt.exts.includes(ext)) addMatch(fmt, "ext");
  }

  // 3) 独立的 ZIP 检测兜底
  const isZip = head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04;
  if (isZip && !Object.values(matched).some(m => ["zip","renpy","tyrano","unity_zip"].includes(m.fmt.group))) {
    const zipFmt = FORMATS.find(f => f.name === "ZIP Archive");
    if (zipFmt) addMatch(zipFmt, "magic");
  }

  // 评分：匹配条件越多越确定
  const results = Object.values(matched).map(({ fmt, matchTypes }) => {
    let score = 0;
    if (matchTypes.has("magic")) score += 60;
    if (matchTypes.has("check")) score += 40;
    if (matchTypes.has("ext") && fmt.exts.includes(ext)) score += 100;
    if (matchTypes.size >= 2) score += 50; // 组合匹配加分
    if (fmt.group === "json") score -= 30;
    if (fmt.group === "base64") score -= 40;
    if (fmt.group === "cbor" || fmt.group === "msgpack") score -= 20;
    if (fmt.name === "ZIP Archive") score -= 30;
    return { ...fmt, score, matchBy: [...matchTypes][0] };
  });

  results.sort((a, b) => b.score - a.score);
  const best = results[0] || { name: "未知", group: "unknown", desc: "无法识别格式" };
  return { name: best.name, group: best.group, desc: best.desc, fileSize: raw.length, raw, head };
}

// ===================== 容器解压 =====================

function tryDecompress(data, maxSize = 1024 * 1024) {
  const results = [];

  // 尝试 ZIP
  try {
    const { execSync } = require("child_process");
    const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "save_"));
    fs.writeFileSync(tmpDir + "/tmp.zip", data);
    const out = execSync(`unzip -l "${tmpDir}/tmp.zip" 2>&1`, { encoding: "utf8", maxBuffer: 1024 * 50 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    results.push({ type: "zip", info: "ZIP 容器", detail: out.slice(0, 500) });
  } catch { /* not zip */ }

  // 尝试 GZip
  try {
    const d = zlib.gunzipSync(data, { maxOutputLength: maxSize });
    results.push({ type: "gzip", info: "GZip 压缩", size: d.length });
  } catch { /* not gzip */ }

  // 尝试 Brotli
  try {
    const d = zlib.brotliDecompressSync(data, { maxOutputLength: maxSize });
    results.push({ type: "brotli", info: "Brotli 压缩", size: d.length });
  } catch { /* not brotli */ }

  // 尝试 BZip2
  try {
    const bz2 = lazyBzip2();
    // BZip2 is stream-based, skip auto-detection for now
  } catch { /* not bzip2 */ }

  // 尝试 raw Deflate
  try {
    const d = zlib.inflateSync(data, { maxOutputLength: maxSize });
    results.push({ type: "deflate", info: "raw Deflate 压缩", size: d.length });
  } catch { /* not deflate */ }

  // 尝试 LZ-String
  try {
    const s = data.toString("utf8").trim();
    const j = LZString.decompressFromBase64(s);
    if (j) results.push({ type: "lzstring", info: "LZ-String 压缩 JSON", size: j.length });
    else {
      // 尝试带 12 字节头
      const j2 = LZString.decompressFromBase64(s.slice(12));
      if (j2) results.push({ type: "lzstring", info: "LZ-String 压缩 JSON (带 12B 头)", size: j2.length });
    }
  } catch { /* not lzstring */ }

  // 尝试 Base64 decode
  try {
    const s = data.toString("utf8").trim();
    if (/^[A-Za-z0-9+/]{100,}={0,2}$/.test(s)) {
      const d = Buffer.from(s, "base64");
      if (d.length > 100) results.push({ type: "base64", info: "Base64 编码", size: d.length });
    }
  } catch { /* not base64 */ }

  return results;
}

// ===================== 编码检测 =====================

function detectEncoding(data) {
  const buf = data.slice(0, Math.min(data.length, 4096));
  const results = [];

  // BOM 检测
  if (buf[0] === 0xFF && buf[1] === 0xFE) results.push("UTF-16 LE (BOM)");
  if (buf[0] === 0xFE && buf[1] === 0xFF) results.push("UTF-16 BE (BOM)");
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) results.push("UTF-8 (BOM)");

  // 尝试各种编码解码
  const tests = [
    { name: "UTF-8", enc: "utf8" },
    { name: "UTF-16 LE", enc: "utf16le" },
    { name: "GB18030", enc: "gb18030" },
    { name: "Shift-JIS", enc: "shift-jis" },
    { name: "EUC-JP", enc: "euc-jp" },
    { name: "CP949", enc: "cp949" },
    { name: "Windows-1252", enc: "win1252" },
    { name: "Windows-1251", enc: "win1251" },
  ];

  for (const t of tests) {
    try {
      const decoded = iconv.decode(buf.slice(0, 200), t.enc);
      // 检查可读字符比例
      const printable = [...decoded].filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126 || c.charCodeAt(0) > 127).length;
      if (printable > decoded.length * 0.5 && decoded.length > 10) {
        results.push(t.name);
      }
    } catch { /* skip */ }
  }

  return [...new Set(results)];
}

// ===================== 引擎分析器 =====================

function tryZlibDecompress(utf8Str) {
  // RPG Maker MZ 格式: JSON → zlib → 以 UTF-8 编码存入文件
  // 解码: 读为 UTF-8 字符串 → 以 Latin-1 编码回原始 zlib 字节 → zlib 解压
  try {
    const latin1Buf = Buffer.from(utf8Str, "latin1");
    if (latin1Buf.length > 4 && latin1Buf[0] === 0x78) {
      const text = require("zlib").inflateSync(latin1Buf).toString("utf8");
      if (text.length > 10 && text.includes("{") && text.includes("}")) {
        return { data: JSON.parse(text), header: "" };
      }
    }
  } catch { /* not zlib */ }
  return null;
}

function analyzeRpgMaker(data, filepath, dataDir) {
  try {
    const raw = data.raw.toString("utf8").trim();
    let json = null, header = "";
    json = LZString.decompressFromBase64(raw);
    if (!json) {
      header = raw.slice(0, 12);
      json = LZString.decompressFromBase64(raw.slice(12));
    }
    if (!json) {
      // 尝试 MZ 格式 (zlib 压缩, UTF-8 编码存储)
      const mz = tryZlibDecompress(raw);
      if (mz) return mz;
      return null;
    }

    // 某些 MV 游戏使用双层压缩: LZ-String → Base64 → zlib → JSON
    // 特征: LZ-String 解压结果看起来是 Base64，且 decode 后是 zlib 流 (0x78)
    if (/^[A-Za-z0-9+/=]+$/.test(json.slice(0, 200))) {
      try {
        const zRaw = Buffer.from(json, "base64");
        if (zRaw.length > 2 && zRaw[0] === 0x78) {
          const zText = require("zlib").inflateSync(zRaw).toString("utf8");
          if (zText.length > 10) {
            json = zText;
          }
        }
      } catch { /* not zlib, keep original json */ }
    }

    return { data: JSON.parse(json), header };
  } catch { return null; }
}

function analyzeZipContainer(data, filepath) {
  try {
    const { execSync } = require("child_process");
    const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "save_"));
    fs.writeFileSync(tmpDir + "/tmp.zip", data);
    const out = execSync(`unzip -l "${tmpDir}/tmp.zip" 2>&1`, { encoding: "utf8", maxBuffer: 1024 * 50 });
    // 检查 Ren'Py 特征
    if (out.includes("renpy_version") || out.includes("log") || out.includes("screenshot.png")) {
      // 提取 json 元数据
      try {
        const jsonOut = execSync(`unzip -p "${tmpDir}/tmp.zip" json 2>&1`, { encoding: "utf8", maxBuffer: 1024 * 10 });
        const meta = JSON.parse(jsonOut.trim());
        const verOut = execSync(`unzip -p "${tmpDir}/tmp.zip" renpy_version 2>&1`, { encoding: "utf8", maxBuffer: 1024 });
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return { engine: "Ren'Py", meta, version: verOut.trim(), files: out };
      } catch { /* continue */ }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { engine: "ZIP Container", files: out };
  } catch { return null; }
}

function analyzeCBOR(data) {
  try {
    const d = lazyCbor().decodeAllSync(data.slice(0, Math.min(data.length, 50000)));
    return { parsed: JSON.stringify(d[0]).slice(0, 1000) };
  } catch { return null; }
}

function analyzeMsgPack(data) {
  try {
    const d = lazyMsgpack().decode(data.slice(0, Math.min(data.length, 50000)));
    return { parsed: JSON.stringify(d).slice(0, 1000) };
  } catch { return null; }
}

// ===================== 通用二进制分析 =====================

function analyzeBinary(filepath, fmt) {
  const data = fs.readFileSync(filepath);
  const size = data.length;

  console.log(`\n  大小: ${size} 字节 (${(size / 1024).toFixed(2)} KB)`);

  // 熵值
  const freq = {};
  for (const b of data) freq[b] = (freq[b] || 0) + 1;
  let entropy = 0;
  for (const c of Object.values(freq)) { const p = c / size; entropy -= p * Math.log2(p); }
  console.log(`  熵值: ${entropy.toFixed(4)}/8 (${entropy > 7 ? "加密/已压缩" : entropy > 5 ? "结构化压缩" : entropy > 3 ? "结构化数据" : "简单结构/文本"})`);

  // 前 32 字节
  const hex = data.slice(0, 32).toString("hex").toUpperCase().replace(/(.{2})/g, "$1 ").trim();
  const asc = data.slice(0, 32).map(b => b >= 32 && b <= 126 ? String.fromCharCode(b) : ".").join("");
  console.log(`  文件头 (HEX): ${hex}`);
  console.log(`  文件头 (ASC): ${asc}`);

  // 如果检测到了引擎，显示引擎信息
  if (fmt && fmt.name && fmt.name !== "未知") {
    console.log(`  引擎: ${fmt.name}`);
    console.log(`  说明: ${fmt.desc}`);
  }

  // 尝试解压容器
  const decomp = tryDecompress(data);
  for (const d of decomp) {
    console.log(`  📦 ${d.info}`);
  }

  // 编码检测
  const encodings = detectEncoding(data);
  if (encodings.length > 0) {
    console.log(`  编码: ${encodings[0]}`);
  }

  // ZIP 容器详细分析
  if (data[0] === 0x50 && data[1] === 0x4B && data[2] === 0x03 && data[3] === 0x04) {
    const zipInfo = analyzeZipContainer(data, filepath);
    if (zipInfo) {
      if (zipInfo.engine === "Ren'Py") {
        console.log(`  Ren'Py ${zipInfo.meta?._renpy_version ? `v${zipInfo.meta._renpy_version[0]}.${zipInfo.meta._renpy_version[1]}.${zipInfo.meta._renpy_version[2]}` : ""}`);
        console.log(`  游戏版本: ${zipInfo.meta?._version || "未知"}`);
        console.log(`  游戏时间: ${zipInfo.meta?._game_runtime ? Number(zipInfo.meta._game_runtime).toFixed(1) + "s" : "未知"}`);
        return { zipInfo };
      }
      return { zipInfo };
    }
  }

  // 尝试序列化解码
  if (fmt.group === "cbor" || (fmt.group === "unknown" && data[0] >= 0x00 && data[0] <= 0x1F)) {
    const cborData = analyzeCBOR(data);
    if (cborData) console.log(`  CBOR 数据: ${cborData.parsed.slice(0, 300)}` + (cborData.parsed.length > 300 ? "..." : ""));
  }
  if (fmt.group === "msgpack" || (fmt.group === "unknown" && (data[0] >= 0x80 && data[0] <= 0x8F))) {
    const mpData = analyzeMsgPack(data);
    if (mpData) console.log(`  MessagePack 数据: ${mpData.parsed.slice(0, 300)}` + (mpData.parsed.length > 300 ? "..." : ""));
  }

  // 字符串提取
  const strs = [];
  let current = "", off = 0;
  for (let i = 0; i < Math.min(data.length, 200000); i++) {
    if (data[i] >= 32 && data[i] <= 126) {
      if (!current) { off = i; }
      current += String.fromCharCode(data[i]);
    } else {
      if (current.length >= 5) strs.push({ s: current, off });
      current = "";
    }
  }
  if (current.length >= 5) strs.push({ s: current, off });
  // 过滤和去重
  const seen = new Set();
  const unique = strs.filter(s => { const k = s.s.slice(0,20); if (seen.has(k)) return false; seen.add(k); return true; });

  // 查找有价值的字符串（路径、名称、值）
  const valuable = unique.filter(s =>
    s.s.includes("/") || s.s.includes("\\") ||
    s.s.includes(".") || s.s.match(/[A-Z][a-z]{3,}/) ||
    s.s.match(/[a-z]{4,}/)
  );
  if (valuable.length > 0) {
    console.log(`\n  字符串 (前 20 条):`);
    for (const s of valuable.slice(0, 20)) {
      console.log(`    [0x${s.off.toString(16).padStart(8, "0")}] ${s.s.slice(0, 80)}`);
    }
    if (valuable.length > 20) console.log(`    ... 还有 ${valuable.length - 20} 条`);
  } else if (unique.length > 0) {
    console.log(`\n  字符串 (前 10 条):`);
    for (const s of unique.slice(0, 10)) console.log(`    [0x${s.off.toString(16).padStart(8, "0")}] ${s.s.slice(0, 80)}`);
  }

  // 数值区域
  const ranges = [];
  let inRange = false, rStart = 0;
  for (let i = 0; i <= data.length - 4; i += 4) {
    const v = data.readInt32LE(i);
    if (v > 0 && v < 999999 && v !== 0xFFFFFFFF) {
      if (!inRange) { rStart = i; inRange = true; }
    } else {
      if (inRange && i - rStart >= 16) ranges.push({ s: rStart, e: i });
      inRange = false;
    }
  }
  if (inRange && data.length - rStart >= 16) ranges.push({ s: rStart, e: data.length });

  if (ranges.length > 0) {
    // 合并相邻
    const merged = [];
    for (const r of ranges) {
      if (merged.length && r.s - merged.at(-1).e < 12) merged.at(-1).e = r.e;
      else merged.push(r);
    }
    console.log(`\n  int32 数值区域 (显示最多 5 段):`);
    for (const r of merged.slice(0, 5)) {
      const vals = [];
      for (let j = r.s; j < Math.min(r.s + 20, r.e); j += 4) vals.push(data.readInt32LE(j));
      console.log(`    [0x${r.s.toString(16).padStart(8,"0")}~0x${r.e.toString(16).padStart(8,"0")}] ${vals.slice(0, 6).join(", ")}...`);
    }
  }

  console.log(`\n  💡 提示: 存档受加密/压缩, 深度编辑需要特定引擎支持`);
}

// ===================== RPG Maker 引擎 =====================

function readRPGSave(filepath) {
  const raw = fs.readFileSync(filepath, "utf8").trim();
  let json = LZString.decompressFromBase64(raw);
  let header = "", zlib = false;
  if (!json) {
    header = raw.slice(0, 12);
    json = LZString.decompressFromBase64(raw.slice(12));
  }
  if (!json) {
    // 尝试 MZ 格式 (zlib 压缩, UTF-8 编码存储的二进制)
    const mz = tryZlibDecompress(raw);
    if (mz) return { ...mz, zlib: false, isMZ: true };
    throw new Error("无法解压 RPG Maker 存档");
  }

  // 某些 MV 游戏使用双层压缩: LZ-String → Base64 → zlib → JSON
  if (/^[A-Za-z0-9+/=]+$/.test(json.slice(0, 200))) {
    try {
      const zRaw = Buffer.from(json, "base64");
      if (zRaw.length > 2 && zRaw[0] === 0x78) {
        const zText = require("zlib").inflateSync(zRaw).toString("utf8");
        if (zText.length > 10) { json = zText; zlib = true; }
      }
    } catch { /* not zlib */ }
  }

  return { data: JSON.parse(json), header, zlib };
}

function writeRPGSave(filepath, obj, header, zlib, isMZ) {
  const bak = filepath + ".bak";
  if (!fs.existsSync(bak)) { fs.copyFileSync(filepath, bak); console.log("📦 备份:", path.basename(bak)); }
  const json = JSON.stringify(obj);
  let out;
  if (isMZ) {
    // MZ 格式: zlib 压缩 → 以 UTF-8 文本存储 (高字节被 UTF-8 多字节编码)
    const zRaw = require("zlib").deflateSync(json);
    out = zRaw.toString("latin1");
    fs.writeFileSync(filepath, out, "utf8");
  } else {
    out = LZString.compressToBase64(json);
    if (zlib) {
      const zRaw = require("zlib").deflateSync(json);
      out = LZString.compressToBase64(zRaw.toString("base64"));
    }
    fs.writeFileSync(filepath, header + out, "utf8");
  }
  console.log("✅ 已写回:", filepath);
}

function discoverDataDir(savePath) {
  const p = savePath.replace(/\\/g, "/");
  const parts = p.split("/");
  const patterns = [
    (base) => [...base, "www", "data"].join("/"),
    (base) => [...base, "data"].join("/"),
    (base) => base.join("/"),
  ];
  for (let i = parts.length - 2; i >= 0; i--) {
    const base = parts.slice(0, i);
    for (const pattern of patterns) {
      const candidate = pattern(base);
      if (fs.existsSync(candidate + "/System.json")) return candidate;
    }
  }
  return null;
}

function loadNames(dir) {
  try {
    const sys = JSON.parse(fs.readFileSync(dir + "/System.json", "utf8"));
    const load = (f) => {
      try {
        const a = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8"));
        const m = {};
        for (const i of a) if (i) m[i.id] = i.name;
        return m;
      } catch { return null; }
    };
    return {
      vNames: sys.variables || [], sNames: sys.switches || [],
      items: load("Items.json"), wpns: load("Weapons.json"),
      arms: load("Armors.json"), skills: load("Skills.json"),
    };
  } catch { return null; }
}

function unwrap(v) { return v && typeof v === "object" && v["@a"] != null ? v["@a"] : v; }

function printRpgMakerBasic(data) {
  // MV: actors._data["@a"]; MZ: actors._data 自身就是数组 (无 @a 包装)
  let a = data.actors?._data?.["@a"];
  if (!a) {
    const vals = Object.values(data.actors?._data || {});
    a = vals.filter(v => v && typeof v === "object" && v._actorId !== undefined);
  }
  a = a || [];
  console.log(`\n  存档 #${data.system?._saveCount}  版本ID: ${data.system?._versionId}`);
  console.log(`  地图 ${data.map?._mapId}  玩家 (${data.player?._x}, ${data.player?._y})`);
  console.log(`  金钱: ${data.party?._gold}  步数: ${data.party?._steps}`);
  for (const actor of a) {
    if (!actor) continue;
    const name = actor.__name || actor._name;
    if (!name) continue;
    const pp = unwrap(actor._paramPlus) || [];
    const exp = (typeof actor._exp === "object") ? (actor._exp[actor._classId] || 0) : actor._exp;
    console.log(`\n  【${name}】Lv.${actor._level}  EXP:${exp}`);
    console.log(`    HP:${actor._hp}  MP:${actor._mp}`);
    console.log(`    ATK+${pp[2]} DEF+${pp[3]} MAT+${pp[4]} MDF+${pp[5]} AGI+${pp[6]} LUK+${pp[7]}`);
  }
}

function printRpgMakerFull(data, names) {
  printRpgMakerBasic(data);
  const n = names;
  const nFn = (m, id) => m?.[id] ? `${m[id]}` : `ID:${id}`;

  // 物品
  console.log(`\n  ─ 物品栏 ─`);
  const party = data.party;
  let has = false;
  const each = (o, fn) => { if (o && typeof o === "object") for (const k of Object.keys(o)) if (!k.startsWith("@")) fn(parseInt(k), o[k]); };
  each(party?._items, (id, q) => { console.log(`    物品 ${nFn(n.items, id)} x${q}`); has = true; });
  each(party?._weapons, (id, q) => { console.log(`    武器 ${nFn(n.wpns, id)} x${q}`); has = true; });
  each(party?._armors, (id, q) => { console.log(`    防具 ${nFn(n.arms, id)} x${q}`); has = true; });
  if (!has) console.log(`    (空)`);

  // 变量 — 按名称类别汇总
  console.log(`\n  ─ 变量 (非零) ─`);
  const vars = unwrap(data.variables?._data) || [];
  const entries = vars.map((v, i) => ({ i, n: n.vNames[i] || `变量${i}`, v }));
  const nonZero = entries.filter(e => e.v !== 0 && e.v !== null && e.v !== undefined && e.v !== false);
  console.log(`  共 ${nonZero.length} 个非零变量`);

  const seen = new Set();
  const groups = [];
  const suffixGroups = ["好感度", "代入", "座標", "変数", "切替", "読込", "増加", "減少", "判定", "フラグ"];
  for (const sfx of suffixGroups) {
    const match = nonZero.filter(e => e.n.includes(sfx) && !seen.has(e.i));
    if (match.length) {
      match.forEach(e => seen.add(e.i));
      const isSimple = match.every(e => typeof e.v === "number");
      const detail = isSimple ? match.map(e => `${e.n.replace(sfx,"").trim()} ${e.v}`).join(", ") : `${match[0].n} = ${match[0].v} 等`;
      groups.push(`    ${sfx} (${match.length}个): ${detail}`);
    }
  }
  const symMatch = nonZero.filter(e => /^[★☆◆◇■□●○▲△▼▽]/.test(e.n) && !seen.has(e.i));
  if (symMatch.length) {
    symMatch.forEach(e => seen.add(e.i));
    const syms = [...new Set(symMatch.map(e => e.n[0]))].join("");
    groups.push(`    符号前缀「${syms}」(${symMatch.length}个): ${symMatch[0].n} = ${JSON.stringify(symMatch[0].v)} 等`);
  }
  const rest = nonZero.filter(e => !seen.has(e.i));
  if (rest.length) {
    const extra = rest.slice(0, 5).map(e => `${e.n}=${JSON.stringify(e.v)}`).join(", ");
    groups.push(`    其他 (${rest.length}个): ${extra}${rest.length > 5 ? "..." : ""}`);
  }
  groups.push(`    💡 输入 "展开变量" 可看完整列表`);
  console.log(groups.join("\n"));

  // 开关 — 按名称类别汇总
  console.log(`\n  ─ 开关 (ON) ─`);
  const sw = unwrap(data.switches?._data) || [];
  const onSwitches = sw.map((v, i) => ({ i, n: n.sNames[i] || `开关${i}`, v })).filter(e => e.v === true);
  console.log(`  共 ${onSwitches.length} 个开启的开关`);
  const sSeen = new Set();
  const sGroups = [];
  const sSuffixes = ["フラグ", "中", "ON", "OFF", "切替", "済", "開始", "終了", "入手", "クリア"];
  for (const sfx of sSuffixes) {
    const match = onSwitches.filter(e => e.n.includes(sfx) && !sSeen.has(e.i));
    if (match.length) {
      match.forEach(e => sSeen.add(e.i));
      sGroups.push(`    ${sfx} (${match.length}个): ${match.slice(0,3).map(e => e.n).join(", ")}${match.length > 3 ? "..." : ""}`);
    }
  }
  const sRest = onSwitches.filter(e => !sSeen.has(e.i));
  if (sRest.length) {
    sGroups.push(`    其他 (${sRest.length}个): ${sRest.slice(0,4).map(e => e.n).join(", ")}${sRest.length > 4 ? "..." : ""}`);
  }
  sGroups.push(`    💡 输入 "展开开关" 可看完整列表`);
  console.log(sGroups.join("\n"));
}

// ===================== info 命令 =====================

function cmdInfo(filepath) {
  const fmt = detectFormat(filepath);
  console.log(`\n${"=".repeat(56)}`);
  console.log(`  存档分析 — ${fmt.name}`);
  console.log(`${"=".repeat(56)}`);
  console.log(`  文件: ${path.basename(filepath)}`);
  console.log(`  格式: ${fmt.desc}`);
  console.log(`  大小: ${fmt.fileSize} 字节 (${(fmt.fileSize / 1024).toFixed(2)} KB)`);

  switch (fmt.group) {
    case "rpgmaker": {
      const r = analyzeRpgMaker(fmt, filepath);
      if (r) printRpgMakerBasic(r.data);
      else console.log(`  LZ-String 解压失败，尝试其他方式...`);
      break;
    }
    case "renpy": {
      const zi = analyzeZipContainer(fmt.raw, filepath);
      if (zi && zi.engine === "Ren'Py") {
        console.log(`  Ren'Py ${zi.meta?._renpy_version ? `v${zi.meta._renpy_version[0]}.${zi.meta._renpy_version[1]}.${zi.meta._renpy_version[2]}` : ""}`);
        console.log(`  游戏版本: ${zi.meta?._version || "未知"}`);
        console.log(`  游戏时间: ${zi.meta?._game_runtime ? Number(zi.meta._game_runtime).toFixed(1) + "s" : "未知"}`);
        console.log(`  存档名: "${zi.meta?._save_name || "无"}"`);
      }
      break;
    }
    default: {
      analyzeBinary(filepath, fmt);
    }
  }
}

// ===================== full 命令 =====================

function cmdFull(filepath, dataDir) {
  const fmt = detectFormat(filepath);
  console.log(`\n${"=".repeat(56)}`);
  console.log(`  存档完整分析 — ${fmt.name}`);
  console.log(`${"=".repeat(56)}`);

  switch (fmt.group) {
    case "rpgmaker": {
      const { data } = readRPGSave(filepath);
      const dir = dataDir || discoverDataDir(filepath);
      const names = dir ? loadNames(dir) : null;
      if (names) console.log(`  游戏数据: ${dir}`);
      else console.log(`  游戏数据: 未找到 (变量/物品将显示ID)`);
      printRpgMakerFull(data, names || { vNames: [], sNames: [], items: null, wpns: null, arms: null, skills: null });
      break;
    }
    case "renpy": {
      const zi = analyzeZipContainer(fmt.raw, filepath);
      if (zi && zi.engine === "Ren'Py") {
        console.log(`  引擎: Ren'Py ${zi.meta?._renpy_version ? `v${zi.meta._renpy_version[0]}.${zi.meta._renpy_version[1]}.${zi.meta._renpy_version[2]}` : ""}`);
        console.log(`  游戏版本: ${zi.meta?._version || "未知"}`);
        console.log(`  游戏时间: ${zi.meta?._game_runtime ? Number(zi.meta._game_runtime).toFixed(1) + "s" : "未知"}`);
        console.log(`  存档名: "${zi.meta?._save_name || "无"}"`);
        console.log(`\n  💡 Ren'Py 存档数据存储在 log 文件 (Python pickle 格式)`);
        console.log(`  当前仅支持元数据读取，深度解析需 Python 环境`);
      } else {
        analyzeBinary(filepath, fmt);
      }
      break;
    }
    default:
      cmdInfo(filepath);
  }
}

// ===================== 修改命令 =====================

function cmdSet(filepath, dotPath, rawValue) {
  const fmt = detectFormat(filepath);
  if (fmt.group !== "rpgmaker") throw new Error("写回仅支持 RPG Maker 格式");

  const { data, header, zlib, isMZ } = readRPGSave(filepath);
  const parts = dotPath.split(".");
  let cur = data;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
    if (cur === undefined) throw new Error(`路径不存在: ${parts.slice(0, i + 1).join(".")}`);
  }
  const lastKey = parts[parts.length - 1];
  const oldVal = cur[lastKey];
  let newVal;
  if (rawValue === "true") newVal = true;
  else if (rawValue === "false") newVal = false;
  else if (rawValue === "null") newVal = null;
  else if (!isNaN(rawValue) && rawValue !== "") newVal = Number(rawValue);
  else newVal = rawValue;

  console.log(`  修改: ${dotPath}`);
  console.log(`  旧值: ${JSON.stringify(oldVal)}`);
  console.log(`  新值: ${JSON.stringify(newVal)}`);
  cur[lastKey] = newVal;
  writeRPGSave(filepath, data, header, zlib, isMZ);
}

function cmdGold(filepath, amount) {
  const { data, header, zlib, isMZ } = readRPGSave(filepath);
  console.log(`  金钱: ${data.party._gold} → ${amount}`);
  data.party._gold = parseInt(amount);
  writeRPGSave(filepath, data, header, zlib, isMZ);
}

function cmdParam(filepath, index, value) {
  const { data, header, zlib, isMZ } = readRPGSave(filepath);
  const actor = (data.actors?._data?.["@a"] || [])[1];
  if (!actor) throw new Error("找不到角色");
  const pp = unwrap(actor._paramPlus);
  const labels = ["HP+", "MP+", "ATK+", "DEF+", "MAT+", "MDF+", "AGI+", "LUK+"];
  const idx = parseInt(index);
  console.log(`  ${actor._name} ${labels[idx]}: ${pp[idx]} → ${value}`);
  pp[idx] = parseInt(value);
  if (actor._paramPlus["@a"]) actor._paramPlus["@a"][idx] = parseInt(value);
  else actor._paramPlus = { "@c": 238, "@a": pp };
  writeRPGSave(filepath, data, header, zlib, isMZ);
}

function cmdAddItem(filepath, itemId, qty) {
  const { data, header, zlib, isMZ } = readRPGSave(filepath);
  const id = parseInt(itemId);
  const qt = parseInt(qty) || 1;
  const items = data.party._items || {};
  items[id] = (items[id] || 0) + qt;
  data.party._items = items;
  console.log(`  添加物品 ID:${id} x${qt}`);
  writeRPGSave(filepath, data, header);
}

// ===================== 展开变量/开关详情 =====================

function cmdVars(filepath, dataDir) {
  const { data } = readRPGSave(filepath);
  const dir = dataDir || discoverDataDir(filepath);
  const names = dir ? loadNames(dir) : null;
  const vNames = names?.vNames || [];
  const vars = unwrap(data.variables?._data) || [];
  let cnt = 0;
  for (let i = 0; i < vars.length; i++) {
    const v = vars[i];
    if (v !== 0 && v !== null && v !== undefined && v !== false) {
      console.log(`  [${i}] ${vNames[i] || `变量${i}`} = ${JSON.stringify(v)}`);
      cnt++;
    }
  }
  console.log(`\n  共 ${cnt} 个非零变量`);
}

function cmdSwitches(filepath, dataDir) {
  const { data } = readRPGSave(filepath);
  const dir = dataDir || discoverDataDir(filepath);
  const names = dir ? loadNames(dir) : null;
  const sNames = names?.sNames || [];
  const sw = unwrap(data.switches?._data) || [];
  let cnt = 0;
  for (let i = 0; i < sw.length; i++) {
    if (sw[i] === true) {
      console.log(`  ON [${i}] ${sNames[i] || `开关${i}`}`);
      cnt++;
    }
  }
  console.log(`\n  共 ${cnt} 个开启的开关`);
}

// ===================== 入口 =====================

const cmd = process.argv[2];
const file = process.argv[3];

if (!cmd || !file) {
  console.log(`
存档分析编辑工具 — Universal Save Editor
用法:
  node analyze_save.js info     <存档>              — 格式识别 + 基本信息
  node analyze_save.js full     <存档> [游戏目录]   — 完整分析 (支持深度解析的格式)
  node analyze_save.js vars     <存档> [游戏目录]   — 展开所有变量 (RPG Maker)
  node analyze_save.js switches <存档> [游戏目录]   — 展开所有开关 (RPG Maker)
  node analyze_save.js set      <存档> <路径> <值>  — 修改任意值 (RPG Maker)
  node analyze_save.js gold     <存档> <金额>       — 改金钱 (RPG Maker)
  node analyze_save.js param    <存档> <索引> <值>  — 改角色参数 (RPG Maker)
  node analyze_save.js additem  <存档> <ID> [数量]  — 添加物品 (RPG Maker)

支持的引擎: RPG Maker MV/MZ, Ren'Py, Unity, Unreal, Godot,
  Smile Game Builder, Wolf RPG, TyranoBuilder, KiriKiri, QSP,
  Flash SOL, AGS, The Witcher 3, Artemis, Visionaire, 等
序列化: JSON, CBOR, MessagePack, BSON
压缩: ZIP, GZip, BZip2, Zstd, LZ4, Brotli, Deflate, LZ-String
`);
  process.exit(1);
}

if (!fs.existsSync(file)) { console.error("❌ 文件不存在:", file); process.exit(1); }

try {
  switch (cmd) {
    case "info": cmdInfo(file); break;
    case "full": cmdFull(file, process.argv[4]); break;
    case "vars": cmdVars(file, process.argv[4]); break;
    case "switches": cmdSwitches(file, process.argv[4]); break;
    case "set": cmdSet(file, process.argv[4], process.argv[5]); break;
    case "gold": cmdGold(file, process.argv[4]); break;
    case "param": cmdParam(file, process.argv[4], process.argv[5]); break;
    case "additem": cmdAddItem(file, process.argv[3], process.argv[4]); break;
    default: console.error("未知命令:", cmd);
  }
} catch (e) { console.error("❌ 错误:", e.message); }
