const pathForm = document.getElementById("path-form");
const pathInput = document.getElementById("path-input");
const uploadForm = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const folderInput = document.getElementById("folder-input");
const selectionEl = document.getElementById("selection");
const uploadBtn = document.getElementById("upload-btn");
const resultEl = document.getElementById("result");
const resultName = document.getElementById("result-name");
const urlsEl = document.getElementById("urls");
const shareList = document.getElementById("share-list");
const refreshBtn = document.getElementById("refresh-btn");
const netInfo = document.getElementById("net-info");

/** @type {FileList | null} */
let pendingFiles = null;

function showShare(share) {
  resultEl.hidden = false;
  resultName.textContent = share.name;
  urlsEl.innerHTML = "";

  const cards = [
    { label: "This PC", href: share.urls.local },
    ...share.urls.lan.map((href, i) => ({ label: `Phone / LAN ${i + 1}`, href })),
  ];

  for (const card of cards) {
    const div = document.createElement("div");
    div.className = "url-card";
    div.innerHTML = `<strong>${card.label}</strong><a href="${card.href}" target="_blank" rel="noopener">${card.href}</a>`;
    const actions = document.createElement("div");
    actions.className = "actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn ghost";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(card.href);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    });
    actions.append(copy);
    div.append(actions);
    urlsEl.append(div);
  }
}

function updateSelection() {
  if (!pendingFiles || pendingFiles.length === 0) {
    selectionEl.textContent = "Nothing selected";
    uploadBtn.disabled = true;
    return;
  }
  const names = [...pendingFiles].slice(0, 3).map((f) => f.name);
  const more = pendingFiles.length > 3 ? ` (+${pendingFiles.length - 3} more)` : "";
  selectionEl.textContent = `${pendingFiles.length} item(s): ${names.join(", ")}${more}`;
  uploadBtn.disabled = false;
}

fileInput.addEventListener("change", () => {
  pendingFiles = fileInput.files;
  folderInput.value = "";
  updateSelection();
});

folderInput.addEventListener("change", () => {
  pendingFiles = folderInput.files;
  fileInput.value = "";
  updateSelection();
});

pathForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const path = pathInput.value.trim();
  if (!path) return;
  const res = await fetch("/api/share-path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Failed to share path");
    return;
  }
  showShare(data);
  await loadShares();
});

uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pendingFiles || pendingFiles.length === 0) return;
  uploadBtn.disabled = true;
  uploadBtn.textContent = "Uploading…";
  try {
    const form = new FormData();
    for (const file of pendingFiles) {
      const rel = file.webkitRelativePath || file.name;
      form.append("files", file, rel);
    }
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Upload failed");
      return;
    }
    showShare(data);
    pendingFiles = null;
    fileInput.value = "";
    folderInput.value = "";
    updateSelection();
    await loadShares();
  } finally {
    uploadBtn.textContent = "Upload & share";
    updateSelection();
  }
});

async function loadShares() {
  const res = await fetch("/api/shares");
  const shares = await res.json();
  shareList.innerHTML = "";
  if (!Array.isArray(shares) || shares.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No active shares yet.";
    shareList.append(li);
    return;
  }
  for (const share of shares) {
    const li = document.createElement("li");
    const primary = share.urls.lan[0] || share.urls.local;
    li.innerHTML = `<div class="name">${share.name}</div><a href="${primary}" target="_blank" rel="noopener">${primary}</a>`;
    const row = document.createElement("div");
    row.className = "row";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Remove";
    del.addEventListener("click", async () => {
      await fetch(`/api/shares/${share.id}`, { method: "DELETE" });
      await loadShares();
    });
    row.append(del);
    li.append(row);
    shareList.append(li);
  }
}

refreshBtn.addEventListener("click", () => loadShares());

async function loadInfo() {
  const res = await fetch("/api/info");
  const info = await res.json();
  const lan = (info.lanAddresses || []).join(", ") || "no LAN IPv4 detected";
  netInfo.textContent = `Port ${info.port} · LAN ${lan}`;
}

loadInfo();
loadShares();
