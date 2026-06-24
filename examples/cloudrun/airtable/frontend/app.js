// airtable-on-zeropg frontend: a tiny vanilla-JS SPA. No framework, no build
// step => the static shell renders instantly while the backend cold-starts.
//
// THE WAKE TRICK: the very first thing we do on load is fire a fire-and-forget
// GET /wake at the backend so it cold-starts IN PARALLEL behind the user's
// think-time. We render the shell immediately and only fetch data when the user
// actually opens a table. The wake call is best-effort: its result is ignored
// and a failure never blocks the UI.

const API = (window.AIRTABLE_API || "").replace(/\/$/, "");

// --- fire the wake immediately, before anything else renders data ---
(function wakeBackend() {
  const el = document.getElementById("wake-state");
  if (!API) { if (el) el.textContent = ""; return; }
  const t0 = performance.now();
  fetch(API + "/wake", { method: "GET", keepalive: true })
    .then((r) => r.ok ? r.json() : Promise.reject())
    .then(() => { if (el) el.textContent = `backend ready (${Math.round(performance.now() - t0)}ms)`; })
    .catch(() => { if (el) el.textContent = "backend waking..."; });
})();

const state = { tables: [], activeTbl: null, columns: [], rows: [] };

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  });
  (Array.isArray(kids) ? kids : [kids]).forEach((c) =>
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
  );
  return n;
};

