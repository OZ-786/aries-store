"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const tls = require("tls");
const http = require("http");

const PORT_START = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const REVIEW_DAYS = 30;
const REVIEW_MS = REVIEW_DAYS * 24 * 60 * 60 * 1000;

const SECTIONS = [
  "Network equipment",
  "Cables & materials",
  "Tools",
  "Spare parts",
  "Consumables",
  "Safety",
  "Others",
];
const CONDITIONS = ["New", "Good", "Fair", "Poor", "Damaged"];
const STATUSES = ["In store", "Issued to site", "On site", "Returned", "Under repair", "Missing"];
const UNITS = ["pcs", "set", "pair", "roll", "box", "drum", "m", "kg", "bag"];
const SITE_STATUSES = new Set(["Issued to site", "On site"]);

const FIELD_LABELS = {
  tag: "Tag",
  name: "Name",
  section: "Section",
  quantity: "Quantity",
  unit: "Unit",
  condition: "Condition",
  status: "Status",
  storeLocation: "Store location",
  companyName: "Company",
  clientLocation: "Client location",
  handedTo: "Handed to",
  handedToPhone: "Phone",
  issuedOn: "Issued on",
  expectedReturn: "Expected return",
  serialNumber: "Serial number",
  notes: "Notes",
};

const sessions = new Map();

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: [], items: [], audit: [], seq: 1 }, null, 2));
  }
}

function loadDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, "utf8");
  const db = JSON.parse(raw);
  db.users ||= [];
  db.items ||= [];
  db.audit ||= [];
  db.resets ||= [];
  db.seq ||= 1;
  return db;
}

function saveDb(db) {
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  try {
    fs.renameSync(tmp, DB_PATH);
  } catch (err) {
    fs.rmSync(DB_PATH, { force: true });
    fs.renameSync(tmp, DB_PATH);
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const verify = crypto.scryptSync(password, salt, 32);
  const left = Buffer.from(hash, "hex");
  if (left.length !== verify.length) return false;
  return crypto.timingSafeEqual(left, verify);
}

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanBlock(value, max) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email || "",
    phone: user.phone || "",
    role: user.role,
    createdAt: user.createdAt,
  };
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function readContact(body) {
  const email = clean(body?.email, 120).toLowerCase();
  const phone = clean(body?.phone, 40);
  if (email && !validEmail(email)) return { error: "Enter a valid company email, or leave it blank." };
  if (phone && !/^[0-9+\-() ]{6,40}$/.test(phone)) return { error: "Enter a phone number with digits only, or leave it blank." };
  return { email, phone };
}

function findAccount(db, login) {
  const key = clean(login, 120).toLowerCase();
  return db.users.find((user) => user.username === key || (user.email && user.email === key)) || null;
}

