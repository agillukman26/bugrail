/* ==========================================================
   utils.js — shared helpers used across all modules.
   Kept framework-free and dependency-free so it can be reused
   if this app is ever wired up to a real backend later:
   just swap the Storage.* implementations for API calls.
   ========================================================== */

const STORAGE_KEYS = {
  TESTCASES: "qa_testcases",
  BUGS: "qa_bugs",
  FILES: "qa_files", // Test Case grouping ("file"/folder)
  SETTINGS: "qa_settings",
  COUNTERS: "qa_counters",
  TRASH: "qa_trash", // holds last deleted item(s) for Undo
};

/* ---------- MySQL-backed storage (via server/), with a localStorage
   fallback so the app still works (e.g. for an offline demo/presentation)
   when the API server is off ----------
   Data lives in the `kv_store` table on the API in server/, one JSON blob
   per key — same shape this app used to keep in localStorage.
   `hydrate()` loads every key once into `cache` on app boot (awaited
   before Auth.init() runs — see auth.js): tries the API first, and if
   that fails, falls back to whatever's in localStorage (last known-good
   data — e.g. dummy data made in an earlier offline session). After
   hydrate, get()/set() stay perfectly synchronous against `cache` (so the
   rest of the app never has to become async). set() always writes
   localStorage immediately (so data survives a reload even with the
   server off) and fires the same write to MySQL in the background
   best-effort. */
const API_BASE = "/api";

const Storage = {
  cache: {},
  serverOnline: true,

  async hydrate() {
    try {
      const res = await fetch(`${API_BASE}/kv`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.cache = await res.json();
      this.serverOnline = true;
    } catch (e) {
      console.error(
        "Storage.hydrate: API unreachable, falling back to localStorage",
        e,
      );
      this.serverOnline = false;
      this.cache = {};
      Object.values(STORAGE_KEYS).forEach((key) => {
        try {
          const raw = localStorage.getItem(key);
          if (raw) this.cache[key] = JSON.parse(raw);
        } catch (err) {
          console.error("Storage.hydrate: bad localStorage value", key, err);
        }
      });
      Toast.show(
        "Server database tidak terhubung — memakai data lokal (offline).",
        "info",
      );
    }
  },

  get(key, fallback) {
    const value = this.cache[key];
    return value === undefined || value === null ? fallback : value;
  },

  set(key, value) {
    this.cache[key] = value;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error("Storage.set: localStorage write failed", key, e);
    }
    fetch(`${API_BASE}/kv/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    })
      .then(() => {
        this.serverOnline = true;
      })
      .catch((e) => {
        if (this.serverOnline)
          Toast.show(
            "Server database tidak terhubung, data disimpan lokal saja.",
            "info",
          );
        this.serverOnline = false;
        console.error(
          "Storage.set: MySQL sync failed, kept in localStorage",
          key,
          e,
        );
      });
    return true;
  },
};

/* ---------- Auto-increment ID generator (TC-0001 / BUG-0001) ---------- */
const IdGen = {
  next(prefix) {
    const counters = Storage.get(STORAGE_KEYS.COUNTERS, {});
    const current = (counters[prefix] || 0) + 1;
    counters[prefix] = current;
    Storage.set(STORAGE_KEYS.COUNTERS, counters);
    return `${prefix}-${String(current).padStart(4, "0")}`;
  },
  // Keeps counters in sync with imported data so new IDs never collide.
  syncFromExisting(prefix, existingIds) {
    const counters = Storage.get(STORAGE_KEYS.COUNTERS, {});
    let max = counters[prefix] || 0;
    existingIds.forEach((id) => {
      const m = String(id).match(new RegExp(`^${prefix}-(\\d+)$`));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    counters[prefix] = max;
    Storage.set(STORAGE_KEYS.COUNTERS, counters);
  },
  // Test Case IDs use a per-module prefix (e.g. LOG-0001), so sync each
  // distinct prefix found in existing IDs instead of one fixed prefix.
  syncAllFromExisting(existingIds) {
    const byPrefix = {};
    existingIds.forEach((id) => {
      const m = String(id).match(/^([A-Z]+)-(\d+)$/);
      if (!m) return;
      (byPrefix[m[1]] ||= []).push(id);
    });
    Object.keys(byPrefix).forEach((prefix) =>
      this.syncFromExisting(prefix, byPrefix[prefix]),
    );
  },
};

/* Abbreviates a Module name into a 3-letter Test Case ID prefix.
   "Login" -> "LOG", "User Management" -> initials "UM" + extra letters -> "UMS". */
function moduleAbbrev(module) {
  const words = String(module || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "TC";
  const initials = words.map((w) => w[0].toUpperCase());
  if (initials.length >= 3) return initials.slice(0, 3).join("");
  const extra = words.flatMap((w) => w.slice(1).toUpperCase().split(""));
  return initials.concat(extra).slice(0, 3).join("").padEnd(3, "X");
}

/* ---------- Toast notifications ---------- */
const Toast = {
  container() {
    let el = document.getElementById("toastStack");
    if (!el) {
      el = document.createElement("div");
      el.id = "toastStack";
      el.className = "toast-stack";
      document.body.appendChild(el);
    }
    return el;
  },
  show(message, type = "info", opts = {}) {
    const stack = this.container();
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    const icon = { success: "✓", error: "⚠", info: "ℹ" }[type] || "ℹ";
    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    if (opts.undo) {
      const undoBtn = document.createElement("span");
      undoBtn.className = "undo";
      undoBtn.textContent = "UNDO";
      undoBtn.onclick = () => {
        opts.undo();
        toast.remove();
      };
      toast.appendChild(undoBtn);
    }
    stack.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = "opacity .25s";
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 250);
    }, opts.duration || 4000);
  },
};

/* ---------- Confirm dialog (returns a Promise<boolean>) ---------- */
function confirmDialog(title, message, confirmLabel = "Hapus") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay confirm-modal active";
    overlay.innerHTML = `
      <div class="modal">
        <div class="icon-warn">!</div>
        <h2 style="margin:0 0 6px;">${escapeHtml(title)}</h2>
        <p class="text-dim" style="font-size:13px;">${escapeHtml(message)}</p>
        <div class="modal-footer" style="justify-content:center;">
          <button class="btn" id="cancelConfirm">Batal</button>
          <button class="btn danger" id="okConfirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#cancelConfirm").onclick = () => {
      overlay.remove();
      resolve(false);
    };
    overlay.querySelector("#okConfirm").onclick = () => {
      overlay.remove();
      resolve(true);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(false);
      }
    });
  });
}

