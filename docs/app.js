"use strict";

const REVIEW_MS = 30 * 24 * 60 * 60 * 1000;
const STATUSES = ["In store", "Issued to site", "On site", "Returned", "Under repair", "Missing"];
const CONDITIONS = ["New", "Good", "Fair", "Poor", "Damaged"];
const UNITS = ["pcs", "set", "pair", "roll", "box", "drum", "m", "kg", "bag"];
const SECTIONS = [
  "Network equipment",
  "Cables & materials",
  "Tools",
  "Spare parts",
  "Consumables",
  "Safety",
  "Others",
];

const state = {
  user: null,
  view: "inventory",
  authMode: "login",
  needsSetup: false,
  items: [],
  audit: [],
  users: [],
  filters: { q: "", section: "All", status: "All", condition: "All", review: false, period: "all", from: "", to: "" },
  resets: [],
  resetEmail: "",
  activityFilters: { q: "", user: "All", action: "All", tag: "" },
  highlightId: null,
  layout: "list",
  selectedId: null,
  modal: null,
  error: "",
  notice: "",
  busy: false,
  reviewDays: 30,
};

const app = document.getElementById("app");

function asset(file) {
  const path = location.pathname;
  if (!path.endsWith("/") && !/\.html$/i.test(path)) return `${path}/${file}`;
  return `${path.replace(/[^/]*$/, "")}${file}`;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function apiRoot() {
  return window.ARIES_API ? String(window.ARIES_API).replace(/\/$/, "") : "";
}

async function api(url, options = {}) {
  const headers = {};
  if (options.body) headers["Content-Type"] = "application/json";
  const token = sessionStorage.getItem("aries-token");
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiRoot()}${url}`, {
    method: options.method || "GET",
    headers,
    credentials: apiRoot() ? "omit" : "same-origin",
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (data.token) sessionStorage.setItem("aries-token", data.token);
  if (response.status === 401) {
    state.user = null;
    state.modal = null;
    state.selectedId = null;
    draw();
    throw new Error(data.error || "Please sign in.");
  }
  if (!response.ok) {
    const error = new Error(data.error || "Request failed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function needsReview(item) {
  return Date.now() - new Date(item.updatedAt).getTime() > REVIEW_MS;
}

function stamp(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relative(iso) {
  const delta = Date.now() - new Date(iso).getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))} min ago`;
  if (delta < day) return `${Math.round(delta / hour)} hr ago`;
  if (delta < 14 * day) return `${Math.round(delta / day)} days ago`;
  return stamp(iso);
}

function statusClass(status) {
  if (status === "In store" || status === "Returned") return "good";
  if (status === "Issued to site" || status === "On site") return "info";
  if (status === "Under repair") return "warn";
  if (status === "Missing") return "bad";
  return "";
}

function conditionClass(condition) {
  if (condition === "New" || condition === "Good") return "good";
  if (condition === "Fair") return "orange";
  if (condition === "Poor" || condition === "Damaged") return "bad";
  return "";
}