function sendMail({ to, subject, text }) {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  if (!host || !from) return Promise.resolve(false);
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  return new Promise((resolve) => {
    let socket = net.connect(port, host);
    let buffer = "";
    let step = 0;
    let secure = false;
    const queue = ["EHLO aries-store", "STARTTLS"];
    const afterTls = [
      "EHLO aries-store",
      ...(user ? [`AUTH LOGIN`, Buffer.from(user).toString("base64"), Buffer.from(pass).toString("base64")] : []),
      `MAIL FROM:<${from}>`,
      `RCPT TO:<${to}>`,
      "DATA",
    ];
    const body = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n.`;
    function write(line) {
      socket.write(`${line}\r\n`);
    }
    function finish(ok) {
      try { socket.end(); } catch { /* already closed */ }
      resolve(ok);
    }
    function onData(chunk) {
      buffer += chunk.toString("utf8");
      if (!buffer.endsWith("\n")) return;
      const lines = buffer.trim().split(/\r?\n/);
      buffer = "";
      const last = lines[lines.length - 1] || "";
      const code = Number(last.slice(0, 3));
      if (code >= 400) {
        finish(false);
        return;
      }
      if (!secure && step >= queue.length) {
        socket.removeListener("data", onData);
        socket = tls.connect({ socket, servername: host }, () => {
          secure = true;
          step = 0;
          socket.on("data", onData);
          write(afterTls[step++]);
        });
        socket.on("error", () => finish(false));
        return;
      }
      const list = secure ? afterTls : queue;
      if (secure && step >= list.length) {
        write(body);
        socket.once("data", () => { write("QUIT"); finish(true); });
        return;
      }
      if (step < list.length) write(list[step++]);
    }
    socket.on("data", onData);
    socket.on("error", () => finish(false));
    socket.setTimeout(12000, () => finish(false));
  });
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return "";
      }
    }
  }
  return "";
}

function currentUser(req, db) {
  const token = readCookie(req, "sid");
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

function setSession(res, user) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { userId: user.id, createdAt: new Date().toISOString() });
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", path: "/" });
}

function clearSession(req, res) {
  const token = readCookie(req, "sid");
  if (token) sessions.delete(token);
  res.clearCookie("sid", { path: "/" });
}

function nextTag(db) {
  let max = 0;
  for (const item of db.items) {
    const match = /^AST-(\d+)$/i.exec(item.tag || "");
    if (match) max = Math.max(max, Number(match[1]));
  }
  db.seq = Math.max(db.seq || 1, max + 1);
  const tag = `AST-${String(db.seq).padStart(4, "0")}`;
  db.seq += 1;
  return tag;
}

function needsReview(item, now = Date.now()) {
  return now - new Date(item.updatedAt).getTime() > REVIEW_MS;
}

function parseQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1000000) return null;
  return Math.round(number * 100) / 100;
}

function parseDate(value) {
  const text = clean(value, 10);
  if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return text;
}

function validateItem(body, { existingTag } = {}) {
  const errors = [];
  const tag = clean(body.tag, 32).toUpperCase();
  const name = clean(body.name, 120);
  const section = clean(body.section, 40);
  const quantity = parseQuantity(body.quantity);
  const unit = clean(body.unit, 16);
  const condition = clean(body.condition, 20);
  const status = clean(body.status, 30);
  const storeLocation = clean(body.storeLocation, 160);
  const companyName = clean(body.companyName, 160);
  const clientLocation = clean(body.clientLocation, 200);
  const handedTo = clean(body.handedTo, 120);
  const handedToPhone = clean(body.handedToPhone, 40);
  const issuedOn = parseDate(body.issuedOn);
  const expectedReturn = parseDate(body.expectedReturn);
  const serialNumber = clean(body.serialNumber, 80);
  const notes = cleanBlock(body.notes, 2000);

  if (tag && !/^[A-Z0-9][A-Z0-9\-_/]{0,31}$/.test(tag)) errors.push("Tag can use letters, numbers, and dashes only.");
  if (!name) errors.push("Enter the item name.");
  if (!/^[A-Za-z0-9][A-Za-z0-9 &/+\-]{0,39}$/.test(section)) {
    errors.push("Choose a section, or enter a custom section using letters, numbers, and spaces.");
  }
  if (quantity == null) errors.push("Enter a quantity of zero or more.");
  if (!UNITS.includes(unit)) errors.push("Choose a unit.");
  if (!CONDITIONS.includes(condition)) errors.push("Choose a condition.");
  if (!STATUSES.includes(status)) errors.push("Choose a status.");
  if (issuedOn == null) errors.push("Issued date must be a real date.");
  if (expectedReturn == null) errors.push("Expected return must be a real date.");
  if (SITE_STATUSES.has(status)) {
    if (!companyName) errors.push("Enter the company name for an item on a client site.");
    if (!clientLocation) errors.push("Enter the client location for an item on a client site.");
    if (!handedTo) errors.push("Enter the person the item was handed to.");
  }

  return {
    errors,
    value: {
      tag,
      name,
      section,
      quantity,
      unit,
      condition,
      status,
      storeLocation,
      companyName,
      clientLocation,
      handedTo,
      handedToPhone,
      issuedOn: issuedOn || "",
      expectedReturn: expectedReturn || "",
      serialNumber,
      notes,
      previousTag: existingTag || "",
    },
  };
}

function describeChanges(before, after) {
  const parts = [];
  for (const key of Object.keys(FIELD_LABELS)) {
    const left = before[key] ?? "";
    const right = after[key] ?? "";
    if (String(left) !== String(right)) {
      parts.push(`${FIELD_LABELS[key]}: ${left === "" ? "—" : left} → ${right === "" ? "—" : right}`);
    }
  }
  return parts.join("; ");
}

function addAudit(db, entry) {
  db.audit.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...entry,
  });
  if (db.audit.length > 2000) db.audit.length = 2000;
}

function matchesFilters(item, query, now = Date.now()) {
  const q = clean(query.q, 120).toLowerCase();
  if (query.section && query.section !== "All" && item.section !== query.section) return false;
  if (query.status && query.status !== "All" && item.status !== query.status) return false;
  if (query.condition && query.condition !== "All" && item.condition !== query.condition) return false;
  if ((query.review === "1" || query.review === "true") && !needsReview(item, now)) return false;
  if (!q) return true;
  const haystack = [
    item.tag,
    item.name,
    item.section,
    item.condition,
    item.status,
    item.storeLocation,
    item.companyName,
    item.clientLocation,
    item.handedTo,
    item.handedToPhone,
    item.serialNumber,
    item.notes,
    item.updatedByName,
    item.createdByName,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function sortForExport(items) {
  return [...items].sort((a, b) => {
    const groupA = `${a.companyName} ${a.clientLocation}`.trim().toLowerCase();
    const groupB = `${b.companyName} ${b.clientLocation}`.trim().toLowerCase();
    if (groupA !== groupB) return groupA.localeCompare(groupB);
    return a.tag.localeCompare(b.tag);
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function buildCsv(items, summary) {
  const headers = [
    "Tag",
    "Name",
    "Section",
    "Quantity",
    "Unit",
    "Condition",
    "Status",
    "Store location",
    "Company name",
    "Client location",
    "Handed to",
    "Phone",
    "Issued on",
    "Expected return",
    "Serial number",
    "Notes",
    "Created by",
    "Created at",
    "Last updated by",
    "Last updated at",
  ];
  const lines = [];
  if (summary) {
    lines.push(["Summary", summary.label].map(csvCell).join(","));
    lines.push(["Items", summary.count, "Quantity", summary.quantity, "In store", summary.inStore, "Issued to site", summary.issued, "Missing", summary.missing, "Overdue returns", summary.overdue].map(csvCell).join(","));
    lines.push("");
  }
  lines.push(headers.join(","));
  for (const item of items) {
    lines.push(
      [
        item.tag,
        item.name,
        item.section,
        item.quantity,
        item.unit,
        item.condition,
        item.status,
        item.storeLocation,
        item.companyName,
        item.clientLocation,
        item.handedTo,
        item.handedToPhone,
        item.issuedOn,
        item.expectedReturn,
        item.serialNumber,
        item.notes,
        item.createdByName,
        item.createdAt,
        item.updatedByName,
        item.updatedAt,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

const PDF_WIN = { "—": "-", "–": "-", "’": "'", "‘": "'", "“": '"', "”": '"', "•": "-" };

function pdfEscape(value) {
  let out = "";
  for (const ch of String(value ?? "")) {
    const mapped = PDF_WIN[ch] || ch;
    const code = mapped.codePointAt(0);
    if (code === 10 || code === 13) continue;
    if (mapped === "\\" || mapped === "(" || mapped === ")") {
      out += `\\${mapped}`;
    } else if (code >= 32 && code <= 126) {
      out += mapped;
    } else if (code >= 160 && code <= 255) {
      out += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      out += "?";
    }
  }
  return out;
}

function wrapText(value, size, width) {
  const maxChars = Math.max(20, Math.floor(width / (size * 0.52)));
  const paragraphs = String(value ?? "").split(/\n/);
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const piece = word.length > maxChars ? word.slice(0, maxChars) : word;
      const next = line ? `${line} ${piece}` : piece;
      if (next.length > maxChars) {
        if (line) lines.push(line);
        line = piece;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [""];
}

function buildPdf(items, meta) {
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const left = 40;
  const right = 555;
  const contentWidth = right - left;
  const pages = [];
  let ops = [];
  let y = 0;

  function newPage() {
    if (ops.length) pages.push(ops);
    ops = [];
    y = 800;
    ops.push(["color", 0.94, 0.48, 0.05]);
    ops.push(["rect", left, y - 6, 18, 18]);
    ops.push(["color", 0.09, 0.09, 0.09]);
    ops.push(["text", "ARIES SYSTEMCOM", left + 26, y, 13, true]);
    y -= 16;
    ops.push(["color", 0.35, 0.35, 0.35]);
    ops.push(["text", "Tech Engineering Ltd.  ·  RC 680979  ·  Store inventory record", left + 26, y, 9, false]);
    y -= 12;
    ops.push(["color", 0.94, 0.48, 0.05]);
    ops.push(["line", left, y, right, y]);
    y -= 18;
    ops.push(["color", 0.09, 0.09, 0.09]);
  }

  function ensure(height) {
    if (y - height < 54) newPage();
  }

  function writeLine(text, size, bold, color, gap) {
    ensure(size + gap);
    ops.push(["color", ...color]);
    ops.push(["text", text, left, y, size, bold]);
    y -= size + gap;
  }

  newPage();
  writeLine("Store inventory record", 16, true, [0.09, 0.09, 0.09], 6);
  writeLine(meta.subtitle, 9, false, [0.28, 0.28, 0.28], 4);
  writeLine(`${items.length} item${items.length === 1 ? "" : "s"}  ·  ${meta.summary ? meta.summary.label : "All dates"}`, 9, false, [0.28, 0.28, 0.28], 12);

  if (meta.summary) {
    const summary = meta.summary;
    writeLine("Summary", 13, true, [0.09, 0.09, 0.09], 8);
    writeLine(`${summary.count} items   ·   ${summary.quantity} quantity   ·   ${summary.inStore} in store   ·   ${summary.issued} issued to site`, 10, false, [0.15, 0.15, 0.15], 6);
    writeLine(`${summary.missing} missing   ·   ${summary.attention} poor, damaged, or missing   ·   ${summary.overdue} overdue returns   ·   ${summary.changes} changes in this period`, 10, false, [0.15, 0.15, 0.15], 12);
    const drawBars = (title, pairs, color) => {
      writeLine(title, 11, true, [0.09, 0.09, 0.09], 8);
      const max = Math.max(1, ...pairs.map((pair) => pair[1]));
      if (!pairs.length) {
        writeLine("None", 9, false, [0.4, 0.4, 0.4], 8);
        return;
      }
      for (const [label, value] of pairs.slice(0, 6)) {
        ensure(18);
        ops.push(["color", 0.15, 0.15, 0.15]);
        ops.push(["text", String(label).slice(0, 22), left, y, 9, false]);
        const width = Math.max(4, Math.round((value / max) * 220));
        ops.push(["color", ...color]);
        ops.push(["rect", left + 140, y - 2, width, 9]);
        ops.push(["color", 0.25, 0.25, 0.25]);
        ops.push(["text", String(value), left + 148 + width, y, 9, false]);
        y -= 16;
      }
      y -= 4;
    };
    const tally = (key) => {
      const map = new Map();
      for (const item of items) map.set(item[key] || "—", (map.get(item[key] || "—") || 0) + 1);
      return [...map.entries()].sort((a, b) => b[1] - a[1]);
    };
    drawBars("Items by section", tally("section"), [0.94, 0.48, 0.05]);
    drawBars("Items by status", tally("status"), [0.12, 0.32, 0.55]);
    drawBars("Items by condition", tally("condition"), [0.12, 0.45, 0.28]);
    writeLine("Item records", 13, true, [0.09, 0.09, 0.09], 10);
  }

  if (!items.length) {
    writeLine("No items match this export.", 11, false, [0.2, 0.2, 0.2], 8);
  }

  let lastGroup = null;
  for (const item of items) {
    const group = item.companyName || item.clientLocation
      ? `${item.companyName || "Company not set"} — ${item.clientLocation || "Location not set"}`
      : "In the store";
    if (group !== lastGroup) {
      ensure(36);
      y -= 6;
      ops.push(["color", 0.09, 0.09, 0.09]);
      ops.push(["rect", left, y - 4, contentWidth, 18]);
      ops.push(["color", 1, 1, 1]);
      ops.push(["text", group, left + 8, y, 10, true]);
      y -= 22;
      lastGroup = group;
    }

    const rows = [
      ["Tag", item.tag, "Section", item.section],
      ["Item", item.name, "Quantity", `${item.quantity} ${item.unit}`],
      ["Condition", item.condition, "Status", item.status],
      ["Store location", item.storeLocation || "—", "Serial", item.serialNumber || "—"],
      ["Company", item.companyName || "—", "Client location", item.clientLocation || "—"],
      ["Handed to", item.handedTo || "—", "Phone", item.handedToPhone || "—"],
      ["Issued on", item.issuedOn || "—", "Expected return", item.expectedReturn || "—"],
      ["Recorded by", item.updatedByName || "—", "Updated", formatStamp(item.updatedAt)],
    ];

    ensure(28 + rows.length * 14 + (item.notes ? 28 : 8));
    ops.push(["color", 0.96, 0.95, 0.93]);
    const blockTop = y + 12;
    ops.push(["text", "", left, y, 9, false]);
    for (const row of rows) {
      ops.push(["color", 0.4, 0.4, 0.4]);
      ops.push(["text", row[0], left + 8, y, 8, false]);
      ops.push(["color", 0.1, 0.1, 0.1]);
      ops.push(["text", String(row[1]).slice(0, 32), left + 78, y, 9, false]);
      ops.push(["color", 0.4, 0.4, 0.4]);
      ops.push(["text", row[2], left + 270, y, 8, false]);
      ops.push(["color", 0.1, 0.1, 0.1]);
      ops.push(["text", String(row[3]).slice(0, 28), left + 360, y, 9, false]);
      y -= 13;
    }
    if (item.notes) {
      const noteLines = wrapText(item.notes, 9, contentWidth - 90).slice(0, 4);
      ops.push(["color", 0.4, 0.4, 0.4]);
      ops.push(["text", "Notes", left + 8, y, 8, false]);
      ops.push(["color", 0.1, 0.1, 0.1]);
      for (const line of noteLines) {
        ops.push(["text", line, left + 78, y, 9, false]);
        y -= 12;
      }
    }
    y -= 8;
    ops.push(["color", 0.85, 0.83, 0.8]);
    ops.push(["line", left, y + 4, right, y + 4]);
    void blockTop;
  }

  if (ops.length) pages.push(ops);

  const objects = [];
  function addObject(body) {
    objects.push(body);
    return objects.length;
  }

  const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject("PAGES");
  const fontRegular = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBold = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const pageIds = [];

  pages.forEach((pageOps, index) => {
    let stream = "0.08 0.08 0.08 RG\n0.5 w\n";
    for (const op of pageOps) {
      if (op[0] === "color") {
        stream += `${op[1]} ${op[2]} ${op[3]} rg\n${op[1]} ${op[2]} ${op[3]} RG\n`;
      } else if (op[0] === "text") {
        if (!op[1]) continue;
        const font = op[5] ? "/F2" : "/F1";
        stream += `BT ${font} ${op[4]} Tf 1 0 0 1 ${op[2]} ${op[3]} Tm (${pdfEscape(op[1])}) Tj ET\n`;
      } else if (op[0] === "line") {
        stream += `${op[1]} ${op[2]} m ${op[3]} ${op[4]} l S\n`;
      } else if (op[0] === "rect") {
        stream += `${op[1]} ${op[2]} ${op[3]} ${op[4]} re f\n`;
      }
    }
    stream += `BT /F1 8 Tf 0.4 0.4 0.4 rg 1 0 0 1 ${left} 32 Tm (Aries SystemCom Tech Engineering Ltd.  RC 680979) Tj ET\n`;
    stream += `BT /F1 8 Tf 1 0 0 1 ${right - 70} 32 Tm (Page ${index + 1} of ${pages.length}) Tj ET\n`;
    const contentId = addObject(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
    const pageId = addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> >>`
    );
    pageIds.push(pageId);
  });

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  void catalogId;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

