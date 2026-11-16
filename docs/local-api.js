"use strict";

// GitHub Pages cannot run the office server. On github.io, keep the same
// screens and store the record in this browser.
if (!location.hostname.endsWith("github.io")) {
  // The office server handles /api there.
} else {
  window.ARIES_LOCAL = true;
  const DB_KEY = "aries-store-db";
  const SID_KEY = "aries-store-sid";
  const SECTIONS = ["Network equipment", "Cables & materials", "Tools", "Spare parts", "Consumables", "Safety", "Others"];
  const CONDITIONS = ["New", "Good", "Fair", "Poor", "Damaged"];
  const STATUSES = ["In store", "Issued to site", "On site", "Returned", "Under repair", "Missing"];
  const UNITS = ["pcs", "set", "pair", "roll", "box", "drum", "m", "kg", "bag"];
  const SITE = new Set(["Issued to site", "On site"]);
  const REVIEW_MS = 30 * 24 * 60 * 60 * 1000;

  function loadDb() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DB_KEY) || "");
      parsed.users ||= [];
      parsed.items ||= [];
      parsed.audit ||= [];
      parsed.resets ||= [];
      parsed.seq ||= 1;
      return parsed;
    } catch {
      return { users: [], items: [], audit: [], resets: [], seq: 1 };
    }
  }

  function saveDb(db) {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  }

  function clean(value, max) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function cleanBlock(value, max) {
    return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
  }

  function bytesToHex(buffer) {
    return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function hashPassword(password, salt = crypto.randomUUID().replace(/-/g, "")) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: encoder.encode(salt), iterations: 120000, hash: "SHA-256" },
      key,
      256
    );
    return `${salt}:${bytesToHex(bits)}`;
  }

  async function verifyPassword(password, stored) {
    const [salt, hash] = String(stored || "").split(":");
    if (!salt || !hash) return false;
    const next = await hashPassword(password, salt);
    return next.split(":")[1] === hash;
  }

  function publicUser(user) {
    return { id: user.id, name: user.name, username: user.username, email: user.email || "", phone: user.phone || "", role: user.role, createdAt: user.createdAt };
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

  function sessionUser(db) {
    const id = sessionStorage.getItem(SID_KEY);
    return id ? db.users.find((user) => user.id === id) || null : null;
  }

  function addAudit(db, entry) {
    db.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
    if (db.audit.length > 2000) db.audit.length = 2000;
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

  function parseQuantity(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1000000) return null;
    return Math.round(number * 100) / 100;
  }

  function parseDate(value) {
    const text = clean(value, 10);
    if (!text) return "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    return text;
  }

  function validateItem(body) {
    const errors = [];
    const tag = clean(body.tag, 32).toUpperCase();
    const name = clean(body.name, 120);
    const section = clean(body.section, 40);
    const quantity = parseQuantity(body.quantity);
    const unit = clean(body.unit, 16);
    const condition = clean(body.condition, 20);
    const status = clean(body.status, 30);
    const value = {
      tag,
      name,
      section,
      quantity,
      unit,
      condition,
      status,
      storeLocation: clean(body.storeLocation, 160),
      companyName: clean(body.companyName, 160),
      clientLocation: clean(body.clientLocation, 200),
      handedTo: clean(body.handedTo, 120),
      handedToPhone: clean(body.handedToPhone, 40),
      issuedOn: parseDate(body.issuedOn),
      expectedReturn: parseDate(body.expectedReturn),
      serialNumber: clean(body.serialNumber, 80),
      notes: cleanBlock(body.notes, 2000),
    };
    if (tag && !/^[A-Z0-9][A-Z0-9\-_/]{0,31}$/.test(tag)) errors.push("Tag can use letters, numbers, and dashes only.");
    if (!name) errors.push("Enter the item name.");
    if (!/^[A-Za-z0-9][A-Za-z0-9 &/+\-]{0,39}$/.test(section)) errors.push("Choose a section, or enter a custom section using letters, numbers, and spaces.");
    if (quantity == null) errors.push("Enter a quantity of zero or more.");
    if (!UNITS.includes(unit)) errors.push("Choose a unit.");
    if (!CONDITIONS.includes(condition)) errors.push("Choose a condition.");
    if (!STATUSES.includes(status)) errors.push("Choose a status.");
    if (value.issuedOn == null) errors.push("Issued date must be a real date.");
    if (value.expectedReturn == null) errors.push("Expected return must be a real date.");
    if (SITE.has(status)) {
      if (!value.companyName) errors.push("Enter the company name for an item on a client site.");
      if (!value.clientLocation) errors.push("Enter the client location for an item on a client site.");
      if (!value.handedTo) errors.push("Enter the person the item was handed to.");
    }
    value.issuedOn = value.issuedOn || "";
    value.expectedReturn = value.expectedReturn || "";
    return { errors, value };
  }

  const LABELS = {
    tag: "Tag", name: "Name", section: "Section", quantity: "Quantity", unit: "Unit", condition: "Condition",
    status: "Status", storeLocation: "Store location", companyName: "Company", clientLocation: "Client location",
    handedTo: "Handed to", handedToPhone: "Phone", issuedOn: "Issued on", expectedReturn: "Expected return",
    serialNumber: "Serial number", notes: "Notes",
  };

  function describeChanges(before, after) {
    const parts = [];
    for (const key of Object.keys(LABELS)) {
      const left = before[key] ?? "";
      const right = after[key] ?? "";
      if (String(left) !== String(right)) parts.push(`${LABELS[key]}: ${left === "" ? "—" : left} → ${right === "" ? "—" : right}`);
    }
    return parts.join("; ");
  }

  function json(status, data) {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  function fileResponse(body, type, filename) {
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${filename}"` },
    });
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function buildCsv(items, summary) {
    const headers = ["Tag", "Name", "Section", "Quantity", "Unit", "Condition", "Status", "Store location", "Company name", "Client location", "Handed to", "Phone", "Issued on", "Expected return", "Serial number", "Notes", "Created by", "Created at", "Last updated by", "Last updated at"];
    const lines = [];
    if (summary) {
      lines.push(["Summary", summary.label].map(csvCell).join(","));
      lines.push(["Items", summary.count, "Quantity", summary.quantity, "In store", summary.inStore, "Issued to site", summary.issued, "Missing", summary.missing, "Overdue returns", summary.overdue].map(csvCell).join(","));
      lines.push("");
    }
    lines.push(headers.join(","));
    for (const item of items) {
      lines.push([item.tag, item.name, item.section, item.quantity, item.unit, item.condition, item.status, item.storeLocation, item.companyName, item.clientLocation, item.handedTo, item.handedToPhone, item.issuedOn, item.expectedReturn, item.serialNumber, item.notes, item.createdByName, item.createdAt, item.updatedByName, item.updatedAt].map(csvCell).join(","));
    }
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  function pdfEscape(value) {
    return String(value ?? "").replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, (char) => `\\${char}`);
  }

  function buildPdf(items, subtitle, summary) {
    const pages = [];
    let commands = [];
    let y = 800;
    function page() {
      if (commands.length) pages.push(commands);
      commands = [];
      y = 800;
      commands.push(`BT /F2 14 Tf 40 ${y} Td (${pdfEscape("ARIES SYSTEMCOM")}) Tj ET`);
      y -= 16;
      commands.push(`BT /F1 9 Tf 40 ${y} Td (${pdfEscape("Store inventory record  ·  RC 680979")}) Tj ET`);
      y -= 28;
    }
    function line(text, size = 10, bold = false) {
      if (y < 60) page();
      commands.push(`BT ${bold ? "/F2" : "/F1"} ${size} Tf 40 ${y} Td (${pdfEscape(text)}) Tj ET`);
      y -= size + 6;
    }
    function bars(title, pairs, color) {
      line(title, 11, true);
      const max = Math.max(1, ...pairs.map((pair) => pair[1]));
      if (!pairs.length) {
        line("None", 9);
        return;
      }
      for (const [label, value] of pairs.slice(0, 6)) {
        if (y < 60) page();
        const width = Math.max(4, Math.round((value / max) * 180));
        commands.push(`BT /F1 9 Tf 40 ${y} Td (${pdfEscape(String(label).slice(0, 22))}) Tj ET`);
        commands.push(`${color} rg`);
        commands.push(`${190} ${y - 2} ${width} 9 re f`);
        commands.push(`0.2 0.2 0.2 rg`);
        commands.push(`BT /F1 9 Tf ${200 + width} ${y} Td (${pdfEscape(String(value))}) Tj ET`);
        y -= 16;
      }
    }
    page();
    line(subtitle, 9);
    line(`${items.length} item${items.length === 1 ? "" : "s"}  ·  ${summary ? summary.label : "All dates"}`, 9);
    if (summary) {
      line("Summary", 13, true);
      line(`${summary.count} items   ${summary.quantity} quantity   ${summary.inStore} in store   ${summary.issued} issued to site`);
      line(`${summary.missing} missing   ${summary.attention} poor, damaged, or missing   ${summary.overdue} overdue returns   ${summary.changes} changes`);
      const tally = (key) => {
        const map = new Map();
        for (const item of items) map.set(item[key] || "—", (map.get(item[key] || "—") || 0) + 1);
        return [...map.entries()].sort((a, b) => b[1] - a[1]);
      };
      bars("Items by section", tally("section"), "0.94 0.48 0.05");
      bars("Items by status", tally("status"), "0.12 0.32 0.55");
      bars("Items by condition", tally("condition"), "0.12 0.45 0.28");
      line("Item records", 13, true);
    }
    y -= 8;
    if (!items.length) line("No items match this export.");
    for (const item of items) {
      line(`${item.tag}  ${item.name}`, 12, true);
      line(`${item.section}   ${item.quantity} ${item.unit}   ${item.condition}   ${item.status}`);
      line(`Store: ${item.storeLocation || "—"}    Serial: ${item.serialNumber || "—"}`);
      line(`Company: ${item.companyName || "—"}`);
      line(`Client location: ${item.clientLocation || "—"}`);
      line(`Handed to: ${item.handedTo || "—"}    Phone: ${item.handedToPhone || "—"}`);
      line(`Updated by ${item.updatedByName || "—"}`);
      y -= 8;
    }
    if (commands.length) pages.push(commands);
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };
    add("<< /Type /Catalog /Pages 2 0 R >>");
    const pagesId = add("PAGES");
    const font1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const font2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
    const kids = [];
    pages.forEach((content, index) => {
      let stream = content.join("\n") + "\n";
      stream += `BT /F1 8 Tf 40 32 Td (${pdfEscape(`Page ${index + 1} of ${pages.length}`)}) Tj ET\n`;
      const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> >>`));
    });
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((body, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i < offsets.length; i += 1) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return pdf;
  }

  function resolvePeriod(params) {
    const now = new Date();
    const monthStart = (year, month) => new Date(year, month, 1).getTime();
    const monthEnd = (year, month) => new Date(year, month + 1, 1).getTime() - 1;
    const period = params.get("period") || "all";
    if (period === "this-month") return { from: monthStart(now.getFullYear(), now.getMonth()), to: monthEnd(now.getFullYear(), now.getMonth()), label: "This month" };
    if (period === "last-month") return { from: monthStart(now.getFullYear(), now.getMonth() - 1), to: monthEnd(now.getFullYear(), now.getMonth() - 1), label: "Last month" };
    if (period === "this-year") return { from: new Date(now.getFullYear(), 0, 1).getTime(), to: new Date(now.getFullYear(), 11, 31, 23, 59, 59).getTime(), label: "This year" };
    if (period === "last-year") return { from: new Date(now.getFullYear() - 1, 0, 1).getTime(), to: new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59).getTime(), label: "Last year" };
    if (period === "custom") {
      const from = params.get("from") ? new Date(`${params.get("from")}T00:00:00`).getTime() : null;
      const to = params.get("to") ? new Date(`${params.get("to")}T23:59:59`).getTime() : null;
      return { from, to, label: `Custom ${params.get("from") || "start"} to ${params.get("to") || "today"}` };
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
    return {
      label: range.label,
      count: items.length,
      quantity: Number(items.reduce((sum, item) => sum + Number(item.quantity || 0), 0).toFixed(2)),
      inStore: items.filter((item) => item.status === "In store" || item.status === "Returned").length,
      issued: items.filter((item) => item.status === "Issued to site" || item.status === "On site").length,
      missing: items.filter((item) => item.status === "Missing").length,
      attention: items.filter((item) => item.condition === "Poor" || item.condition === "Damaged" || item.status === "Missing").length,
      overdue: items.filter((item) => item.expectedReturn && item.expectedReturn < today && (item.status === "Issued to site" || item.status === "On site")).length,
      changes: (audit || []).filter((entry) => stampInRange(entry.at, range) && entry.action !== "account").length,
    };
  }

  function filtered(items, params) {
    const q = clean(params.get("q"), 120).toLowerCase();
    const now = Date.now();
    const range = resolvePeriod(params);
    return items.filter((item) => {
      if (params.get("section") && params.get("section") !== "All" && item.section !== params.get("section")) return false;
      if (params.get("status") && params.get("status") !== "All" && item.status !== params.get("status")) return false;
      if (params.get("condition") && params.get("condition") !== "All" && item.condition !== params.get("condition")) return false;
      if (params.get("review") === "1" && now - new Date(item.updatedAt).getTime() <= REVIEW_MS) return false;
      if (!itemInPeriod(item, range)) return false;
      if (!q) return true;
      return [item.tag, item.name, item.companyName, item.clientLocation, item.storeLocation, item.handedTo, item.serialNumber, item.notes, item.updatedByName].join(" ").toLowerCase().includes(q);
    }).sort((a, b) => `${a.companyName} ${a.clientLocation}`.localeCompare(`${b.companyName} ${b.clientLocation}`) || a.tag.localeCompare(b.tag));
  }

  async function handle(url, init) {
    const db = loadDb();
    const user = sessionUser(db);
    const method = (init.method || "GET").toUpperCase();
    const path = url.pathname;
    let body = {};
    if (init.body) {
      try { body = JSON.parse(init.body); } catch { return json(400, { error: "The request could not be read." }); }
    }
    const requireUser = () => user || null;

    if (method === "GET" && path === "/api/auth/me") {
      if (!user) return json(401, { error: "Please sign in." });
      return json(200, { user: publicUser(user), reviewDays: 30 });
    }
    if (method === "POST" && path === "/api/auth/register") {
      const name = clean(body.name, 80);
      const username = clean(body.username, 32).toLowerCase();
      const password = String(body.password || "");
      const contact = readContact(body);
      if (contact.error) return json(400, { error: contact.error });
      if (name.length < 2) return json(400, { error: "Enter the person's full name. It is recorded on every change." });
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return json(400, { error: "Username must be 3–32 characters: letters, numbers, dots, or dashes." });
      if (password.length < 6) return json(400, { error: "Password must be at least 6 characters." });
      if (db.users.some((entry) => entry.username === username)) return json(400, { error: "That username is already in use." });
      if (contact.email && db.users.some((entry) => entry.email === contact.email)) return json(400, { error: "That company email is already on an account." });
      const created = { id: crypto.randomUUID(), name, username, email: contact.email, phone: contact.phone, passwordHash: await hashPassword(password), role: db.users.length === 0 ? "admin" : "staff", createdAt: new Date().toISOString() };
      db.users.push(created);
      addAudit(db, { userId: user?.id || created.id, userName: user?.name || created.name, action: "account", itemId: "", tag: "", itemName: "", details: `${created.name} (@${created.username}) created an account as ${created.role}.` });
      saveDb(db);
      if (!user) sessionStorage.setItem(SID_KEY, created.id);
      return json(201, { user: publicUser(created), signedIn: !user });
    }
    if (method === "POST" && path === "/api/auth/login") {
      const key = clean(body.username, 120).toLowerCase();
      const found = db.users.find((entry) => entry.username === key || (entry.email && entry.email === key));
      if (!found || !(await verifyPassword(String(body.password || ""), found.passwordHash))) return json(401, { error: "Username, email, or password is incorrect." });
      sessionStorage.setItem(SID_KEY, found.id);
      return json(200, { user: publicUser(found) });
    }
    if (method === "POST" && path === "/api/auth/forgot") {
      const email = clean(body.email, 120).toLowerCase();
      const found = db.users.find((entry) => entry.email && entry.email === email);
      if (found) {
        db.resets = (db.resets || []).filter((entry) => entry.userId !== found.id);
        db.resets.unshift({
          id: crypto.randomUUID(),
          userId: found.id,
          userName: found.name,
          email: found.email,
          status: "needs-admin",
          createdAt: new Date().toISOString(),
        });
        addAudit(db, { userId: found.id, userName: found.name, action: "account", itemId: "", tag: "", itemName: "", details: `${found.name} requested a password reset. An administrator needs to set the password.` });
        saveDb(db);
      }
      return json(200, { mailed: false, message: "This public page cannot send company mail. An administrator can set a new password from Accounts." });
    }
    if (method === "POST" && path === "/api/auth/reset") {
      return json(400, { error: "This public page cannot email a reset code. Ask an administrator to set a new password." });
    }
    if (method === "POST" && path === "/api/auth/logout") {
      sessionStorage.removeItem(SID_KEY);
      return json(200, { ok: true });
    }
    if (!requireUser()) return json(401, { error: "Please sign in." });

    if (method === "POST" && path === "/api/auth/password") {
      if (!(await verifyPassword(String(body.current || ""), user.passwordHash))) return json(400, { error: "Current password is incorrect." });
      if (String(body.next || "").length < 6) return json(400, { error: "New password must be at least 6 characters." });
      user.passwordHash = await hashPassword(String(body.next));
      saveDb(db);
      return json(200, { ok: true });
    }
    if (method === "POST" && path === "/api/auth/profile") {
      const contact = readContact(body);
      if (contact.error) return json(400, { error: contact.error });
      if (contact.email && db.users.some((entry) => entry.email === contact.email && entry.id !== user.id)) return json(400, { error: "That company email is already on an account." });
      user.email = contact.email;
      user.phone = contact.phone;
      addAudit(db, { userId: user.id, userName: user.name, action: "account", itemId: "", tag: "", itemName: "", details: `${user.name} updated their company email and phone.` });
      saveDb(db);
      return json(200, { user: publicUser(user) });
    }
    if (method === "GET" && path === "/api/users") {
      const resets = user.role === "admin"
        ? (db.resets || []).filter((entry) => entry.status === "needs-admin" || entry.status === "open").map((entry) => ({ id: entry.id, userId: entry.userId, userName: entry.userName, email: entry.email, status: entry.status, createdAt: entry.createdAt }))
        : [];
      return json(200, { users: db.users.map(publicUser).sort((a, b) => a.name.localeCompare(b.name)), resets });
    }
    const setPassword = path.match(/^\/api\/users\/([^/]+)\/password$/);
    if (setPassword && method === "POST") {
      if (user.role !== "admin") return json(403, { error: "Only an administrator can set another person's password." });
      if (String(body.password || "").length < 6) return json(400, { error: "New password must be at least 6 characters." });
      const target = db.users.find((entry) => entry.id === decodeURIComponent(setPassword[1]));
      if (!target) return json(404, { error: "Account not found." });
      target.passwordHash = await hashPassword(String(body.password));
      for (const entry of db.resets || []) {
        if (entry.userId === target.id && entry.status !== "used") entry.status = "set-by-admin";
      }
      addAudit(db, { userId: user.id, userName: user.name, action: "account", itemId: "", tag: "", itemName: "", details: `${user.name} set a new password for ${target.name}.` });
      saveDb(db);
      return json(200, { ok: true });
    }
    if (method === "DELETE" && path.startsWith("/api/users/")) {
      if (user.role !== "admin") return json(403, { error: "Only an administrator can remove an account." });
      const id = decodeURIComponent(path.split("/").pop());
      if (id === user.id) return json(400, { error: "You cannot remove the account you are signed in with." });
      const index = db.users.findIndex((entry) => entry.id === id);
      if (index < 0) return json(404, { error: "Account not found." });
      const [removed] = db.users.splice(index, 1);
      if (!db.users.some((entry) => entry.role === "admin")) {
        db.users.splice(index, 0, removed);
        return json(400, { error: "Keep at least one administrator." });
      }
      addAudit(db, { userId: user.id, userName: user.name, action: "account", itemId: "", tag: "", itemName: "", details: `${user.name} removed the account ${removed.name} (@${removed.username}).` });
      saveDb(db);
      return json(200, { ok: true });
    }
    if (method === "GET" && path === "/api/items") {
      const items = [...db.items].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      return json(200, { items, reviewDays: 30 });
    }
    if (method === "POST" && path === "/api/items") {
      const { errors, value } = validateItem(body);
      if (errors.length) return json(400, { error: errors[0], errors });
      let tag = value.tag || nextTag(db);
      if (db.items.some((item) => item.tag.toUpperCase() === tag)) return json(400, { error: "That tag is already used. Leave it blank to assign the next tag." });
      const now = new Date().toISOString();
      const item = { ...value, tag, id: crypto.randomUUID(), createdAt: now, createdBy: user.id, createdByName: user.name, updatedAt: now, updatedBy: user.id, updatedByName: user.name };
      db.items.push(item);
      addAudit(db, { userId: user.id, userName: user.name, action: "created", itemId: item.id, tag: item.tag, itemName: item.name, details: `${user.name} added ${item.name} (${item.tag}) to ${item.section}. Quantity ${item.quantity} ${item.unit}, ${item.condition}, ${item.status}.` });
      saveDb(db);
      return json(201, { item });
    }
    const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);
    const reviewMatch = path.match(/^\/api\/items\/([^/]+)\/review$/);
    if (reviewMatch && method === "POST") {
      const item = db.items.find((entry) => entry.id === decodeURIComponent(reviewMatch[1]));
      if (!item) return json(404, { error: "Item not found." });
      item.updatedAt = new Date().toISOString();
      item.updatedBy = user.id;
      item.updatedByName = user.name;
      addAudit(db, { userId: user.id, userName: user.name, action: "reviewed", itemId: item.id, tag: item.tag, itemName: item.name, details: `${user.name} confirmed ${item.name} (${item.tag}) is up to date.` });
      saveDb(db);
      return json(200, { item });
    }
    if (itemMatch && method === "PUT") {
      const item = db.items.find((entry) => entry.id === decodeURIComponent(itemMatch[1]));
      if (!item) return json(404, { error: "Item not found. It may have been removed." });
      if (body.updatedAt && body.updatedAt !== item.updatedAt) return json(409, { error: `${item.updatedByName} updated this item while you were editing. Reload it and enter the change again.` });
      const { errors, value } = validateItem(body);
      if (errors.length) return json(400, { error: errors[0], errors });
      const tag = value.tag || item.tag;
      if (db.items.some((entry) => entry.id !== item.id && entry.tag.toUpperCase() === tag)) return json(400, { error: "That tag is already used by another item." });
      const changes = describeChanges(item, { ...value, tag });
      Object.assign(item, value, { tag });
      item.updatedAt = new Date().toISOString();
      item.updatedBy = user.id;
      item.updatedByName = user.name;
      addAudit(db, { userId: user.id, userName: user.name, action: changes ? "updated" : "reviewed", itemId: item.id, tag: item.tag, itemName: item.name, details: changes ? `${user.name} updated ${item.name} (${item.tag}). ${changes}` : `${user.name} confirmed ${item.name} (${item.tag}) is up to date.` });
      saveDb(db);
      return json(200, { item });
    }
    if (itemMatch && method === "DELETE") {
      const index = db.items.findIndex((entry) => entry.id === decodeURIComponent(itemMatch[1]));
      if (index < 0) return json(404, { error: "Item not found." });
      const [item] = db.items.splice(index, 1);
      addAudit(db, { userId: user.id, userName: user.name, action: "deleted", itemId: item.id, tag: item.tag, itemName: item.name, details: `${user.name} removed ${item.name} (${item.tag}).` });
      saveDb(db);
      return json(200, { ok: true });
    }
    if (method === "GET" && path === "/api/audit") return json(200, { audit: db.audit.slice(0, 300) });
    if (method === "GET" && (path === "/api/export/csv" || path === "/api/export/pdf")) {
      const items = filtered(db.items, url.searchParams);
      const range = resolvePeriod(url.searchParams);
      const summary = reportSummary(items, db.audit, range);
      const stamp = new Date().toISOString().slice(0, 10);
      if (path.endsWith("/csv")) return fileResponse(buildCsv(items, summary), "text/csv; charset=utf-8", `aries-store-inventory-${stamp}.csv`);
      const pdf = buildPdf(items, `Prepared by ${user.name}  ·  ${summary.label}`, summary);
      return fileResponse(pdf, "application/pdf", `aries-store-inventory-${stamp}.pdf`);
    }
    return json(404, { error: "Not found." });
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    if (url.pathname.startsWith("/api/")) return handle(url, init);
    return originalFetch(input, init);
  };
}