function filteredItems() {
  const q = state.filters.q.trim().toLowerCase();
  return state.items.filter((item) => {
    if (state.filters.section !== "All" && item.section !== state.filters.section) return false;
    if (state.filters.status !== "All" && item.status !== state.filters.status) return false;
    if (state.filters.condition !== "All" && item.condition !== state.filters.condition) return false;
    if (state.filters.review && !needsReview(item)) return false;
    if (!q) return true;
    return [
      item.tag,
      item.name,
      item.companyName,
      item.clientLocation,
      item.storeLocation,
      item.handedTo,
      item.serialNumber,
      item.notes,
      item.updatedByName,
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}

async function downloadExport(kind, event) {
  if (event) event.preventDefault();
  const headers = {};
  const token = sessionStorage.getItem("aries-token");
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiRoot()}${exportHref(kind)}`, {
    credentials: apiRoot() ? "omit" : "same-origin",
    headers,
  });
  if (!response.ok) return;
  const blob = await response.blob();
  const link = document.createElement("a");
  const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "");
  link.href = URL.createObjectURL(blob);
  link.download = match ? match[1] : `aries-store-inventory.${kind}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function exportHref(kind) {
  const params = new URLSearchParams();
  if (state.filters.q.trim()) params.set("q", state.filters.q.trim());
  if (state.filters.section !== "All") params.set("section", state.filters.section);
  if (state.filters.status !== "All") params.set("status", state.filters.status);
  if (state.filters.condition !== "All") params.set("condition", state.filters.condition);
  if (state.filters.review) params.set("review", "1");
  if (state.filters.period && state.filters.period !== "all") params.set("period", state.filters.period);
  if (state.filters.period === "custom") {
    if (state.filters.from) params.set("from", state.filters.from);
    if (state.filters.to) params.set("to", state.filters.to);
  }
  const query = params.toString();
  return `/api/export/${kind}${query ? `?${query}` : ""}`;
}

function nextSuggestedTag() {
  let max = 0;
  for (const item of state.items) {
    const match = /^AST-(\d+)$/i.exec(item.tag || "");
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `AST-${String(max + 1).padStart(4, "0")}`;
}

function draw() {
  if (!state.user) {
    app.innerHTML = authHtml();
    bindAuth();
    return;
  }
  app.innerHTML = shellHtml();
  bindShell();
  renderView();
}

function authHtml() {
  const mode = state.authMode;
  const title = mode === "register" ? "Create account" : mode === "forgot" ? "Reset password" : mode === "reset" ? "Enter reset code" : "Sign in";
  const lede = mode === "register"
    ? (state.needsSetup
      ? "This first account is the only administrator. Every account created after it is staff and shares the same inventory."
      : "This account is staff. It uses the same inventory and activity as every other account, and your real name is stored on every change.")
    : mode === "forgot"
      ? "Enter the company email on the account. If mail is set up, a code is sent. Otherwise an administrator sets the new password."
      : mode === "reset"
        ? "Enter the 6-digit code from the company email and choose a new password."
        : "Sign in with your username or company email, or create a staff account.";
  return `
    <div class="auth-wrap">
      <section class="auth-brand">
        <img src="${asset("logo.png")}" alt="Aries SystemCom Tech Engineering Ltd." />
        <div>
          <h1>Store inventory record</h1>
          <p>A shared list of every tool and other item: quantity, condition, where it is, and who it was handed to.</p>
          ${window.ARIES_SHARED ? `<p>Every account, item, and activity is saved in one shared GitHub record.</p>` : `<p>Every staff account sees this same inventory and activity log. The administrator is the only person who manages accounts.</p>`}
          <ul class="auth-points">
            <li>Network equipment, cables, tools, and other stock are kept in one record.</li>
            <li>Every change stores the name of the person who made it.</li>
            <li>Export a month, a year, or a custom range as a formal record.</li>
          </ul>
        </div>
      </section>
      <section class="auth-panel">
        <form class="auth-card" id="auth-form">
          <h2>${title}</h2>
          <p class="lede">${lede}</p>
          ${state.error ? `<div class="alert">${esc(state.error)}</div>` : ""}
          ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ""}
          ${mode === "register" ? `<label>Full name<input name="name" autocomplete="name" required placeholder="e.g. Adaeze Okonkwo" /></label>` : ""}
          <div class="form-grid" style="margin-top:14px">
            ${mode === "login" ? `<label>Username or company email<input name="username" autocomplete="username" required /></label>
            <label>Password<input name="password" type="password" autocomplete="current-password" required minlength="6" /></label>
            ${location.hostname.endsWith("github.io") && !window.ARIES_GITHUB_TOKEN ? `<label>GitHub save key<input name="githubToken" type="password" autocomplete="off" placeholder="Paste the store key once on this browser" /></label>` : ""}` : ""}
            ${mode === "register" ? `<label>Username<input name="username" autocomplete="username" required placeholder="adaeze" /></label>
            <label>Password<input name="password" type="password" autocomplete="new-password" required minlength="6" /></label>
            <label class="reenter">Re-enter password<input name="confirm" type="password" autocomplete="new-password" required minlength="6" placeholder="Type the password again" /></label>
            <label>Company email <span class="sub">optional</span><input name="email" type="email" autocomplete="email" placeholder="name@company.com" /></label>
            <label>Phone <span class="sub">optional</span><input name="phone" autocomplete="tel" placeholder="0800 000 0000" /></label>` : ""}
            ${mode === "forgot" ? `<label>Company email<input name="email" type="email" autocomplete="email" required placeholder="name@company.com" /></label>` : ""}
            ${mode === "reset" ? `<label>Company email<input name="email" type="email" required value="${esc(state.resetEmail)}" /></label>
            <label>Reset code<input name="code" inputmode="numeric" required placeholder="6 digits" /></label>
            <label>New password<input name="password" type="password" autocomplete="new-password" required minlength="6" /></label>
            <label class="reenter">Re-enter password<input name="confirm" type="password" autocomplete="new-password" required minlength="6" placeholder="Type the password again" /></label>` : ""}
            <button class="btn primary" type="submit">${mode === "register" ? "Create account" : mode === "forgot" ? "Send reset" : mode === "reset" ? "Set new password" : "Sign in"}</button>
            ${mode === "login" ? `<button class="linkish" type="button" id="forgot-auth">Forgot password</button>` : ""}
            ${mode === "login" || mode === "register" ? `<button class="linkish" type="button" id="switch-auth">${mode === "register" ? "I already have an account" : "Create an account"}</button>` : ""}
          </div>
        </form>
      </section>
    </div>`;
}

function bindAuth() {
  const switchAuth = document.getElementById("switch-auth");
  if (switchAuth) {
    switchAuth.onclick = () => {
      state.authMode = state.authMode === "register" ? "login" : "register";
      state.error = "";
      state.notice = "";
      draw();
    };
  }
  const forgot = document.getElementById("forgot-auth");
  if (forgot) {
    forgot.onclick = () => {
      state.authMode = "forgot";
      state.error = "";
      state.notice = "";
      draw();
    };
  }
  document.getElementById("auth-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const githubToken = String(form.get("githubToken") || "").trim();
    if (githubToken) {
      try { localStorage.setItem("aries-github-token", githubToken); } catch (error) { /* this browser did not store it */ }
      window.ARIES_GITHUB_TOKEN = githubToken;
    }
    state.error = "";
    state.notice = "";
    state.busy = true;
    try {
      if (state.authMode === "login") {
        const data = await api("/api/auth/login", {
          method: "POST",
          body: { username: form.get("username"), password: form.get("password") },
        });
        state.user = data.user;
        await refreshItems();
      } else if (state.authMode === "register") {
        if (form.get("password") !== form.get("confirm")) {
          state.error = "The two passwords do not match.";
          draw();
          return;
        }
        const data = await api("/api/auth/register", {
          method: "POST",
          body: {
            name: form.get("name"),
            username: form.get("username"),
            email: form.get("email"),
            phone: form.get("phone"),
            password: form.get("password"),
            confirm: form.get("confirm"),
          },
        });
        state.user = data.user;
        await refreshItems();
      } else if (state.authMode === "forgot") {
        const data = await api("/api/auth/forgot", { method: "POST", body: { email: form.get("email") } });
        state.resetEmail = String(form.get("email") || "");
        state.notice = data.message;
        state.authMode = data.mailed ? "reset" : "login";
        draw();
        return;
      } else {
        if (form.get("password") !== form.get("confirm")) {
          state.error = "The two passwords do not match.";
          draw();
          return;
        }
        const data = await api("/api/auth/reset", {
          method: "POST",
          body: { email: form.get("email"), code: form.get("code"), password: form.get("password"), confirm: form.get("confirm") },
        });
        state.user = data.user;
        await refreshItems();
      }
      draw();
    } catch (error) {
      state.error = error.message;
      draw();
    } finally {
      state.busy = false;
    }
  };
}

function shellHtml() {
  return `
    <div class="shell">
      <header class="topbar">
        <img src="${asset("logo.png")}" alt="Aries SystemCom" />
        <div class="brand-text">
          <strong>Store inventory</strong>
          <span>Aries SystemCom Tech Engineering Ltd.</span>
        </div>
        <div class="top-spacer"></div>
        <div class="who">
          <strong>${esc(state.user.name)}</strong>
          <span>${esc(state.user.role)}</span>
        </div>
        <button class="btn small ghost" id="logout" style="color:white;border-color:#3a3a3a">Sign out</button>
      </header>
      <div class="layout">
        <nav class="nav">
          <button data-view="inventory" class="${state.view === "inventory" ? "active" : ""}">Inventory</button>
          <button data-view="activity" class="${state.view === "activity" ? "active" : ""}">Activity</button>
          <button data-view="accounts" class="${state.view === "accounts" ? "active" : ""}">Accounts</button>
          <p class="foot">RC 680979<br />One shared record. Each change is tagged with the account that made it.</p>
        </nav>
        <main class="content" id="main"></main>
      </div>
    </div>
    ${state.selectedId ? drawerHtml() : ""}
    ${state.modal ? modalHtml() : ""}`;
}

function bindShell() {
  document.getElementById("logout").onclick = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch { /* signed out locally */ }
    sessionStorage.removeItem("aries-token");
    state.user = null;
    state.items = [];
    state.selectedId = null;
    state.modal = null;
    draw();
  };
  document.querySelectorAll(".nav [data-view]").forEach((button) => {
    button.onclick = async () => {
      state.view = button.dataset.view;
      state.selectedId = null;
      state.modal = null;
      state.error = "";
      state.notice = "";
      if (state.view === "activity") await refreshAudit();
      if (state.view === "accounts") await refreshUsers();
      draw();
    };
  });
}

function renderView() {
  const main = document.getElementById("main");
  if (!main) return;
  if (state.view === "inventory") main.innerHTML = inventoryHtml();
  if (state.view === "activity") main.innerHTML = activityHtml();
  if (state.view === "accounts") main.innerHTML = accountsHtml();
  bindView();
}

function sectionFieldOptions(current) {
  const extras = sectionOptions().filter((section) => !SECTIONS.includes(section));
  const known = SECTIONS.includes(current) || extras.includes(current);
  return [
    ...SECTIONS.map((section) => `<option value="${esc(section)}" ${current === section ? "selected" : ""}>${esc(section)}</option>`),
    ...extras.map((section) => `<option value="${esc(section)}" ${current === section ? "selected" : ""}>${esc(section)}</option>`),
    `<option value="__custom__" ${current && !known ? "selected" : ""}>Custom section</option>`,
  ].join("");
}

function customSectionValue(section) {
  const extras = sectionOptions().filter((entry) => !SECTIONS.includes(entry));
  if (section && !SECTIONS.includes(section) && !extras.includes(section)) return section;
  return "";
}

function sectionOptions() {
  const extras = state.items
    .map((item) => item.section)
    .filter((section) => section && !SECTIONS.includes(section));
  return [...SECTIONS, ...[...new Set(extras)].sort((a, b) => a.localeCompare(b))];
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function recordAttention(items) {
  const today = todayStamp();
  const overdue = items.filter((item) => item.expectedReturn && item.expectedReturn < today && (item.status === "Issued to site" || item.status === "On site")).length;
  const missing = items.filter((item) => item.status === "Missing").length;
  const attention = items.filter((item) => item.condition === "Poor" || item.condition === "Damaged" || item.status === "Missing").length;
  return { overdue, missing, attention };
}

function money(value) {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `₦${number.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function stockValue(items) {
  return items.reduce((sum, item) => sum + (item.lineValue == null ? 0 : Number(item.lineValue)), 0);
}

function summaryText(items) {
  const focus = recordAttention(items);
  return `Showing ${items.length} of ${state.items.length}. ${focus.overdue} overdue return${focus.overdue === 1 ? "" : "s"}, ${focus.missing} missing, ${focus.attention} poor, damaged, or missing.`;
}

function statsHtml(items) {
  const qty = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const inStore = items.filter((item) => item.status === "In store" || item.status === "Returned").length;
  const withClients = items.filter((item) => item.status === "On site" || item.status === "Issued to site").length;
  const due = state.items.filter(needsReview).length;
  const dueShown = items.filter(needsReview).length;
  const focus = recordAttention(items);
  return `
      <div class="stat"><b>${items.length}</b><span>Items shown</span></div>
      <div class="stat"><b>${Number(qty.toFixed(2))}</b><span>Quantity</span></div>
      <div class="stat"><b>${money(stockValue(items))}</b><span>Stock value</span></div>
      <div class="stat"><b>${inStore}</b><span>In the store</span></div>
      <div class="stat"><b>${withClients}</b><span>Issued to site</span></div>
      <div class="stat ${focus.overdue ? "alerting" : ""}"><b>${focus.overdue}</b><span>Overdue returns</span></div>
      <div class="stat ${focus.attention ? "alerting" : ""}"><b>${focus.attention}</b><span>Poor, damaged, or missing</span></div>
      <div class="stat ${due ? "alerting" : ""}"><b>${dueShown}</b><span>Need a ${state.reviewDays}-day check</span></div>`;
}

function inventoryHtml() {
  const items = filteredItems();
  const due = state.items.filter(needsReview).length;
  return `
    <div class="page-head">
      <div>
        <h2>Inventory</h2>
        <p id="summary">${summaryText(items)} Every account sees this list.</p>
      </div>
      <div class="btn-row">
        <a class="btn ghost" id="export-csv" href="${esc(exportHref("csv"))}">Export CSV</a>
        <a class="btn ghost" id="export-pdf" href="${esc(exportHref("pdf"))}">Export PDF</a>
        <button class="btn primary" id="add-item">Add item</button>
      </div>
    </div>
    <section class="stats" id="stats">
      ${statsHtml(items)}
    </section>
    ${state.notice ? `<div class="notice" style="margin-bottom:12px">${esc(state.notice)}</div>` : ""}
    ${due ? `<div class="banner">${due} item${due === 1 ? "" : "s"} ${due === 1 ? "has" : "have"} not been updated in ${state.reviewDays} days. Open the item and confirm it, or edit the record.</div>` : ""}
    <div class="toolbar">
      <input class="search" id="q" placeholder="Search tag, item, company, site, or person" value="${esc(state.filters.q)}" />
      <select id="section-filter">
        <option value="All">All sections</option>
        ${sectionOptions().map((section) => `<option value="${esc(section)}" ${state.filters.section === section ? "selected" : ""}>${esc(section)}</option>`).join("")}
      </select>
      <select id="status-filter">
        <option value="All">All statuses</option>
        ${STATUSES.map((status) => `<option value="${esc(status)}" ${state.filters.status === status ? "selected" : ""}>${esc(status)}</option>`).join("")}
      </select>
      <select id="condition">
        <option value="All">All conditions</option>
        ${CONDITIONS.map((condition) => `<option value="${esc(condition)}" ${state.filters.condition === condition ? "selected" : ""}>${esc(condition)}</option>`).join("")}
      </select>
      <button class="chip ${state.filters.review ? "active" : ""}" id="review-toggle">Needs review</button>
      <select id="period" title="Dates included in CSV and PDF">
        <option value="all" ${state.filters.period === "all" ? "selected" : ""}>Export all dates</option>
        <option value="this-month" ${state.filters.period === "this-month" ? "selected" : ""}>This month</option>
        <option value="last-month" ${state.filters.period === "last-month" ? "selected" : ""}>Last month</option>
        <option value="this-year" ${state.filters.period === "this-year" ? "selected" : ""}>This year</option>
        <option value="last-year" ${state.filters.period === "last-year" ? "selected" : ""}>Last year</option>
        <option value="custom" ${state.filters.period === "custom" ? "selected" : ""}>Custom dates</option>
      </select>
      <input type="date" id="export-from" value="${esc(state.filters.from)}" ${state.filters.period === "custom" ? "" : "hidden"} />
      <input type="date" id="export-to" value="${esc(state.filters.to)}" ${state.filters.period === "custom" ? "" : "hidden"} />
      <button class="tab ${state.layout === "list" ? "active" : ""}" id="layout-list">List</button>
      <button class="tab ${state.layout === "sites" ? "active" : ""}" id="layout-sites">By site</button>
    </div>
    <div id="rows">${rowsHtml(items)}</div>`;
}

function itemCells(item) {
  const where = item.companyName || item.clientLocation
    ? `${item.companyName || "—"}${item.clientLocation ? ` · ${item.clientLocation}` : ""}`
    : item.storeLocation || "Store";
  return `
    <td data-label="Tag" class="tag">${esc(item.tag)}</td>
    <td data-label="Item">${esc(item.name)}${item.serialNumber ? `<span class="sub">${esc(item.serialNumber)}</span>` : ""}</td>
    <td data-label="Section">${esc(item.section)}</td>
    <td data-label="Qty">${esc(item.quantity)} ${esc(item.unit)}</td>
    <td data-label="Unit price">${money(item.unitPrice)}</td>
    <td data-label="Value">${money(item.lineValue)}</td>
    <td data-label="Condition"><span class="badge ${conditionClass(item.condition)}">${esc(item.condition)}</span></td>
    <td data-label="Status"><span class="badge ${statusClass(item.status)}">${esc(item.status)}</span>${needsReview(item) ? `<span class="sub">Review due</span>` : ""}</td>
    <td data-label="Location">${esc(where)}</td>
    <td data-label="Handed to">${esc(item.handedTo || "—")}</td>
    <td data-label="Updated">${esc(item.updatedByName || "—")}<span class="sub">${esc(relative(item.updatedAt))}</span>${item.createdByName && item.createdByName !== item.updatedByName ? `<span class="sub">Added by ${esc(item.createdByName)}</span>` : ""}</td>`;
}

function rowsHtml(items) {
  if (!items.length) {
    return `<div class="table-wrap"><div class="empty"><strong>No items in this view</strong>Add a tool or other stock item, or clear the filters.</div></div>`;
  }
  if (state.layout === "sites") {
    const groups = new Map();
    for (const item of items) {
      const key = item.companyName || item.clientLocation
        ? `${item.companyName || "Company not set"} — ${item.clientLocation || "Location not set"}`
        : "In the store";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === "In the store") return -1;
      if (b === "In the store") return 1;
      return a.localeCompare(b);
    });
    return keys
      .map((key) => {
        const group = groups.get(key);
        const qty = group.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        return `
          <section class="group">
            <h3>${esc(key)} <span>${group.length} item${group.length === 1 ? "" : "s"} · ${Number(qty.toFixed(2))} quantity · ${money(stockValue(group))}</span></h3>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Tag</th><th>Item</th><th>Section</th><th>Qty</th><th>Unit price</th><th>Value</th><th>Condition</th><th>Status</th><th>Handed to</th><th>Updated</th></tr></thead>
                <tbody>
                  ${group
                    .map(
                      (item) => `<tr class="clickable ${needsReview(item) ? "due" : ""} ${item.id === state.highlightId ? "just-added" : ""}" data-id="${item.id}">
                        <td data-label="Tag" class="tag">${esc(item.tag)}</td>
                        <td data-label="Item">${esc(item.name)}</td>
                        <td data-label="Section">${esc(item.section)}</td>
                        <td data-label="Qty">${esc(item.quantity)} ${esc(item.unit)}</td>
                        <td data-label="Unit price">${money(item.unitPrice)}</td>
                        <td data-label="Value">${money(item.lineValue)}</td>
                        <td data-label="Condition"><span class="badge ${conditionClass(item.condition)}">${esc(item.condition)}</span></td>
                        <td data-label="Status"><span class="badge ${statusClass(item.status)}">${esc(item.status)}</span></td>
                        <td data-label="Handed to">${esc(item.handedTo || "—")}</td>
                        <td data-label="Updated">${esc(item.updatedByName)}<span class="sub">${esc(relative(item.updatedAt))}</span></td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          </section>`;
      })
      .join("");
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Tag</th><th>Item</th><th>Section</th><th>Qty</th><th>Unit price</th><th>Value</th><th>Condition</th><th>Status</th><th>Company / location</th><th>Handed to</th><th>Updated by</th></tr>
        </thead>
        <tbody>
          ${items.map((item) => `<tr class="clickable ${needsReview(item) ? "due" : ""} ${item.id === state.highlightId ? "just-added" : ""}" data-id="${item.id}">${itemCells(item)}</tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function paintRows() {
  const items = filteredItems();
  const rows = document.getElementById("rows");
  if (rows) rows.innerHTML = rowsHtml(items);
  const summary = document.getElementById("summary");
  if (summary) summary.textContent = summaryText(items);
  const stats = document.getElementById("stats");
  if (stats) stats.innerHTML = statsHtml(items);
  const csv = document.getElementById("export-csv");
  const pdf = document.getElementById("export-pdf");
  if (csv) csv.href = exportHref("csv");
  if (pdf) pdf.href = exportHref("pdf");
  bindExports();
  bindRowClicks();
}

function bindExports() {
  const csv = document.getElementById("export-csv");
  const pdf = document.getElementById("export-pdf");
  if (csv) csv.onclick = (event) => downloadExport("csv", event);
  if (pdf) pdf.onclick = (event) => downloadExport("pdf", event);
}

function bindView() {
  const add = document.getElementById("add-item");
  if (add) {
    add.onclick = () => {
      state.modal = { mode: "create" };
      state.error = "";
      draw();
    };
  }
  const search = document.getElementById("q");
  if (search) {
    search.oninput = () => {
      state.filters.q = search.value;
      paintRows();
    };
  }
  const condition = document.getElementById("condition");
  if (condition) {
    condition.onchange = () => {
      state.filters.condition = condition.value;
      draw();
    };
  }
  const sectionFilter = document.getElementById("section-filter");
  if (sectionFilter) {
    sectionFilter.onchange = () => {
      state.filters.section = sectionFilter.value;
      state.notice = "";
      draw();
    };
  }
  const statusFilter = document.getElementById("status-filter");
  if (statusFilter) {
    statusFilter.onchange = () => {
      state.filters.status = statusFilter.value;
      state.notice = "";
      draw();
    };
  }
  const review = document.getElementById("review-toggle");
  if (review) {
    review.onclick = () => {
      state.filters.review = !state.filters.review;
      draw();
    };
  }
  const period = document.getElementById("period");
  if (period) {
    period.onchange = () => {
      state.filters.period = period.value;
      draw();
    };
  }
  const exportFrom = document.getElementById("export-from");
  const exportTo = document.getElementById("export-to");
  if (exportFrom) exportFrom.onchange = () => { state.filters.from = exportFrom.value; paintRows(); };
  if (exportTo) exportTo.onchange = () => { state.filters.to = exportTo.value; paintRows(); };
  const list = document.getElementById("layout-list");
  const sites = document.getElementById("layout-sites");
  if (list) list.onclick = () => { state.layout = "list"; draw(); };
  if (sites) sites.onclick = () => { state.layout = "sites"; draw(); };
  bindExports();
  bindRowClicks();
  bindDrawer();
  bindModal();
  bindAccounts();
  bindActivity();
  const highlighted = state.highlightId && document.querySelector(`tr[data-id="${state.highlightId}"]`);
  if (highlighted) highlighted.scrollIntoView({ block: "center" });
}

function bindRowClicks() {
  document.querySelectorAll("tr[data-id]").forEach((row) => {
    row.onclick = () => {
      state.selectedId = row.dataset.id;
      state.error = "";
      draw();
    };
  });
}

function selectedItem() {
  return state.items.find((item) => item.id === state.selectedId) || null;
}

function drawerHtml() {
  const item = selectedItem();
  if (!item) return "";
  const pair = (label, value) => `<dt>${label}</dt><dd>${value || "—"}</dd>`;
  return `
    <div class="drawer-back" id="drawer-back">
      <aside class="drawer">
        <div class="drawer-head">
          <div>
            <p class="section-title">${esc(item.section)} · ${esc(item.tag)}</p>
            <h3>${esc(item.name)}</h3>
          </div>
          <button class="btn ghost small" id="close-drawer">Close</button>
        </div>
        ${state.error && state.view === "inventory" ? `<div class="alert">${esc(state.error)}</div>` : ""}
        <dl class="dl">
          ${pair("Quantity", esc(`${item.quantity} ${item.unit}`))}
          ${pair("Unit price", esc(money(item.unitPrice)))}
          ${pair("Value", esc(money(item.lineValue)))}
          ${pair("Condition", `<span class="badge ${conditionClass(item.condition)}">${esc(item.condition)}</span>`)}
          ${pair("Status", `<span class="badge ${statusClass(item.status)}">${esc(item.status)}</span>`)}
          ${pair("Store location", esc(item.storeLocation))}
          ${pair("Company", esc(item.companyName))}
          ${pair("Client location", esc(item.clientLocation))}
          ${pair("Handed to", esc(item.handedTo))}
          ${pair("Phone", esc(item.handedToPhone))}
          ${pair("Issued on", esc(item.issuedOn))}
          ${pair("Expected return", esc(item.expectedReturn))}
          ${pair("Serial number", esc(item.serialNumber))}
          ${pair("Added by", `${esc(item.createdByName)}<span class="sub">${esc(stamp(item.createdAt))}</span>`)}
          ${pair("Last update", `${esc(item.updatedByName)}<span class="sub">${esc(stamp(item.updatedAt))}</span>`)}
        </dl>
        <p class="section-title">Notes</p>
        <p class="notes-block">${esc(item.notes || "No notes.")}</p>
        <div class="btn-row" style="margin-top:18px">
          <button class="btn primary" id="edit-item">Update record</button>
          <button class="btn ghost" id="review-item">Confirm up to date</button>
          <button class="btn danger" id="delete-item">Remove</button>
        </div>
      </aside>
    </div>`;
}

function bindDrawer() {
  const close = document.getElementById("close-drawer");
  if (!close) return;
  const shut = () => {
    state.selectedId = null;
    state.error = "";
    draw();
  };
  close.onclick = shut;
  document.getElementById("drawer-back").onclick = (event) => {
    if (event.target.id === "drawer-back") shut();
  };
  document.getElementById("edit-item").onclick = () => {
    state.modal = { mode: "edit", id: state.selectedId };
    state.error = "";
    draw();
  };
  document.getElementById("review-item").onclick = async () => {
    try {
      const data = await api(`/api/items/${state.selectedId}/review`, { method: "POST" });
      replaceItem(data.item);
      state.notice = `${state.user.name} confirmed this record.`;
      draw();
    } catch (error) {
      state.error = error.message;
      draw();
    }
  };
  document.getElementById("delete-item").onclick = async () => {
    const item = selectedItem();
    if (!item) return;
    if (!window.confirm(`Remove ${item.name} (${item.tag}) from the inventory? This is recorded under your name.`)) return;
    try {
      await api(`/api/items/${item.id}`, { method: "DELETE" });
      state.items = state.items.filter((entry) => entry.id !== item.id);
      state.selectedId = null;
      draw();
    } catch (error) {
      state.error = error.message;
      draw();
    }
  };
}

function field(name, label, value, extra = "") {
  return `<label>${label}<input name="${name}" value="${esc(value ?? "")}" ${extra} /></label>`;
}

function modalHtml() {
  const editing = state.modal.mode === "edit" ? state.items.find((item) => item.id === state.modal.id) : null;
  const item = editing || {
    tag: nextSuggestedTag(),
    name: "",
    section: "Network equipment",
    quantity: 1,
    unit: "pcs",
    condition: "Good",
    status: "In store",
    storeLocation: "",
    companyName: "",
    clientLocation: "",
    handedTo: "",
    handedToPhone: "",
    issuedOn: "",
    expectedReturn: "",
    serialNumber: "",
    notes: "",
    updatedAt: "",
  };
  const options = (list, current) => list.map((entry) => `<option ${entry === current ? "selected" : ""}>${esc(entry)}</option>`).join("");
  return `
    <div class="modal-back" id="modal-back">
      <form class="modal" id="item-form">
        <div class="modal-head">
          <div>
            <p class="section-title">${editing ? "Update record" : "New item"}</p>
            <h3>${editing ? esc(editing.name) : "Add to the store"}</h3>
          </div>
          <button class="btn ghost small" type="button" id="close-modal">Close</button>
        </div>
        <p class="lede">Saved under <strong>${esc(state.user.name)}</strong>. Company, client location, and the person who received the item are required when the status is Issued to site or On site.</p>
        ${state.error ? `<div class="alert">${esc(state.error)}</div>` : ""}
        <input type="hidden" name="updatedAt" value="${esc(item.updatedAt || "")}" />
        <p class="section-title">Item</p>
        <div class="form-grid two">
          ${field("tag", "Tag", item.tag, 'maxlength="32"')}
          ${field("name", "Name", item.name, 'required maxlength="120" placeholder="Router, Cat6 box, LAN tester"')}
          <label>Section<select name="section" id="section-select">${sectionFieldOptions(item.section)}</select></label>
          <label id="custom-section-wrap">Custom section<input name="customSection" id="custom-section" maxlength="40" placeholder="e.g. Radio equipment" value="${esc(customSectionValue(item.section))}" /></label>
          ${field("serialNumber", "Serial number", item.serialNumber, 'maxlength="80"')}
          <p class="hint wide">Network equipment covers routers, firewalls, access points, and switches. Cables & materials covers Cat6, fiber, and patch cords. Tools covers a LAN tester, fiber splicer, and other tools. Choose Custom section for anything else.</p>
        </div>
        <p class="section-title">Quantity, price, condition, status</p>
        <div class="form-grid two">
          ${field("quantity", "Quantity", item.quantity, 'type="number" min="0" step="0.01" required')}
          <label>Unit<select name="unit">${options(UNITS, item.unit)}</select></label>
          ${field("unitPrice", "Unit price (₦)", item.unitPrice ?? "", 'type="number" min="0" step="0.01" placeholder="Leave blank if unknown"')}
          <p class="hint">Value is the quantity multiplied by the unit price. Prices are in naira.</p>
          <label>Condition<select name="condition">${options(CONDITIONS, item.condition)}</select></label>
          <label>Status<select name="status">${options(STATUSES, item.status)}</select></label>
        </div>
        <p class="section-title">Where it is</p>
        <div class="form-grid">
          ${field("storeLocation", "Store location", item.storeLocation, 'maxlength="160" placeholder="Main store, Shelf B3"')}
          <div class="form-grid two">
            ${field("companyName", "Company name", item.companyName, 'maxlength="160" placeholder="Client company"')}
            ${field("clientLocation", "Client location", item.clientLocation, 'maxlength="200" placeholder="Site address or area"')}
          </div>
        </div>
        <p class="section-title">Who has it</p>
        <div class="form-grid two">
          ${field("handedTo", "Handed to", item.handedTo, 'maxlength="120" placeholder="Person who received it"')}
          ${field("handedToPhone", "Phone", item.handedToPhone, 'maxlength="40"')}
          ${field("issuedOn", "Date issued", item.issuedOn, 'type="date"')}
          ${field("expectedReturn", "Expected return", item.expectedReturn, 'type="date"')}
          <label class="wide">Notes<textarea name="notes" maxlength="2000" placeholder="What was agreed, damage already seen, or anything the next person should know.">${esc(item.notes)}</textarea></label>
        </div>
        <div class="btn-row" style="margin-top:16px">
          <button class="btn primary" type="submit" id="save-item">${editing ? "Save update" : "Add item"}</button>
          <button class="btn ghost" type="button" id="cancel-modal">Cancel</button>
        </div>
      </form>
    </div>`;
}

function formValue(form) {
  const data = new FormData(form);
  return {
    tag: data.get("tag"),
    name: data.get("name"),
    section: data.get("section") === "__custom__" ? data.get("customSection") : data.get("section"),
    quantity: data.get("quantity"),
    unit: data.get("unit"),
    unitPrice: data.get("unitPrice"),
    condition: data.get("condition"),
    status: data.get("status"),
    storeLocation: data.get("storeLocation"),
    companyName: data.get("companyName"),
    clientLocation: data.get("clientLocation"),
    handedTo: data.get("handedTo"),
    handedToPhone: data.get("handedToPhone"),
    issuedOn: data.get("issuedOn"),
    expectedReturn: data.get("expectedReturn"),
    serialNumber: data.get("serialNumber"),
    notes: data.get("notes"),
    updatedAt: data.get("updatedAt"),
  };
}

function replaceItem(item) {
  const index = state.items.findIndex((entry) => entry.id === item.id);
  if (index >= 0) state.items[index] = item;
  else state.items.unshift(item);
  state.items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function bindModal() {
  const form = document.getElementById("item-form");
  if (!form) return;
  const close = () => {
    state.modal = null;
    state.error = "";
    draw();
  };
  const sectionSelect = document.getElementById("section-select");
  const customWrap = document.getElementById("custom-section-wrap");
  const syncCustom = () => {
    if (!sectionSelect || !customWrap) return;
    const custom = sectionSelect.value === "__custom__";
    customWrap.hidden = !custom;
    const input = document.getElementById("custom-section");
    if (input) input.required = custom;
  };
  if (sectionSelect) sectionSelect.onchange = syncCustom;
  syncCustom();
  document.getElementById("close-modal").onclick = close;
  document.getElementById("cancel-modal").onclick = close;
  document.getElementById("modal-back").onclick = (event) => {
    if (event.target.id === "modal-back") close();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = document.getElementById("save-item");
    button.disabled = true;
    const body = formValue(form);
    try {
      if (state.modal.mode === "create") {
        const data = await api("/api/items", { method: "POST", body });
        showInList(data.item, true);
      } else {
        const data = await api(`/api/items/${state.modal.id}`, { method: "PUT", body });
        showInList(data.item, false);
      }
    } catch (error) {
      state.error = error.message;
      button.disabled = false;
      const alert = form.querySelector(".alert");
      const html = `<div class="alert">${esc(error.message)}</div>`;
      if (alert) alert.outerHTML = html;
      else form.querySelector(".lede").insertAdjacentHTML("afterend", html);
    }
  };
}

function showInList(item, created) {
  replaceItem(item);
  state.filters.q = "";
  state.filters.section = "All";
  state.filters.status = "All";
  state.filters.condition = "All";
  state.filters.review = false;
  state.layout = "list";
  state.modal = null;
  state.selectedId = null;
  state.error = "";
  state.highlightId = item.id;
  state.notice = created
    ? `${item.name} (${item.tag}) is in the inventory list.`
    : `${item.name} (${item.tag}) was updated and is shown in the list.`;
  state.view = "inventory";
  draw();
}

function filteredAudit() {
  const filters = state.activityFilters;
  const q = filters.q.trim().toLowerCase();
  const tag = filters.tag.trim().toLowerCase();
  return state.audit.filter((entry) => {
    if (filters.user !== "All" && entry.userName !== filters.user) return false;
    if (filters.action !== "All" && entry.action !== filters.action) return false;
    if (tag) {
      const tagText = `${entry.tag || ""} ${entry.itemName || ""}`.toLowerCase();
      if (!tagText.includes(tag)) return false;
    }
    if (!q) return true;
    return [entry.userName, entry.tag, entry.itemName, entry.action, entry.details].join(" ").toLowerCase().includes(q);
  });
}

function activityHtml() {
  const people = [...new Set(state.audit.map((entry) => entry.userName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const actions = ["created", "updated", "reviewed", "deleted", "account"];
  const shown = filteredAudit();
  return `
    <div class="page-head">
      <div>
        <h2>Activity</h2>
        <p>Showing ${shown.length} of ${state.audit.length}. This is the shared log. Each line is tagged with the account that made the change.</p>
      </div>
    </div>
    <div class="toolbar">
      <input class="search" id="audit-q" placeholder="Search person, tag, item, or change" value="${esc(state.activityFilters.q)}" />
      <select id="audit-user">
        <option value="All">All people</option>
        ${people.map((name) => `<option value="${esc(name)}" ${state.activityFilters.user === name ? "selected" : ""}>${esc(name)}</option>`).join("")}
      </select>
      <select id="audit-action">
        <option value="All">All actions</option>
        ${actions.map((action) => `<option value="${action}" ${state.activityFilters.action === action ? "selected" : ""}>${action}</option>`).join("")}
      </select>
      <input id="audit-tag" placeholder="Tag or item" value="${esc(state.activityFilters.tag)}" />
    </div>
    ${shown.length ? `<div class="cards" id="audit-rows">${auditCards(shown)}</div>` : `<div class="table-wrap"><div class="empty"><strong>No matching activity</strong>Clear a filter, or save an item to start the log.</div></div>`}`;
}

function auditCards(entries) {
  return entries
    .map(
      (entry) => `<article class="activity">
        <time>${esc(stamp(entry.at))}</time>
        <div>
          <strong>${esc(entry.userName)}</strong>${entry.username ? ` <span class="sub">@${esc(entry.username)}</span>` : ""}
          <span class="badge ${entry.action === "deleted" ? "bad" : entry.action === "created" ? "good" : "orange"}">${esc(entry.action)}</span>
          ${entry.tag ? `<span class="badge">${esc(entry.tag)}</span>` : ""}
          <p style="margin:8px 0 0">${esc(entry.details)}</p>
        </div>
      </article>`
    )
    .join("");
}

function bindActivity() {
  const search = document.getElementById("audit-q");
  if (!search) return;
  const paint = () => {
    const shown = filteredAudit();
    const summary = document.querySelector(".page-head p");
    if (summary) summary.textContent = `Showing ${shown.length} of ${state.audit.length}. This is the shared log. Each line is tagged with the account that made the change.`;
    const cards = document.getElementById("audit-rows");
    const host = cards || document.querySelector(".content .table-wrap");
    if (!shown.length) {
      if (cards) cards.outerHTML = `<div class="table-wrap"><div class="empty"><strong>No matching activity</strong>Clear a filter, or save an item to start the log.</div></div>`;
      return;
    }
    if (cards) {
      cards.innerHTML = auditCards(shown);
      return;
    }
    if (host) host.outerHTML = `<div class="cards" id="audit-rows">${auditCards(shown)}</div>`;
  };
  search.oninput = () => {
    state.activityFilters.q = search.value;
    paint();
  };
  document.getElementById("audit-tag").oninput = (event) => {
    state.activityFilters.tag = event.target.value;
    paint();
  };
  document.getElementById("audit-user").onchange = (event) => {
    state.activityFilters.user = event.target.value;
    paint();
  };
  document.getElementById("audit-action").onchange = (event) => {
    state.activityFilters.action = event.target.value;
    paint();
  };
}

function accountsHtml() {
  const pending = state.user.role === "admin" ? state.resets.filter((entry) => entry.status === "needs-admin" || entry.status === "open") : [];
  return `
    <div class="page-head">
      <div>
        <h2>Accounts</h2>
        <p>${state.user.role === "admin" ? "You are the only administrator. Create staff accounts here. Staff use the same inventory and activity log, and every change keeps their name." : "You are staff. You see the same inventory and activity as every other account. The administrator manages accounts."}</p>
      </div>
    </div>
    ${state.error ? `<div class="alert" style="margin-bottom:12px">${esc(state.error)}</div>` : ""}
    ${state.notice ? `<div class="notice" style="margin-bottom:12px">${esc(state.notice)}</div>` : ""}
    ${pending.length ? `<div class="banner">${pending.length} password reset${pending.length === 1 ? "" : "s"} waiting. Set a new password on that account if mail did not send a code.</div>` : ""}
    <div class="account-grid">
      ${state.user.role === "admin" ? `<form class="panel" id="create-account">
        <h3>Create account</h3>
        <div class="form-grid">
          <label>Full name<input name="name" required placeholder="Person's real name" /></label>
          <label>Username<input name="username" required placeholder="letters and numbers" /></label>
          <label>Password<input name="password" type="password" required minlength="6" /></label>
          <label class="reenter">Re-enter password<input name="confirm" type="password" required minlength="6" placeholder="Type the password again" /></label>
          <label>Company email <span class="sub">optional</span><input name="email" type="email" placeholder="name@company.com" /></label>
          <label>Phone <span class="sub">optional</span><input name="phone" placeholder="0800 000 0000" /></label>
          <button class="btn primary" type="submit">Create account</button>
        </div>
      </form>` : ""}
      <form class="panel" id="profile-form">
        <h3>Your contact</h3>
        <p class="lede">Signed in as ${esc(state.user.name)} (@${esc(state.user.username)}). Add a company email here if the account was created without one.</p>
        <div class="form-grid">
          <label>Company email<input name="email" type="email" value="${esc(state.user.email || "")}" placeholder="optional" /></label>
          <label>Phone<input name="phone" value="${esc(state.user.phone || "")}" placeholder="optional" /></label>
          <button class="btn ghost" type="submit">Save contact</button>
        </div>
      </form>
      <form class="panel" id="change-password">
        <h3>Your password</h3>
        <div class="form-grid">
          <label>Current password<input name="current" type="password" required /></label>
          <label>New password<input name="next" type="password" required minlength="6" /></label>
          <label class="reenter">Re-enter password<input name="confirm" type="password" required minlength="6" placeholder="Type the new password again" /></label>
          <button class="btn ghost" type="submit">Change password</button>
        </div>
      </form>
    </div>
    <h3 style="margin:8px 0">People</h3>
    <div class="cards">
      ${state.users
        .map((user) => {
          const self = user.id === state.user.id;
          const manage = state.user.role === "admin";
          return `<article class="person">
            <strong>${esc(user.name)}</strong>
            <span class="badge ${user.role === "admin" ? "orange" : ""}">${esc(user.role)}</span>
            <span class="sub">@${esc(user.username)}${user.email ? ` · ${esc(user.email)}` : " · no company email"}${user.phone ? ` · ${esc(user.phone)}` : ""}</span>
            <span class="sub">Joined ${esc(stamp(user.createdAt))}${self ? " · this is your account" : ""}</span>
            ${manage ? `<form class="manage" data-manage="${user.id}">
              <div class="form-grid">
                <label>Full name<input name="name" value="${esc(user.name)}" required /></label>
                <label>Company email<input name="email" type="email" value="${esc(user.email || "")}" placeholder="optional" /></label>
                <label>Phone<input name="phone" value="${esc(user.phone || "")}" placeholder="optional" /></label>
                <p class="lede">${user.role === "admin" ? "This is the only administrator account." : "Staff account. It cannot be made an administrator."}</p>
                <button class="btn small" type="submit">Save account</button>
              </div>
            </form>
            ${self ? "" : `<form class="manage" data-set-password="${user.id}">
              <div class="form-grid">
                <label>New password<input name="password" type="password" minlength="6" required placeholder="At least 6 characters" /></label>
                <label class="reenter">Re-enter password<input name="confirm" type="password" minlength="6" required placeholder="Type the password again" /></label>
                <button class="btn small" type="submit">Reset password</button>
              </div>
            </form>
            <button class="btn small danger" data-remove="${user.id}">Remove account</button>`}` : ""}
          </article>`;
        })
        .join("")}
    </div>`;
}

function bindAccounts() {
  const create = document.getElementById("create-account");
  if (!document.getElementById("profile-form")) return;
  if (create) create.onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    state.error = "";
    state.notice = "";
    if (form.get("password") !== form.get("confirm")) {
      state.error = "The two passwords do not match.";
      draw();
      return;
    }
    try {
      await api("/api/auth/register", {
        method: "POST",
        body: {
          name: form.get("name"),
          username: form.get("username"),
          email: form.get("email"),
          phone: form.get("phone"),
          password: form.get("password"),
          confirm: form.get("confirm"),
        },
      });
      state.notice = "Account created. They can sign in with that username or company email.";
      await refreshUsers();
      draw();
    } catch (error) {
      state.error = error.message;
      draw();
    }
  };
  document.getElementById("profile-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    state.error = "";
    state.notice = "";
    try {
      const data = await api("/api/auth/profile", {
        method: "POST",
        body: { email: form.get("email"), phone: form.get("phone") },
      });
      state.user = data.user;
      state.notice = "Company email and phone saved.";
      await refreshUsers();
      draw();
    } catch (error) {
      state.error = error.message;
      draw();
    }
  };
  document.getElementById("change-password").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    state.error = "";
    state.notice = "";
    if (form.get("next") !== form.get("confirm")) {
      state.error = "The two passwords do not match.";
      draw();
      return;
    }
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: { current: form.get("current"), next: form.get("next"), confirm: form.get("confirm") },
      });
      state.notice = "Password changed.";
      draw();
    } catch (error) {
      state.error = error.message;
      draw();
    }
  };
  document.querySelectorAll("[data-manage]").forEach((form) => {
    form.onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const person = state.users.find((entry) => entry.id === form.dataset.manage);
      try {
        const saved = await api(`/api/users/${form.dataset.manage}`, {
          method: "PUT",
          body: { name: data.get("name"), email: data.get("email"), phone: data.get("phone") },
        });
        if (saved.user.id === state.user.id) state.user = saved.user;
        state.notice = `Account updated for ${person ? person.name : saved.user.name}.`;
        state.error = "";
        await refreshUsers();
        draw();
      } catch (error) {
        state.error = error.message;
        draw();
      }
    };
  });
  document.querySelectorAll("[data-set-password]").forEach((form) => {
    form.onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const password = data.get("password");
      const person = state.users.find((entry) => entry.id === form.dataset.setPassword);
      if (password !== data.get("confirm")) {
        state.error = "The two passwords do not match.";
        state.notice = "";
        draw();
        return;
      }
      try {
        await api(`/api/users/${form.dataset.setPassword}/password`, { method: "POST", body: { password, confirm: data.get("confirm") } });
        state.notice = `New password set for ${person ? person.name : "that account"}.`;
        state.error = "";
        await refreshUsers();
        draw();
      } catch (error) {
        state.error = error.message;
        draw();
      }
    };
  });
  document.querySelectorAll("[data-remove]").forEach((button) => {
    button.onclick = async () => {
      const user = state.users.find((entry) => entry.id === button.dataset.remove);
      if (!user || !window.confirm(`Remove ${user.name}'s account? Their past updates stay in the activity log.`)) return;
      try {
        await api(`/api/users/${user.id}`, { method: "DELETE" });
        await refreshUsers();
        state.notice = "Account removed.";
        draw();
      } catch (error) {
        state.error = error.message;
        draw();
      }
    };
  });
}

async function refreshItems() {
  const data = await api("/api/items");
  state.items = data.items;
  state.reviewDays = data.reviewDays || 30;
}

async function refreshAudit() {
  const data = await api("/api/audit");
  state.audit = data.audit;
}

async function refreshUsers() {
  const data = await api("/api/users");
  state.users = data.users;
  state.resets = data.resets || [];
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (state.modal) {
      state.modal = null;
      state.error = "";
      draw();
    } else if (state.selectedId) {
      state.selectedId = null;
      draw();
    }
  }
});

setInterval(async () => {
  if (!state.user || state.modal) return;
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
  try {
    if (state.view === "inventory") {
      const previous = state.items.map((item) => `${item.id}:${item.updatedAt}`).join("|");
      await refreshItems();
      const next = state.items.map((item) => `${item.id}:${item.updatedAt}`).join("|");
      if (previous !== next && !state.selectedId) {
        const y = window.scrollY;
        renderView();
        window.scrollTo(0, y);
      }
    } else if (state.view === "activity") {
      const previous = state.audit.map((entry) => entry.id).join("|");
      await refreshAudit();
      if (previous !== state.audit.map((entry) => entry.id).join("|")) {
        const y = window.scrollY;
        renderView();
        window.scrollTo(0, y);
      }
    } else if (state.view === "accounts") {
      const previous = state.users.map((user) => `${user.id}:${user.email}:${user.phone}:${user.name}`).join("|");
      await refreshUsers();
      const next = state.users.map((user) => `${user.id}:${user.email}:${user.phone}:${user.name}`).join("|");
      if (previous !== next) {
        const y = window.scrollY;
        renderView();
        window.scrollTo(0, y);
      }
    }
  } catch {
    /* keep the current screen if a refresh fails */
  }
}, 15000);

async function boot() {
  try {
    const setup = await api("/api/auth/setup");
    state.needsSetup = !!setup.needsSetup;
  } catch (error) {
    state.needsSetup = false;
    state.error = error.message || "The shared store record on GitHub could not be loaded. Refresh the page.";
  }
  try {
    const data = await api("/api/auth/me");
    state.user = data.user;
    state.reviewDays = data.reviewDays || 30;
    await refreshItems();
  } catch {
    state.user = null;
  }
  draw();
}

boot();