function formatStamp(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      timeZone: "Africa/Lagos",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function requireUser(req, res, next) {
  const db = loadDb();
  const user = currentUser(req, db);
  if (!user) {
    res.status(401).json({ error: "Please sign in." });
    return;
  }
  req.db = db;
  req.user = user;
  next();
}

const routes = [];

function register(method, routePath, handlers) {
  const names = [];
  const pattern = routePath.replace(/:([^/]+)/g, (_match, name) => {
    names.push(name);
    return "([^/]+)";
  });
  routes.push({ method, names, regex: new RegExp(`^${pattern}$`), handlers });
}

const app = {
  disable() {},
  use() {},
  get(routePath, ...handlers) { register("GET", routePath, handlers); },
  post(routePath, ...handlers) { register("POST", routePath, handlers); },
  put(routePath, ...handlers) { register("PUT", routePath, handlers); },
  delete(routePath, ...handlers) { register("DELETE", routePath, handlers); },
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const db = loadDb();
  const user = currentUser(req, db);
  if (!user) {
    res.status(401).json({ error: "Please sign in." });
    return;
  }
  res.json({ user: publicUser(user), reviewDays: REVIEW_DAYS });
});

app.post("/api/auth/register", (req, res) => {
  const db = loadDb();
  const actor = currentUser(req, db);
  const name = clean(req.body?.name, 80);
  const username = clean(req.body?.username, 32).toLowerCase();
  const password = String(req.body?.password || "");
  const contact = readContact(req.body);
  if (contact.error) {
    res.status(400).json({ error: contact.error });
    return;
  }
  if (name.length < 2) {
    res.status(400).json({ error: "Enter the person's full name. It is recorded on every change." });
    return;
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    res.status(400).json({ error: "Username must be 3–32 characters: letters, numbers, dots, or dashes." });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters." });
    return;
  }
  if (db.users.some((user) => user.username === username)) {
    res.status(400).json({ error: "That username is already in use." });
    return;
  }
  if (contact.email && db.users.some((user) => user.email === contact.email)) {
    res.status(400).json({ error: "That company email is already on an account." });
    return;
  }
  const user = {
    id: crypto.randomUUID(),
    name,
    username,
    email: contact.email,
    phone: contact.phone,
    passwordHash: hashPassword(password),
    role: db.users.length === 0 ? "admin" : "staff",
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  addAudit(db, {
    userId: actor?.id || user.id,
    userName: actor?.name || user.name,
    action: "account",
    itemId: "",
    tag: "",
    itemName: "",
    details: `${user.name} (@${user.username}) created an account as ${user.role}.`,
  });
  saveDb(db);
  if (!actor) setSession(res, user);
  res.status(201).json({ user: publicUser(user), signedIn: !actor });
});

app.post("/api/auth/login", (req, res) => {
  const db = loadDb();
  const password = String(req.body?.password || "");
  const user = findAccount(db, req.body?.username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: "Username, email, or password is incorrect." });
    return;
  }
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/forgot", async (req, res) => {
  const db = loadDb();
  const email = clean(req.body?.email, 120).toLowerCase();
  const user = db.users.find((entry) => entry.email && entry.email === email);
  if (!user) {
    res.json({
      mailed: false,
      message: "If that company email is on an account, a reset was started. Otherwise ask an administrator to set a new password.",
    });
    return;
  }
  const code = String(crypto.randomInt(100000, 1000000));
  db.resets = (db.resets || []).filter((entry) => entry.userId !== user.id);
  db.resets.unshift({
    id: crypto.randomUUID(),
    userId: user.id,
    userName: user.name,
    email: user.email,
    codeHash: hashPassword(code),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    status: "open",
    createdAt: new Date().toISOString(),
  });
  const mailed = await sendMail({
    to: user.email,
    subject: "Aries Store password reset",
    text: `Hello ${user.name},\n\nYour Aries Store reset code is ${code}. It expires in 15 minutes.\n\nIf you did not ask for this, tell an administrator.\n`,
  });
  if (!mailed) db.resets[0].status = "needs-admin";
  addAudit(db, {
    userId: user.id,
    userName: user.name,
    action: "account",
    itemId: "",
    tag: "",
    itemName: "",
    details: mailed
      ? `${user.name} requested a password reset by email.`
      : `${user.name} requested a password reset. Mail is not configured, so an administrator needs to set the password.`,
  });
  saveDb(db);
  res.json({
    mailed,
    message: mailed
      ? "A 6-digit code was sent to that company email. It expires in 15 minutes."
      : "Company mail is not set up on this server yet. An administrator can set a new password from Accounts.",
  });
});