async function api(path, opts) {
  const r = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

// ---------- tables ----------

async function loadTables() {
  state.tables = await api("/api/tables");
  renderSidebar();
  // restore active table from URL hash so views are bookmarkable
  const id = location.hash.slice(1);
  if (id && state.tables.find((t) => t.id === id)) openTable(id);
}

function renderSidebar() {
  const list = $("#table-list");
  list.innerHTML = "";
  state.tables.forEach((t) => {
    list.appendChild(
      el("div", {
        class: "tbl-item" + (t.id === state.activeTbl ? " active" : ""),
        onclick: () => openTable(t.id),
      }, [
        el("span", {}, t.name),
        el("span", {
          class: "del", title: "Delete table",
          onclick: async (e) => { e.stopPropagation(); await deleteTable(t.id); },
        }, "x"),
      ])
    );
  });
}

async function newTable() {
  const name = prompt("Table name?", "Untitled");
  if (!name) return;
  const t = await api("/api/tables", { method: "POST", body: JSON.stringify({ name }) });
  await loadTables();
  openTable(t.id);
}

async function deleteTable(id) {
  if (!confirm("Delete this table and all its rows?")) return;
  await api("/api/tables/" + id, { method: "DELETE" });
  if (state.activeTbl === id) { state.activeTbl = null; location.hash = ""; $("#main").innerHTML = '<div class="empty">Pick or create a table.</div>'; }
  await loadTables();
}

// ---------- grid ----------

async function openTable(id) {
  state.activeTbl = id;
  location.hash = id;
  renderSidebar();
  $("#main").innerHTML = '<div class="empty">Loading...</div>';
  const [cols, rows] = await Promise.all([
    api(`/api/tables/${id}/columns`),
    api(`/api/tables/${id}/rows`),
  ]);
  state.columns = cols;
  state.rows = rows;
  renderGrid();
}

function renderGrid() {
  const main = $("#main");
  main.innerHTML = "";

  const toolbar = el("div", { class: "toolbar" }, [
    el("button", { class: "primary", onclick: addRow }, "+ Row"),
    el("button", { onclick: openColDialog }, "+ Column"),
    el("span", { style: "color:var(--muted);font-size:12px" }, `${state.rows.length} rows`),
  ]);
  main.appendChild(toolbar);

  if (state.columns.length === 0) {
    main.appendChild(el("div", { class: "empty" }, "No columns yet. Add one to start."));
    return;
  }

  const table = el("table", { class: "grid" });
  const thead = el("tr", {}, [
    ...state.columns.map((c) =>
      el("th", {}, [
        el("span", {}, c.name),
        el("span", { class: "ctype" }, c.type),
        el("span", {
          class: "delcol", title: "Delete column",
          onclick: () => deleteColumn(c.id),
        }, "x"),
      ])
    ),
    el("th", { style: "min-width:40px" }, ""),
  ]);
  table.appendChild(el("thead", {}, thead));

  const tbody = el("tbody");
  state.rows.forEach((row) => tbody.appendChild(renderRow(row)));
  table.appendChild(tbody);
  main.appendChild(table);
}

function renderRow(row) {
  const tr = el("tr", { "data-rec": row.id });
  state.columns.forEach((c) => {
    tr.appendChild(el("td", {}, [cellInput(row, c)]));
  });
  tr.appendChild(
    el("td", {}, [
      el("button", {
        style: "border:0;background:transparent;color:var(--muted)",
        title: "Delete row",
        onclick: () => deleteRow(row.id),
      }, "x"),
    ])
  );
  return tr;
}

function cellInput(row, col) {
  const val = row.data[col.id];
  let input;
  if (col.type === "bool") {
    input = el("input", { type: "checkbox" });
    input.checked = val === true;
    input.addEventListener("change", () => saveCell(row, col, input.checked, input.closest("td")));
    return input;
  }
  if (col.type === "select") {
    input = el("select");
    input.appendChild(el("option", { value: "" }, "-"));
    (col.opts.choices || []).forEach((ch) => {
      const o = el("option", { value: ch }, ch);
      if (String(val) === String(ch)) o.selected = true;
      input.appendChild(o);
    });
    input.addEventListener("change", () => saveCell(row, col, input.value, input.closest("td")));
    return input;
  }
  const type = col.type === "number" ? "number" : col.type === "date" ? "date" : "text";
  input = el("input", { type });
  input.value = val == null ? "" : val;
  // Commit on blur or Enter; this is when we WAIT for the backend commit and
  // reconcile the returned canonical value (never an early optimistic ACK).
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  input.addEventListener("blur", () => saveCell(row, col, input.value, input.closest("td")));
  return input;
}

async function saveCell(row, col, value, td) {
  td.classList.remove("cell-error");
  td.classList.add("cell-saving");
  try {
    const updated = await api("/api/rows/" + row.id, {
      method: "PATCH",
      body: JSON.stringify({ col_id: col.id, value }),
    });
    row.data = updated.data;
    row.version = updated.version;
    td.classList.remove("cell-saving");
    // reconcile displayed value with the canonical stored value
    const stored = updated.data[col.id];
    const inp = td.querySelector("input,select");
    if (inp && col.type !== "bool") inp.value = stored == null ? "" : stored;
  } catch (e) {
    td.classList.remove("cell-saving");
    td.classList.add("cell-error");
    td.title = e.message;
  }
}

async function addRow() {
  const rec = await api(`/api/tables/${state.activeTbl}/rows`, {
    method: "POST",
    body: JSON.stringify({ data: {} }),
  });
  state.rows.push(rec);
  renderGrid();
}

async function deleteRow(id) {
  await api("/api/rows/" + id, { method: "DELETE" });
  state.rows = state.rows.filter((r) => r.id !== id);
  renderGrid();
}

async function deleteColumn(id) {
  if (!confirm("Delete this column and its data?")) return;
  await api("/api/columns/" + id, { method: "DELETE" });
  await openTable(state.activeTbl);
}

// ---------- add-column dialog ----------

function openColDialog() {
  $("#col-name").value = "";
  $("#col-type").value = "text";
  $("#col-choices").value = "";
  $("#choices-row").style.display = "none";
  $("#col-dialog").showModal();
  $("#col-name").focus();
}

$("#col-type").addEventListener("change", (e) => {
  $("#choices-row").style.display = e.target.value === "select" ? "flex" : "none";
});
$("#col-cancel").addEventListener("click", () => $("#col-dialog").close());
$("#col-save").addEventListener("click", async () => {
  const name = $("#col-name").value.trim();
  if (!name) return;
  const type = $("#col-type").value;
  const opts = {};
  if (type === "select") {
    opts.choices = $("#col-choices").value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  try {
    await api(`/api/tables/${state.activeTbl}/columns`, {
      method: "POST",
      body: JSON.stringify({ name, type, opts }),
    });
    $("#col-dialog").close();
    await openTable(state.activeTbl);
  } catch (e) {
    alert(e.message);
  }
});

$("#new-table").addEventListener("click", newTable);
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id && id !== state.activeTbl && state.tables.find((t) => t.id === id)) openTable(id);
});

// boot
loadTables().catch((e) => {
  $("#table-list").innerHTML = `<div class="empty" style="font-size:12px">backend not ready yet<br/>${e.message}</div>`;
  // retry once shortly; backend may still be cold-starting
  setTimeout(() => loadTables().catch(() => {}), 2500);
});