/* ---------- Prompt dialog (returns a Promise<string|null>) ----------
   Optional `validate(value)` returns an error string to block closing and
   show it inline under the input, or falsy to accept. */
function promptDialog(
  title,
  placeholder = "",
  defaultValue = "",
  confirmLabel = "Simpan",
  validate = null,
) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay confirm-modal active";
    overlay.innerHTML = `
      <div class="modal">
        <h2 style="margin:0 0 14px;">${escapeHtml(title)}</h2>
        <div class="field">
          <input type="text" id="promptDialogInput" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}">
          <p class="combobox-error" id="promptDialogError" style="display:none;"></p>
        </div>
        <div class="modal-footer" style="justify-content:center;">
          <button class="btn" id="cancelPrompt">Batal</button>
          <button class="btn primary" id="okPrompt">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector("#promptDialogInput");
    const errorEl = overlay.querySelector("#promptDialogError");
    input.focus();
    input.select();
    const close = (value) => {
      overlay.remove();
      resolve(value);
    };
    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.style.display = "block";
      input.classList.add("input-invalid");
    };
    const submit = () => {
      const value = input.value.trim() || null;
      if (value && validate) {
        const err = validate(value);
        if (err) {
          showError(err);
          return;
        }
      }
      close(value);
    };
    input.addEventListener("input", () => {
      errorEl.style.display = "none";
      input.classList.remove("input-invalid");
    });
    overlay.querySelector("#cancelPrompt").onclick = () => close(null);
    overlay.querySelector("#okPrompt").onclick = submit;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
  });
}

/* ---------- Small helpers ---------- */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function debounce(fn, wait = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* Convert an array of objects to CSV text (handles quoting/commas). */
function arrayToCSV(rows, columns) {
  const header = columns.map((c) => c.label).join(",");
  const lines = rows.map((row) =>
    columns
      .map((c) => {
        let v = row[c.key];
        if (v === null || v === undefined) v = "";
        v = String(v).replace(/"/g, '""');
        return `"${v}"`;
      })
      .join(","),
  );
  return [header, ...lines].join("\r\n");
}

/* Simple highlight for realtime search matches (used in a couple tables). */
function highlight(text, term) {
  if (!term) return escapeHtml(text ?? "");
  const t = escapeHtml(String(text ?? ""));
  const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return t.replace(new RegExp(safeTerm, "ig"), (m) => `<mark>${m}</mark>`);
}