app.post("/api/auth/reset", (req, res) => {
  const db = loadDb();
  const email = clean(req.body?.email, 120).toLowerCase();
  const code = clean(req.body?.code, 12);
  const next = String(req.body?.password || "");
  const user = db.users.find((entry) => entry.email && entry.email === email);
  const reset = (db.resets || []).find((entry) => entry.email === email && entry.status === "open");
  if (!user || !reset || new Date(reset.expiresAt).getTime() < Date.now() || !verifyPassword(code, reset.codeHash)) {
    res.status(400).json({ error: "That reset code is incorrect or has expired." });
    return;
  }
  if (next.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters." });
    return;
  }
  user.passwordHash = hashPassword(next);
  reset.status = "used";
  addAudit(db, {
    userId: user.id,
    userName: user.name,
    action: "account",
    itemId: "",
    tag: "",
    itemName: "",
    details: `${user.name} set a new password with an email code.`,
  });
  saveDb(db);
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/profile", requireUser, (req, res) => {
  const contact = readContact(req.body);
  if (contact.error) {
    res.status(400).json({ error: contact.error });
    return;
  }
  if (contact.email && req.db.users.some((user) => user.email === contact.email && user.id !== req.user.id)) {
    res.status(400).json({ error: "That company email is already on an account." });
    return;
  }
  req.user.email = contact.email;
  req.user.phone = contact.phone;
  addAudit(req.db, {
    userId: req.user.id,
    userName: req.user.name,
    action: "account",
    itemId: "",
    tag: "",
    itemName: "",
    details: `${req.user.name} updated their company email and phone.`,
  });
  saveDb(req.db);
  res.json({ user: publicUser(req.user) });
});

app.post("/api/auth/logout", (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.post("/api/auth/password", requireUser, (req, res) => {
  const current = String(req.body?.current || "");
  const next = String(req.body?.next || "");
  if (!verifyPassword(current, req.user.passwordHash)) {
    res.status(400).json({ error: "Current password is incorrect." });
    return;
  }
  if (next.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters." });
    return;
  }
  req.user.passwordHash = hashPassword(next);
  saveDb(req.db);
  res.json({ ok: true });
});

app.get("/api/users", requireUser, (req, res) => {
  const users = req.db.users
    .map(publicUser)
    .sort((a, b) => a.name.localeCompare(b.name));
  const resets = req.user.role === "admin"
    ? (req.db.resets || [])
      .filter((entry) => entry.status === "needs-admin" || entry.status === "open")
      .map((entry) => ({
        id: entry.id,
        userId: entry.userId,
        userName: entry.userName,
        email: entry.email,
        status: entry.status,
        createdAt: entry.createdAt,
      }))
    : [];
  res.json({ users, resets });
});

app.post("/api/users/:id/password", requireUser, (req, res) => {
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Only an administrator can set another person's password." });
    return;
  }
  const next = String(req.body?.password || "");
  if (next.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters." });
    return;
  }
  const user = req.db.users.find((entry) => entry.id === req.params.id);
  if (!user) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  user.passwordHash = hashPassword(next);
  for (const entry of req.db.resets || []) {
    if (entry.userId === user.id && entry.status !== "used") entry.status = "set-by-admin";
  }
  addAudit(req.db, {
    userId: req.user.id,
    userName: req.user.name,
    action: "account",
    itemId: "",
    tag: "",
    itemName: "",
    details: `${req.user.name} set a new password for ${user.name}.`,
  });
  saveDb(req.db);
  res.json({ ok: true });
});

app.delete("/api/users/:id", requireUser, (req, res) => {
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Only an administrator can remove an account." });
    return;
  }
  if (req.params.id === req.user.id) {
    res.status(400).json({ error: "You cannot remove the account you are signed in with." });
    return;
  }
  const index = req.db.users.findIndex((user) => user.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  const [removed] = req.db.users.splice(index, 1);
  const admins = req.db.users.filter((user) => user.role === "admin");
  if (!admins.length) {
    req.db.users.splice(index, 0, removed);
    res.status(400).json({ error: "Keep at least one administrator." });
    return;
  }
  addAudit(req.db, {
    userId: req.user.id,
    userName: req.user.name,
    action: "account",
    itemId: "",
    tag: "",
    itemName: "",
    details: `${req.user.name} removed the account ${removed.name} (@${removed.username}).`,
  });
  saveDb(req.db);
  res.json({ ok: true });
});

app.get("/api/items", requireUser, (req, res) => {
  const items = [...req.db.items].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ items, reviewDays: REVIEW_DAYS });
});

app.post("/api/items", requireUser, (req, res) => {
  const { errors, value } = validateItem(req.body || {});
  if (errors.length) {
    res.status(400).json({ error: errors[0], errors });
    return;
  }
  let tag = value.tag;
  if (!tag) tag = nextTag(req.db);
  if (req.db.items.some((item) => item.tag.toUpperCase() === tag)) {
    res.status(400).json({ error: "That tag is already used. Leave it blank to assign the next tag." });
    return;
  }
  const now = new Date().toISOString();
  const item = {
    ...value,
    tag,
    id: crypto.randomUUID(),
    createdAt: now,
    createdBy: req.user.id,
    createdByName: req.user.name,
    updatedAt: now,
    updatedBy: req.user.id,
    updatedByName: req.user.name,
  };
  delete item.previousTag;
  req.db.items.push(item);
  addAudit(req.db, {
    userId: req.user.id,
    userName: req.user.name,
    action: "created",
    itemId: item.id,
    tag: item.tag,
    itemName: item.name,
    details: `${req.user.name} added ${item.name} (${item.tag}) to ${item.section}. Quantity ${item.quantity} ${item.unit}, ${item.condition}, ${item.status}.`,
  });
  saveDb(req.db);
  res.status(201).json({ item });
});

app.put("/api/items/:id", requireUser, (req, res) => {
  const item = req.db.items.find((entry) => entry.id === req.params.id);
  if (!item) {
    res.status(404).json({ error: "Item not found. It may have been removed." });
    return;
  }
  if (req.body?.updatedAt && req.body.updatedAt !== item.updatedAt) {
    res.status(409).json({ error: `${item.updatedByName} updated this item while you were editing. Reload it and enter the change again.` });
    return;
  }
  const { errors, value } = validateItem(req.body || {}, { existingTag: item.tag });
  if (errors.length) {
    res.status(400).json({ error: errors[0], errors });
    return;
  }
  let tag = value.tag || item.tag;
  if (req.db.items.some((entry) => entry.id !== item.id && entry.tag.toUpperCase() === tag)) {
    res.status(400).json({ error: "That tag is already used by another item." });
    return;
  }
  const before = { ...item };
  const changes = describeChanges(before, { ...value, tag });
  Object.assign(item, value, { tag });
  delete item.previousTag;
  item.updatedAt = new Date().toISOString();
  item.updatedBy = req.user.id;
  item.updatedByName = req.user.name;
  addAudit(req.db, {
    userId: req.user.id,
    userName: req.user.name,
    action: changes ? "updated" : "reviewed",
    itemId: item.id,
    tag: item.tag,
    itemName: item.name,
    details: changes
      ? `${req.user.name} updated ${item.name} (${item.tag}). ${changes}`
      : `${req.user.name} confirmed ${item.name} (${item.tag}) is up to date.`,
  });
  saveDb(req.db);
  res.json({ item });
});

app.post("/api/items/:id/review", requireUser, (req, res) => {
  const item = req.db.items.find((entry) => entry.id === req.params.id);
  if (!item) {
    res.status(404).json({ error: "Item not found." });
    return;
  }
  item.updatedAt = new Date().toISOString();
  item.updatedBy = req.user.id;
  item.updatedByName = req.user.name;
  addAudit(req.db, {
    userId: req.user.id,
    userName: req.user.name,
    action: "reviewed",
    itemId: item.id,
    tag: item.tag,
    itemName: item.name,
    details: `${req.user.name} confirmed ${item.name} (${item.tag}) is up to date.`,
  });
  saveDb(req.db);
  res.json({ item });
});

app.delete("/api/items/:id", requireUser, (req, res) => {
  const index = req.db.items.findIndex((entry) => entry.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ error: "Item not found." });
    return;
  }
  const [item] = req.db.items.splice(index, 1);
  addAudit(req.db, {
    userId: req.user.id,
    userName: req.user.name,
    action: "deleted",
    itemId: item.id,
    tag: item.tag,
    itemName: item.name,
    details: `${req.user.name} removed ${item.name} (${item.tag}). Last status ${item.status}. Company ${item.companyName || "—"}. Location ${item.clientLocation || item.storeLocation || "—"}. Handed to ${item.handedTo || "—"}. Quantity ${item.quantity} ${item.unit}.`,
  });
  saveDb(req.db);
  res.json({ ok: true });
});

app.get("/api/audit", requireUser, (req, res) => {
  res.json({ audit: req.db.audit.slice(0, 300) });
});

function resolvePeriod(query) {
  const now = new Date();
  const monthStart = (year, month) => new Date(year, month, 1).getTime();
  const monthEnd = (year, month) => new Date(year, month + 1, 1).getTime() - 1;
  const period = query.period || "all";
  if (period === "this-month") {
    return { from: monthStart(now.getFullYear(), now.getMonth()), to: monthEnd(now.getFullYear(), now.getMonth()), label: "This month" };
  }
  if (period === "last-month") {
    return { from: monthStart(now.getFullYear(), now.getMonth() - 1), to: monthEnd(now.getFullYear(), now.getMonth() - 1), label: "Last month" };
  }
  if (period === "this-year") {
    return { from: new Date(now.getFullYear(), 0, 1).getTime(), to: new Date(now.getFullYear(), 11, 31, 23, 59, 59).getTime(), label: "This year" };
  }
  if (period === "last-year") {
    return { from: new Date(now.getFullYear() - 1, 0, 1).getTime(), to: new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59).getTime(), label: "Last year" };
  }
  if (period === "custom") {
    const from = query.from ? new Date(`${query.from}T00:00:00`).getTime() : null;
    const to = query.to ? new Date(`${query.to}T23:59:59`).getTime() : null;
    return { from, to, label: `Custom ${query.from || "start"} to ${query.to || "today"}` };
  }
  return { from: null, to: null, label: "All dates" };
}

function stampInRange(value, range) {
  if (!value) return false;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return false;
  if (range.from != null && time < range.from) return false;
  if (range.to != null && time > range.to) return false;
  return true;
}

function itemInPeriod(item, range) {
  if (range.from == null && range.to == null) return true;
  return [item.updatedAt, item.createdAt, item.issuedOn ? `${item.issuedOn}T12:00:00` : ""].some((value) => stampInRange(value, range));
}

function reportSummary(items, audit, range) {
  const today = new Date().toISOString().slice(0, 10);
  const issued = items.filter((item) => item.status === "Issued to site" || item.status === "On site").length;
  const changes = (audit || []).filter((entry) => stampInRange(entry.at, range) && entry.action !== "account").length;
  return {
    label: range.label,
    count: items.length,
    quantity: Number(items.reduce((sum, item) => sum + Number(item.quantity || 0), 0).toFixed(2)),
    inStore: items.filter((item) => item.status === "In store" || item.status === "Returned").length,
    issued,
    missing: items.filter((item) => item.status === "Missing").length,
    attention: items.filter((item) => item.condition === "Poor" || item.condition === "Damaged" || item.status === "Missing").length,
    overdue: items.filter((item) => item.expectedReturn && item.expectedReturn < today && (item.status === "Issued to site" || item.status === "On site")).length,
    changes,
  };
}

function filteredItems(req) {
  const now = Date.now();
  const range = resolvePeriod(req.query);
  return sortForExport(req.db.items.filter((item) => matchesFilters(item, req.query, now) && itemInPeriod(item, range)));
}

app.get("/api/export/csv", requireUser, (req, res) => {
  const items = filteredItems(req);
  const range = resolvePeriod(req.query);
  const summary = reportSummary(items, req.db.audit, range);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="aries-store-inventory-${stamp}.csv"`);
  res.send(buildCsv(items, summary));
});

app.get("/api/export/pdf", requireUser, (req, res) => {
  const items = filteredItems(req);
  const range = resolvePeriod(req.query);
  const summary = reportSummary(items, req.db.audit, range);
  const stamp = new Date().toISOString().slice(0, 10);
  const filters = [summary.label];
  if (req.query.section && req.query.section !== "All") filters.push(req.query.section);
  if (req.query.status && req.query.status !== "All") filters.push(req.query.status);
  if (req.query.condition && req.query.condition !== "All") filters.push(req.query.condition);
  if (req.query.q) filters.push(`Search "${clean(req.query.q, 80)}"`);
  if (req.query.review === "1") filters.push(`Not updated in ${REVIEW_DAYS} days`);
  const pdf = buildPdf(items, {
    subtitle: `Prepared by ${req.user.name} on ${formatStamp(new Date().toISOString())}  ·  ${filters.join(" · ")}`,
    summary,
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="aries-store-inventory-${stamp}.pdf"`);
  res.send(pdf);
});

function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
  };
  res.send = (body) => {
    res.end(body);
  };
  res.cookie = (name, value) => {
    res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/`);
  };
  res.clearCookie = (name) => {
    res.setHeader("Set-Cookie", `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        req.destroy();
        reject(Object.assign(new Error("too big"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function runHandlers(handlers, req, res, index = 0) {
  const handler = handlers[index];
  if (!handler) return;
  handler(req, res, () => runHandlers(handlers, req, res, index + 1));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(pathname, res) {
  const publicRoot = path.resolve(ROOT, "docs");
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = path.resolve(publicRoot, `.${requested}`);
  if (file !== publicRoot && !file.startsWith(publicRoot + path.sep)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (path.extname(requested)) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(fs.readFileSync(path.join(publicRoot, "index.html")));
    return;
  }
  res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.end(fs.readFileSync(file));
}

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if ((entry.family === "IPv4" || entry.family === 4) && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function listen(port) {
  const server = http.createServer(async (req, res) => {
    try {
      decorate(res);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.setHeader("Referrer-Policy", "same-origin");
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      req.query = Object.fromEntries(url.searchParams);
      req.params = {};
      req.body = req.method === "GET" || req.method === "HEAD" || req.method === "DELETE" ? {} : await readBody(req);
      const route = routes.find((entry) => entry.method === req.method && entry.regex.test(url.pathname));
      if (!route) {
        if (req.method === "GET" || req.method === "HEAD") {
          serveStatic(url.pathname, res);
          return;
        }
        res.status(404).json({ error: "Not found." });
        return;
      }
      const match = url.pathname.match(route.regex);
      route.names.forEach((name, index) => {
        req.params[name] = match[index + 1];
      });
      runHandlers(route.handlers, req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.status(err.status || 500).json({
          error: err.status === 400 ? "The request could not be read." : "Something went wrong on the server.",
        });
      }
    }
  });
  server.listen(port, "0.0.0.0", () => {
    console.log("");
    console.log("Aries SystemCom store inventory is running.");
    console.log(`On this computer:  http://localhost:${port}`);
    for (const address of lanAddresses()) {
      console.log(`Other people:       http://${address}:${port}`);
    }
    console.log("");
    console.log("The first account created becomes the administrator.");
    console.log("Leave this window open while the store is in use.");
    console.log("");
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && port < PORT_START + 10) {
      listen(port + 1);
      return;
    }
    console.error(err);
    process.exit(1);
  });
}

if (require.main === module) {
  listen(PORT_START);
}

module.exports = { loadDb, REVIEW_DAYS };
