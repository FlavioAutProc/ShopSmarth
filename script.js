/* ==================================================================
   ShopSmart 2.0 — Listas de compras com carrinho e comparativo real
   IndexedDB: LISTS (uma lista de compras por vez) + ITEMS (itens de
   cada lista, marcáveis como "já no carrinho").
   ================================================================== */

// ---------------------------------------------------------------
// 1. Constantes e estado
// ---------------------------------------------------------------
let db;
const DB_NAME = "ShopSmartDB2";
const DB_VERSION = 2; // v2: adiciona o store "products" (catálogo / ID de produto)
const STORES = { LISTS: "lists", ITEMS: "items", PRODUCTS: "products" };

const CATEGORIES = {
  food: { name: "Alimentos", color: "#C6863A", cls: "category-food" },
  produce: { name: "Hortifruti", color: "#6B9080", cls: "category-produce" },
  meat: { name: "Carnes e frios", color: "#A04A3B", cls: "category-meat" },
  clean: { name: "Limpeza", color: "#4E7EA6", cls: "category-clean" },
  hygiene: { name: "Higiene", color: "#9B7EBD", cls: "category-hygiene" },
  drinks: { name: "Bebidas", color: "#D4667A", cls: "category-drinks" },
  other: { name: "Outros", color: "#8A8578", cls: "category-other" },
};

let lists = [];
let items = [];
let products = [];

let compareView = "lists"; // 'lists' | 'spend' | 'prices'
let spendGran = "month";   // 'week' | 'month' | 'year'
let spendSelected = null;  // início (timestamp) do período selecionado; null = atual
let priceSearch = "";

let activeTab = "home";
let currentListId = null;
let listFilter = "all";
let sortMode = "category"; // 'category' | 'recent'
let comparePeriod = 30; // number of days, or 'all'
let searchTerm = "";
let confirmCallback = null;
let openSwipeRow = null;

// ---------------------------------------------------------------
// 2. Inicialização
// ---------------------------------------------------------------
document.addEventListener("DOMContentLoaded", initApp);

async function initApp() {
  await initDatabase();
  await loadLists();
  await loadItems();
  await loadProducts();
  setupEventListeners();
  registerServiceWorker();
  setupInstallPrompt();
  showTab("home");
  if (new URLSearchParams(window.location.search).get("action") === "new-list") {
    openListModal();
  }
  setTimeout(() => showNotification("Bem-vindo de volta! 🛒", "info"), 600);
}

function initDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (e) => reject(e.target.error);
    request.onsuccess = (e) => {
      db = e.target.result;
      db.onversionchange = () => db.close(); // não trava upgrade em outra aba
      resolve(db);
    };
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORES.LISTS)) {
        database.createObjectStore(STORES.LISTS, { keyPath: "id", autoIncrement: true });
      }
      if (!database.objectStoreNames.contains(STORES.ITEMS)) {
        const itemStore = database.createObjectStore(STORES.ITEMS, { keyPath: "id", autoIncrement: true });
        itemStore.createIndex("listId", "listId", { unique: false });
      }
      if (!database.objectStoreNames.contains(STORES.PRODUCTS)) {
        const prodStore = database.createObjectStore(STORES.PRODUCTS, { keyPath: "id", autoIncrement: true });
        prodStore.createIndex("barcode", "barcode", { unique: false });
      }
    };
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}
function dbPut(storeName, obj) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readwrite");
    const req = tx.objectStore(storeName).put(obj);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}
function dbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readwrite");
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}
function dbClear(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readwrite");
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function loadLists() { lists = await dbGetAll(STORES.LISTS); invalidateCaches(); }
async function loadItems() { items = await dbGetAll(STORES.ITEMS); invalidateCaches(); }
async function loadProducts() { products = await dbGetAll(STORES.PRODUCTS); }

// ---------------------------------------------------------------
// 3. Utilitários
// ---------------------------------------------------------------
function formatMoney(v) {
  v = Number(v) || 0;
  const sign = v < 0 ? "-" : "";
  return sign + "R$ " + Math.abs(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatMoneyCompact(v) {
  v = Number(v) || 0;
  const sign = v < 0 ? "-" : "";
  if (Math.abs(v) >= 1000) return sign + "R$ " + (Math.abs(v) / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "k";
  return formatMoney(v);
}
function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function formatDateShort(iso) {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
function daysAgo(iso) {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}
function catInfo(cat) { return CATEGORIES[cat] || CATEGORIES.other; }
function itemsForList(listId) { return items.filter((i) => i.listId === listId); }
// Total de uma linha, arredondado em centavos como as balanças de venda
// (peso em gramas × preço/kg em centavos, meio centavo arredonda pra cima).
function lineTotal(qty, price) {
  const grams = Math.round((Number(qty) || 0) * 1000);
  const cents = Math.round((Number(price) || 0) * 100);
  return Math.round((grams * cents) / 1000) / 100;
}
function itemTotal(i) { return lineTotal(i.quantity, i.unitPrice); }
function isKg(i) { return i.unitType === "kg"; }
function unitLabel(i) { return isKg(i) ? "kg" : "un"; }
function formatQty(i) {
  if (isKg(i)) return Number(i.quantity).toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + " kg";
  return `${i.quantity} un`;
}
function plannedTotal(listId) {
  return itemsForList(listId).reduce((s, i) => s + itemTotal(i), 0);
}
function spentTotal(listId) {
  return itemsForList(listId).filter((i) => i.checked).reduce((s, i) => s + itemTotal(i), 0);
}
function checkedCount(listId) {
  const li = itemsForList(listId);
  return { done: li.filter((i) => i.checked).length, total: li.length };
}
function sortedLists() {
  return [...lists].sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
}
function completedListsSorted() {
  return lists
    .filter((l) => l.status === "completed")
    .sort((a, b) => new Date(a.completedDate) - new Date(b.completedDate));
}
function getActiveList() {
  const actives = lists.filter((l) => l.status === "active").sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
  return actives[0] || null;
}

// Economia real de uma lista concluída:
// se tiver orçamento definido -> orçamento - gasto
// senão -> média das 2 listas concluídas anteriores - gasto
function economyFor(list) {
  const spent = spentTotal(list.id);
  if (list.budget != null && list.budget > 0) {
    return { value: list.budget - spent, base: "orçamento" };
  }
  const priorCompleted = lists
    .filter((l) => l.status === "completed" && l.id !== list.id && new Date(l.completedDate) < new Date(list.completedDate || list.createdDate))
    .sort((a, b) => new Date(b.completedDate) - new Date(a.completedDate))
    .slice(0, 2);
  if (priorCompleted.length === 0) return { value: null, base: null };
  const avg = priorCompleted.reduce((s, l) => s + spentTotal(l.id), 0) / priorCompleted.length;
  return { value: avg - spent, base: "histórico" };
}

// ---------------------------------------------------------------
// 4. Navegação
// ---------------------------------------------------------------
function setupEventListeners() {
  document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  });
  document.getElementById("nav-new-list").addEventListener("click", () => openListModal());
  document.querySelectorAll("[data-goto-tab]").forEach((el) => {
    el.addEventListener("click", (e) => { e.preventDefault(); showTab(el.dataset.gotoTab); });
  });

  document.getElementById("btn-more").addEventListener("click", () => showTab("more"));
  document.getElementById("btn-search").addEventListener("click", toggleSearch);
  document.getElementById("search-close").addEventListener("click", toggleSearch);
  document.getElementById("search-input").addEventListener("input", (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    renderLists();
  });

  document.querySelectorAll(".chip[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip[data-filter]").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      listFilter = chip.dataset.filter;
      renderLists();
    });
  });

  document.querySelectorAll(".ptab[data-period]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".ptab[data-period]").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      comparePeriod = tab.dataset.period === "all" ? "all" : parseInt(tab.dataset.period, 10);
      renderCompare();
    });
  });

  // Modais genéricos (fechar por backdrop / botão)
  document.getElementById("modal-backdrop").addEventListener("click", closeAllModals);
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });

  // Lista: form
  document.getElementById("list-form").addEventListener("submit", handleListSubmit);

  // Detalhe da lista
  document.getElementById("detail-back").addEventListener("click", () => showTab("lists"));
  document.getElementById("add-product-btn").addEventListener("click", () => openProductModal());
  document.getElementById("product-form").addEventListener("submit", handleProductSubmit);
  document.getElementById("finish-list-btn").addEventListener("click", confirmFinishList);
  document.getElementById("sort-toggle").addEventListener("click", toggleSortMode);
  document.getElementById("detail-menu").addEventListener("click", openDetailMenu);
  document.getElementById("alc-continue").addEventListener("click", () => {
    const al = getActiveList();
    if (al) openListDetail(al.id);
  });

  // Mais
  document.getElementById("export-pdf-btn").addEventListener("click", exportReport);
  document.getElementById("export-data-btn").addEventListener("click", exportBackup);
  document.getElementById("import-data-btn").addEventListener("click", () => document.getElementById("import-file-input").click());
  document.getElementById("import-file-input").addEventListener("change", importBackup);
  document.getElementById("clear-data-btn").addEventListener("click", confirmClearAll);

  document.getElementById("confirm-cancel").addEventListener("click", () => closeModal("confirm-modal"));
  document.getElementById("confirm-ok").addEventListener("click", () => {
    const cb = confirmCallback;
    closeModal("confirm-modal");
    if (cb) cb();
  });

  setupV21Events();
}

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const target = document.querySelector(`.screen[data-tab="${tab === "listdetail" ? "listdetail" : tab}"]`);
  if (target) target.classList.add("active");

  document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
    const navMatch = tab === "listdetail" ? "lists" : tab;
    btn.classList.toggle("active", btn.dataset.tab === navMatch);
  });

  const topbar = document.getElementById("topbar");
  const titles = { home: ["shopsmart", "Início"], lists: ["shopsmart", "Minhas listas"], compare: ["shopsmart", "Comparativo"], more: ["shopsmart", "Mais"] };
  if (tab === "listdetail") {
    topbar.style.display = "none";
  } else {
    topbar.style.display = "";
    topbar.classList.toggle("ctx-lists", tab === "lists");
    document.getElementById("topbar-eyebrow").textContent = titles[tab][0];
    document.getElementById("topbar-title").textContent = titles[tab][1];
    if (tab !== "lists") closeSearchIfOpen();
  }

  document.getElementById("app-main").scrollTo({ top: 0, behavior: "instant" });

  if (tab === "home") renderHome();
  if (tab === "lists") renderLists();
  if (tab === "compare") renderCompare();
}

function toggleSearch() {
  const box = document.getElementById("topbar-search");
  box.classList.toggle("open");
  if (box.classList.contains("open")) {
    document.getElementById("search-input").focus();
  } else {
    document.getElementById("search-input").value = "";
    searchTerm = "";
    renderLists();
  }
}
function closeSearchIfOpen() {
  document.getElementById("topbar-search").classList.remove("open");
  document.getElementById("search-input").value = "";
  searchTerm = "";
}

// ---------------------------------------------------------------
// 5. Modais
// ---------------------------------------------------------------
function openModal(id) {
  document.getElementById("modal-backdrop").classList.add("show");
  document.getElementById(id).classList.add("active");
}
function closeModal(id) {
  document.getElementById(id).classList.remove("active");
  const anyOpen = document.querySelectorAll(".modal.active").length > 0;
  if (!anyOpen) document.getElementById("modal-backdrop").classList.remove("show");
}
function closeAllModals() {
  document.querySelectorAll(".modal.active").forEach((m) => m.classList.remove("active"));
  document.getElementById("modal-backdrop").classList.remove("show");
}
function showConfirm(title, text, iconClass, onConfirm) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").textContent = text;
  document.getElementById("confirm-icon").innerHTML = `<i class="fa-solid ${iconClass || "fa-triangle-exclamation"}"></i>`;
  confirmCallback = onConfirm;
  openModal("confirm-modal");
}

// ---------------------------------------------------------------
// 6. Listas — criar / editar / concluir / excluir
// ---------------------------------------------------------------
function openListModal(listId = null) {
  const form = document.getElementById("list-form");
  form.reset();
  if (listId) {
    const list = lists.find((l) => l.id === listId);
    document.getElementById("list-modal-title").textContent = "Editar lista";
    document.getElementById("list-id").value = list.id;
    document.getElementById("list-name").value = list.name;
    document.getElementById("list-budget").value = list.budget ?? "";
  } else {
    document.getElementById("list-modal-title").textContent = "Nova lista";
    document.getElementById("list-id").value = "";
  }
  openModal("list-modal");
}

async function handleListSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("list-id").value;
  const name = document.getElementById("list-name").value.trim();
  const budgetRaw = document.getElementById("list-budget").value;
  const budget = budgetRaw === "" ? null : parseFloat(budgetRaw);

  if (name.length < 2) { showNotification("Digite um nome para a lista.", "error"); return; }
  if (budget != null && (isNaN(budget) || budget < 0)) { showNotification("Orçamento inválido.", "error"); return; }

  try {
    if (id) {
      const list = lists.find((l) => l.id === parseInt(id, 10));
      list.name = name;
      list.budget = budget;
      await dbPut(STORES.LISTS, list);
      showNotification("Lista atualizada!", "success");
    } else {
      const newList = { name, budget, status: "active", createdDate: new Date().toISOString(), completedDate: null };
      const newId = await dbPut(STORES.LISTS, newList);
      newList.id = newId;
      lists.push(newList);
      showNotification(`Lista "${name}" criada!`, "success");
      closeModal("list-modal");
      await loadLists();
      openListDetail(newId);
      return;
    }
    await loadLists();
    closeModal("list-modal");
    if (activeTab === "listdetail") renderListDetail();
    else if (activeTab === "home") renderHome();
    else renderLists();
  } catch (err) {
    console.error(err);
    showNotification("Erro ao salvar a lista.", "error");
  }
}

function openDetailMenu() {
  openListActionsMenu(currentListId);
}

function openListActionsMenu(listId) {
  const list = lists.find((l) => l.id === listId);
  if (!list) return;
  const actions = [
    { label: "Editar lista", icon: "fa-pen", run: () => openListModal(list.id) },
  ];
  if (list.status === "completed") {
    actions.push({ label: "Reabrir compra", icon: "fa-rotate-left", run: () => reopenList(list.id) });
  }
  if (itemsForList(list.id).length > 0) {
    actions.push({ label: "Exportar em PDF", icon: "fa-file-pdf", run: () => exportListPDF(list.id) });
  }
  actions.push({ label: "Excluir lista", icon: "fa-trash-can", danger: true, run: () => confirmDeleteList(list.id) });
  showActionSheet(actions);
}

function showActionSheet(actions) {
  let sheet = document.getElementById("action-sheet");
  if (!sheet) {
    sheet = document.createElement("div");
    sheet.id = "action-sheet";
    sheet.className = "modal";
    sheet.innerHTML = `<div class="modal-sheet"><div class="modal-handle"></div><div id="action-sheet-body"></div></div>`;
    document.querySelector(".app-shell").appendChild(sheet);
    sheet.addEventListener("click", (e) => { if (e.target === sheet) closeModal("action-sheet"); });
  }
  const body = document.getElementById("action-sheet-body");
  body.innerHTML = "";
  actions.forEach((a) => {
    const btn = document.createElement("button");
    btn.className = "menu-row" + (a.danger ? " menu-row-danger" : "");
    btn.innerHTML = `<span class="menu-row-icon"><i class="fa-solid ${a.icon}"></i></span><span class="menu-row-text"><strong>${a.label}</strong></span>`;
    btn.addEventListener("click", () => { closeModal("action-sheet"); a.run(); });
    body.appendChild(btn);
  });
  openModal("action-sheet");
}

function refreshCurrentScreen() {
  if (activeTab === "listdetail") renderListDetail();
  else if (activeTab === "home") renderHome();
  else if (activeTab === "lists") renderLists();
  else if (activeTab === "compare") renderCompare();
}

function confirmFinishList() {
  const list = lists.find((l) => l.id === currentListId);
  if (!list) return;
  const { done, total } = checkedCount(list.id);
  const pending = total - done;
  const text = pending > 0
    ? `${pending} ${pending === 1 ? "item ainda não foi marcado" : "itens ainda não foram marcados"} como pego. Apenas os itens marcados entram no valor gasto. Concluir mesmo assim?`
    : "Isso vai fechar a lista e registrar o valor gasto no seu histórico de comparação.";
  showConfirm("Concluir esta compra?", text, "fa-flag-checkered", () => finishList(list.id));
}

async function finishList(listId) {
  const list = lists.find((l) => l.id === listId);
  list.status = "completed";
  list.completedDate = new Date().toISOString();
  await dbPut(STORES.LISTS, list);
  await loadLists();
  const spent = spentTotal(listId);
  showNotification(`Compra concluída — ${formatMoney(spent)} registrados.`, "success");
  showTab("lists");
}

async function reopenList(listId) {
  const list = lists.find((l) => l.id === listId);
  list.status = "active";
  list.completedDate = null;
  await dbPut(STORES.LISTS, list);
  await loadLists();
  showNotification("Lista reaberta para edição.", "info");
  if (activeTab !== "listdetail" || currentListId !== listId) openListDetail(listId);
  else renderListDetail();
}

function confirmDeleteList(listId) {
  const list = lists.find((l) => l.id === listId);
  showConfirm("Excluir lista?", `A lista "${list.name}" e todos os seus itens serão apagados permanentemente.`, "fa-trash-can", () => deleteList(listId));
}
async function deleteList(listId) {
  const toDelete = itemsForList(listId).map((i) => i.id);
  for (const id of toDelete) await dbDelete(STORES.ITEMS, id);
  await dbDelete(STORES.LISTS, listId);
  await loadLists();
  await loadItems();
  await pruneOrphanProducts();
  showNotification("Lista excluída.", "success");
  if (activeTab === "listdetail" && currentListId === listId) showTab("lists");
  else refreshCurrentScreen();
}

// ---------------------------------------------------------------
// 6.1 Exportar uma lista em PDF
// ---------------------------------------------------------------
function exportListPDF(listId) {
  const list = lists.find((l) => l.id === listId);
  if (!list) return;
  const listItems = itemsForList(listId);
  if (listItems.length === 0) { showNotification("Essa lista ainda não tem itens.", "error"); return; }
  if (!window.jspdf) { showNotification("Não foi possível carregar o gerador de PDF.", "error"); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF("p", "mm", "a4");
  const planned = plannedTotal(listId);
  const spent = spentTotal(listId);

  doc.setFontSize(17);
  doc.setTextColor(23, 60, 54);
  doc.text(list.name, 14, 18);

  doc.setFontSize(10);
  doc.setTextColor(110);
  const statusLabel = list.status === "completed" ? `Concluída em ${formatDate(list.completedDate)}` : `Criada em ${formatDate(list.createdDate)}`;
  doc.text(statusLabel, 14, 25);

  const sorted = [...listItems].sort((a, b) => a.checked - b.checked || catInfo(a.category).name.localeCompare(catInfo(b.category).name));
  doc.autoTable({
    startY: 32,
    head: [["Item", "Categoria", "Qtd", "Preço un.", "Total", "Pego"]],
    body: sorted.map((i) => [
      i.name,
      catInfo(i.category).name,
      formatQty(i),
      `${formatMoney(i.unitPrice)}/${unitLabel(i)}`,
      formatMoney(itemTotal(i)),
      i.checked ? "Sim" : "Não",
    ]),
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [23, 60, 54], textColor: 255 },
    alternateRowStyles: { fillColor: [246, 244, 236] },
  });

  const finalY = (doc.lastAutoTable ? doc.lastAutoTable.finalY : 32) + 10;
  doc.setFontSize(11);
  doc.setTextColor(30);
  doc.text(`Previsto: ${formatMoney(planned)}`, 14, finalY);
  doc.text(`Gasto: ${formatMoney(spent)}`, 14, finalY + 7);
  if (list.budget != null) {
    doc.setTextColor(list.budget - spent < 0 ? 193 : 60, list.budget - spent < 0 ? 80 : 130, list.budget - spent < 0 ? 46 : 100);
    doc.text(`Orçamento: ${formatMoney(list.budget)}  ·  Saldo: ${formatMoney(list.budget - spent)}`, 14, finalY + 14);
  }

  const safeName = list.name.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-");
  doc.save(`lista-${safeName || "compras"}.pdf`);
  showNotification("PDF gerado com sucesso!", "success");
}

// ---------------------------------------------------------------
// 7. Itens da lista (carrinho)
// ---------------------------------------------------------------
function openListDetail(listId) {
  currentListId = listId;
  showTab("listdetail");
  renderListDetail();
}

function toggleSortMode() {
  sortMode = sortMode === "category" ? "recent" : "category";
  const btn = document.getElementById("sort-toggle");
  btn.innerHTML = sortMode === "category"
    ? '<i class="fa-solid fa-arrow-down-a-z"></i> Categoria'
    : '<i class="fa-solid fa-clock-rotate-left"></i> Recentes';
  renderProducts();
}

async function toggleItemChecked(itemId) {
  const item = items.find((i) => i.id === itemId);
  item.checked = !item.checked;
  item.checkedDate = item.checked ? new Date().toISOString() : null;
  invalidateCaches();
  await dbPut(STORES.ITEMS, item);
  renderListDetail();
}

function confirmDeleteItem(itemId) {
  const item = items.find((i) => i.id === itemId);
  showConfirm("Remover item?", `"${item.name}" será removido da lista.`, "fa-trash-can", () => deleteItem(itemId));
}
async function deleteItem(itemId) {
  await dbDelete(STORES.ITEMS, itemId);
  await loadItems();
  await pruneOrphanProducts();
  showNotification("Item removido.", "success");
  renderListDetail();
}

// ---------------------------------------------------------------
// 8. Render — HOME
// ---------------------------------------------------------------
function renderHome() {
  const activeList = getActiveList();
  const card = document.getElementById("active-list-card");
  if (activeList) {
    card.hidden = false;
    const planned = plannedTotal(activeList.id);
    const spent = spentTotal(activeList.id);
    const { done, total } = checkedCount(activeList.id);
    const pct = planned > 0 ? Math.min((spent / planned) * 100, 100) : 0;
    document.getElementById("alc-name").textContent = activeList.name;
    document.getElementById("alc-spent").textContent = formatMoney(spent);
    document.getElementById("alc-items").textContent = `${done}/${total}`;
    document.getElementById("alc-ring-label").textContent = `${Math.round(pct)}%`;
    const circumference = 169.6;
    document.getElementById("alc-ring-fill").style.strokeDashoffset = String(circumference - (pct / 100) * circumference);

    const balanceEl = document.getElementById("alc-balance");
    const balanceLabel = document.getElementById("alc-balance-label");
    if (activeList.budget != null) {
      const saldo = activeList.budget - spent;
      balanceEl.textContent = formatMoney(saldo);
      balanceEl.style.color = saldo < 0 ? "var(--clay)" : "";
      balanceLabel.textContent = saldo < 0 ? "saldo (acima!)" : "saldo restante";
    } else {
      balanceEl.textContent = formatMoney(planned);
      balanceEl.style.color = "";
      balanceLabel.textContent = "previsto";
    }
  } else {
    card.hidden = true;
  }

  const completed = lists.filter((l) => l.status === "completed");
  const totalAll = lists.reduce((s, l) => s + spentTotal(l.id), 0);
  const avg = completed.length ? completed.reduce((s, l) => s + spentTotal(l.id), 0) / completed.length : 0;
  const savedTotal = completed.reduce((s, l) => {
    const eco = economyFor(l).value;
    return s + (eco || 0);
  }, 0);

  document.getElementById("kpi-lists").textContent = completed.length;
  document.getElementById("kpi-total").textContent = formatMoneyCompact(totalAll);
  document.getElementById("kpi-saved").textContent = formatMoneyCompact(savedTotal);
  document.getElementById("kpi-avg").textContent = formatMoneyCompact(avg);

  const recentBox = document.getElementById("recent-lists");
  const recent = sortedLists().slice(0, 3);
  recentBox.innerHTML = recent.length
    ? recent.map(listCardHTML).join("")
    : `<div class="empty-inline">Nenhuma lista ainda. Toque em <strong>+</strong> para criar a primeira.</div>`;
  attachListCardEvents(recentBox);

  renderCategoryBars("home-category-chart", aggregateCategoryTotals(lists.map((l) => l.id)));
}

function listCardHTML(list) {
  const planned = plannedTotal(list.id);
  const spent = spentTotal(list.id);
  const { done, total } = checkedCount(list.id);
  const isDone = list.status === "completed";
  let badge = `<span class="list-card-badge badge-active">Em andamento</span>`;
  if (isDone) {
    const over = list.budget != null && spent > list.budget;
    badge = `<span class="list-card-badge ${over ? "badge-over" : "badge-done"}">${over ? "Acima do orçamento" : "Concluída"}</span>`;
  }
  const dateLabel = isDone ? formatDate(list.completedDate) : formatDate(list.createdDate);
  return `
    <div class="list-card" data-id="${list.id}">
      <div class="list-card-icon ${isDone ? "done" : ""}"><i class="fa-solid ${isDone ? "fa-circle-check" : "fa-cart-shopping"}"></i></div>
      <div class="list-card-body">
        <p class="list-card-title">${escapeHTML(list.name)}</p>
        <div class="list-card-sub">
          <span>${dateLabel}</span><span class="list-card-dot"></span><span>${total} ${total === 1 ? "item" : "itens"}</span>
          ${!isDone ? `<span class="list-card-dot"></span><span>${done}/${total} no carrinho</span>` : ""}
        </div>
      </div>
      <div class="list-card-right">
        <div class="list-card-amount">${formatMoney(isDone ? spent : planned)}</div>
        ${badge}
      </div>
      <button class="list-card-menu" data-menu-id="${list.id}" aria-label="Mais opções da lista"><i class="fa-solid fa-ellipsis-vertical"></i></button>
    </div>`;
}

function attachListCardEvents(container) {
  container.querySelectorAll(".list-card").forEach((el) => {
    el.addEventListener("click", () => openListDetail(parseInt(el.dataset.id, 10)));
  });
  container.querySelectorAll(".list-card-menu").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openListActionsMenu(parseInt(el.dataset.menuId, 10));
    });
  });
}

function escapeHTML(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---------------------------------------------------------------
// 9. Render — LISTAS
// ---------------------------------------------------------------
function renderLists() {
  const container = document.getElementById("lists-container");
  let filtered = sortedLists();
  if (listFilter === "active") filtered = filtered.filter((l) => l.status === "active");
  if (listFilter === "completed") filtered = filtered.filter((l) => l.status === "completed");

  if (searchTerm) {
    filtered = filtered.filter((l) => {
      if (l.name.toLowerCase().includes(searchTerm)) return true;
      return itemsForList(l.id).some((i) => i.name.toLowerCase().includes(searchTerm) || (i.brand || "").toLowerCase().includes(searchTerm) || catInfo(i.category).name.toLowerCase().includes(searchTerm));
    });
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-basket-shopping"></i>
        <h3>Nenhuma lista encontrada</h3>
        <p>${searchTerm ? "Tente outro termo de busca." : "Crie uma nova lista para começar."}</p>
      </div>`;
    return;
  }
  container.innerHTML = filtered.map(listCardHTML).join("");
  attachListCardEvents(container);
}

// ---------------------------------------------------------------
// 10. Render — DETALHE DA LISTA (carrinho)
// ---------------------------------------------------------------
function renderListDetail() {
  const list = lists.find((l) => l.id === currentListId);
  if (!list) return;
  const isDone = list.status === "completed";

  document.getElementById("detail-name").textContent = list.name;
  document.getElementById("detail-meta").textContent = isDone
    ? `Concluída em ${formatDate(list.completedDate)}`
    : `Criada em ${formatDate(list.createdDate)}`;

  const planned = plannedTotal(list.id);
  const spent = spentTotal(list.id);
  const { done, total } = checkedCount(list.id);
  const pct = planned > 0 ? Math.min((spent / planned) * 100, 100) : 0;

  document.getElementById("dp-spent").textContent = formatMoney(spent);
  document.getElementById("dp-planned").textContent = formatMoney(planned);
  document.getElementById("dp-items").textContent = `${done} de ${total} itens no carrinho`;
  document.getElementById("dp-percent").textContent = planned > 0 ? `${Math.round(pct)}%` : "";
  const fill = document.getElementById("dp-fill");
  fill.style.width = `${pct}%`;
  fill.style.background = list.budget != null && spent > list.budget ? "var(--clay)" : "var(--sage)";

  const balanceEl = document.getElementById("dp-balance");
  const balanceLabel = document.getElementById("dp-balance-label");
  const balanceSub = document.getElementById("dp-balance-sub");
  if (list.budget != null) {
    const diff = list.budget - spent;
    balanceEl.textContent = formatMoney(diff);
    balanceEl.classList.toggle("over", diff < 0);
    balanceEl.classList.toggle("under", diff >= 0);
    balanceLabel.textContent = diff < 0 ? "Saldo (estourou!)" : "Saldo restante";
    balanceSub.textContent = `orçamento de ${formatMoney(list.budget)}`;
  } else {
    balanceEl.textContent = formatMoney(planned - spent);
    balanceEl.classList.remove("over", "under");
    balanceLabel.textContent = "Falta comprar";
    balanceSub.textContent = "defina um orçamento para ver alertas";
  }

  document.getElementById("add-product-btn").style.display = isDone ? "none" : "flex";
  const finishBtn = document.getElementById("finish-list-btn");
  finishBtn.classList.toggle("show", !isDone);
  document.getElementById("add-product-btn").classList.toggle("raised", !isDone);
  document.getElementById("products-container").style.marginBottom = isDone ? "24px" : "";

  renderProducts();
}

function renderProducts() {
  const list = lists.find((l) => l.id === currentListId);
  const isDone = list.status === "completed";
  const container = document.getElementById("products-container");
  const all = itemsForList(currentListId);
  document.getElementById("detail-count").textContent = `${all.length} ${all.length === 1 ? "item" : "itens"}`;

  if (all.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-basket-shopping"></i>
        <h3>Lista vazia</h3>
        <p>Adicione os produtos que você precisa comprar.</p>
      </div>`;
    return;
  }

  const pending = all.filter((i) => !i.checked);
  const picked = all.filter((i) => i.checked).sort((a, b) => new Date(b.checkedDate) - new Date(a.checkedDate));

  let html = "";
  if (pending.length === 0 && picked.length > 0) {
    html += `<div class="empty-inline" style="padding:20px 0 12px;">Tudo pego! Toque em <strong>Concluir compra</strong> para fechar a lista.</div>`;
  } else if (sortMode === "category") {
    const groups = {};
    pending.forEach((i) => { (groups[i.category] = groups[i.category] || []).push(i); });
    Object.keys(groups).sort((a, b) => catInfo(a).name.localeCompare(catInfo(b).name)).forEach((cat) => {
      html += `<div class="category-divider">${catInfo(cat).name} · ${groups[cat].length}</div>`;
      groups[cat]
        .sort((a, b) => new Date(b.addedDate) - new Date(a.addedDate))
        .forEach((item) => { html += itemRowHTML(item, isDone); });
    });
  } else {
    pending
      .sort((a, b) => new Date(b.addedDate) - new Date(a.addedDate))
      .forEach((item) => { html += itemRowHTML(item, isDone); });
  }

  if (picked.length > 0) {
    html += `<div class="category-divider"><i class="fa-solid fa-cart-shopping"></i> No carrinho · ${picked.length}</div>`;
    picked.forEach((item) => { html += itemRowHTML(item, isDone); });
  }

  container.innerHTML = html;
  attachProductEvents(isDone);
}

function itemRowHTML(item, readOnly) {
  const total = itemTotal(item);
  const cat = catInfo(item.category);
  const d = priceDelta(item);
  const badge = d && Math.abs(d.pct) >= 0.5
    ? `<span class="delta-badge ${d.pct > 0 ? "up" : "down"}" title="Última compra: ${formatMoney(d.ref.price)}">${d.pct > 0 ? "▲" : "▼"} ${formatPct(d.pct)}</span>`
    : "";
  const brand = item.brand ? `<span class="product-brand">${escapeHTML(item.brand)}</span>` : "";
  const code = item.productId != null && item.barcode ? `<i class="fa-solid fa-barcode item-code-ico" title="Código ${item.barcode}"></i>` : "";
  return `
    <div class="item-swipe" data-id="${item.id}">
      ${!readOnly ? `
      <div class="item-actions-under">
        <button class="item-action-edit" data-action="edit" data-id="${item.id}"><i class="fa-solid fa-pen"></i></button>
        <button class="item-action-delete" data-action="delete" data-id="${item.id}"><i class="fa-solid fa-trash"></i></button>
      </div>` : ""}
      <div class="product-item ${item.checked ? "checked" : ""}" data-id="${item.id}">
        <div class="check-circle" data-action="toggle" data-id="${item.id}"><i class="fa-solid fa-check"></i></div>
        <div class="product-item-body">
          <div class="product-name">${escapeHTML(item.name)}</div>
          <div class="product-details">
            ${brand}
            <span>${formatQty(item)} · ${formatMoney(item.unitPrice)}/${unitLabel(item)}</span>
            <span class="category-badge ${cat.cls}">${cat.name}</span>
            ${badge}${code}
          </div>
        </div>
        <div class="product-actions">
          <div class="product-price">${formatMoney(total)}</div>
        </div>
      </div>
    </div>`;
}

function attachProductEvents(readOnly) {
  if (readOnly) {
    document.querySelectorAll(".check-circle").forEach((el) => el.classList.add("check-circle-locked"));
    return;
  }
  document.querySelectorAll('[data-action="toggle"]').forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); toggleItemChecked(parseInt(el.dataset.id, 10)); });
  });

  document.querySelectorAll('[data-action="edit"]').forEach((el) => {
    el.addEventListener("click", () => openProductModal(parseInt(el.dataset.id, 10)));
  });
  document.querySelectorAll('[data-action="delete"]').forEach((el) => {
    el.addEventListener("click", () => confirmDeleteItem(parseInt(el.dataset.id, 10)));
  });

  // Swipe-to-reveal (pointer events cobrem touch + mouse).
  // Trava o eixo do gesto: só assume "arrastar" quando o movimento
  // horizontal supera o vertical — senão deixa a rolagem da página
  // acontecer normalmente e não faz nada no toque solto.
  document.querySelectorAll(".product-item").forEach((row) => {
    const wrap = row.parentElement;
    const hasActions = wrap.querySelector(".item-actions-under");
    if (!hasActions) return;
    const maxOpen = -124;
    let gesture = null;

    row.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".check-circle")) return;
      let suppressTap = false;
      if (openSwipeRow && openSwipeRow !== row) {
        openSwipeRow.style.transition = "";
        openSwipeRow.style.transform = "translateX(0)";
        openSwipeRow = null;
        suppressTap = true;
      }
      const baseOffset = openSwipeRow === row ? maxOpen : 0;
      gesture = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, axis: null, baseOffset, suppressTap, lastOffset: baseOffset };
    });

    row.addEventListener("pointermove", (e) => {
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      if (gesture.axis === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        gesture.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (gesture.axis === "x") {
          row.setPointerCapture(e.pointerId);
          row.style.transition = "none";
        } else {
          gesture = null; // gesto vertical: devolve o controle para o scroll nativo
          return;
        }
      }
      e.preventDefault();
      const offset = Math.max(maxOpen, Math.min(0, gesture.baseOffset + dx));
      row.style.transform = `translateX(${offset}px)`;
      gesture.lastOffset = offset;
    });

    const endGesture = (e) => {
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      if (gesture.axis === "x") {
        row.style.transition = "";
        if (gesture.lastOffset < maxOpen / 2) {
          row.style.transform = `translateX(${maxOpen}px)`;
          openSwipeRow = row;
        } else {
          row.style.transform = "translateX(0)";
          if (openSwipeRow === row) openSwipeRow = null;
        }
      } else if (gesture.axis === null) {
        // toque parado, sem arrasto
        if (openSwipeRow === row) {
          row.style.transform = "translateX(0)";
          openSwipeRow = null;
        } else if (!gesture.suppressTap) {
          openProductModal(parseInt(row.dataset.id, 10));
        }
      }
      gesture = null;
    };
    row.addEventListener("pointerup", endGesture);
    row.addEventListener("pointercancel", () => { gesture = null; });
  });
}

// ---------------------------------------------------------------
// 11. Render — COMPARATIVO (dados reais)
// ---------------------------------------------------------------
function listsInPeriod() {
  const done = completedListsSorted();
  if (comparePeriod === "all") return done;
  return done.filter((l) => daysAgo(l.completedDate) <= comparePeriod);
}

function renderCompare() {
  document.querySelectorAll("#compare-seg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.cview === compareView));
  ["lists", "spend", "prices"].forEach((v) => { document.getElementById("cview-" + v).hidden = v !== compareView; });
  if (compareView === "spend") { renderSpend(); return; }
  if (compareView === "prices") { renderPrices(); return; }

  const periodLists = listsInPeriod();
  renderCompareSummary(periodLists);
  renderEvolutionChart(periodLists);
  renderVsCard();
  renderCategoryBars("compare-category-chart", aggregateCategoryTotals(periodLists.map((l) => l.id)));
  renderCompareTable();
}

function renderCompareSummary(periodLists) {
  const box = document.getElementById("compare-summary");
  const totalSpent = periodLists.reduce((s, l) => s + spentTotal(l.id), 0);
  const avg = periodLists.length ? totalSpent / periodLists.length : 0;
  const economies = periodLists.map((l) => economyFor(l).value).filter((v) => v != null);
  const totalEco = economies.reduce((s, v) => s + v, 0);

  box.innerHTML = `
    <div class="cs-card">
      <span class="cs-label">GASTO NO PERÍODO</span>
      <span class="cs-value">${formatMoney(totalSpent)}</span>
      <span class="cs-sub">${periodLists.length} ${periodLists.length === 1 ? "lista" : "listas"}</span>
    </div>
    <div class="cs-card">
      <span class="cs-label">TICKET MÉDIO</span>
      <span class="cs-value">${formatMoney(avg)}</span>
      <span class="cs-sub">por lista concluída</span>
    </div>
    <div class="cs-card wide">
      <div>
        <span class="cs-label">ECONOMIA NO PERÍODO</span>
        <span class="cs-value ${totalEco >= 0 ? "positive" : "negative"}">${totalEco >= 0 ? "+" : "−"}${formatMoney(Math.abs(totalEco))}</span>
      </div>
      <i class="fa-solid ${totalEco >= 0 ? "fa-piggy-bank" : "fa-triangle-exclamation"}" style="font-size:26px;color:${totalEco >= 0 ? "var(--sage)" : "var(--clay)"}"></i>
    </div>`;
}

function renderEvolutionChart(periodLists) {
  const box = document.getElementById("evolution-chart");
  if (periodLists.length < 2) {
    box.innerHTML = `<div class="empty-inline">Conclua ao menos 2 listas no período para ver a evolução.</div>`;
    return;
  }
  const values = periodLists.map((l) => spentTotal(l.id));
  const max = Math.max(...values, 1);
  const min = 0;
  const W = 300, H = 130, PAD = 12;
  const stepX = (W - PAD * 2) / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - ((v - min) / (max - min || 1)) * (H - PAD * 2);
    return [x, y];
  });
  const pathD = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const areaD = `${pathD} L${pts[pts.length - 1][0]},${H - PAD} L${pts[0][0]},${H - PAD} Z`;

  const budgetPts = periodLists.map((l, i) => (l.budget != null ? [pts[i][0], H - PAD - ((l.budget - min) / (max - min || 1)) * (H - PAD * 2)] : null)).filter(Boolean);
  const budgetPath = budgetPts.length > 1 ? budgetPts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ") : null;

  const circles = pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.2" fill="#173C36" stroke="#fff" stroke-width="1.4"/>`).join("");
  const labels = periodLists.map((l, i) => `<text x="${pts[i][0]}" y="${H - 1}" font-size="7" text-anchor="middle" fill="#7C877F">${formatDateShort(l.completedDate)}</text>`).join("");

  box.innerHTML = `
    <div class="evo-svg-wrap">
      <svg viewBox="0 0 ${W} ${H + 8}" style="width:100%;height:auto;display:block;">
        <defs>
          <linearGradient id="evoGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#173C36" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="#173C36" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${areaD}" fill="url(#evoGrad)" stroke="none"/>
        ${budgetPath ? `<path d="${budgetPath}" fill="none" stroke="#E0A458" stroke-width="1.6" stroke-dasharray="3,3"/>` : ""}
        <path d="${pathD}" fill="none" stroke="#173C36" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
        ${circles}
        ${labels}
      </svg>
    </div>
    <div class="evo-legend">
      <span><i class="evo-dot" style="background:#173C36"></i> Gasto real</span>
      ${budgetPath ? '<span><i class="evo-dot" style="background:#E0A458"></i> Orçamento previsto</span>' : ""}
    </div>`;
}

function renderVsCard() {
  const box = document.getElementById("vs-card");
  const done = completedListsSorted();
  if (done.length < 2) {
    box.innerHTML = `<div class="empty-inline">Conclua ao menos 2 listas para comparar.</div>`;
    return;
  }
  const curr = done[done.length - 1];
  const prev = done[done.length - 2];
  const currSpent = spentTotal(curr.id);
  const prevSpent = spentTotal(prev.id);
  const delta = currSpent - prevSpent;
  const pctDelta = prevSpent > 0 ? (delta / prevSpent) * 100 : 0;

  box.innerHTML = `
    <div class="vs-row">
      <div class="vs-col">
        <span class="vs-col-label">${escapeHTML(prev.name)}</span>
        <span class="vs-col-value">${formatMoney(prevSpent)}</span>
      </div>
      <div class="vs-arrow"><i class="fa-solid fa-arrow-right"></i></div>
      <div class="vs-col">
        <span class="vs-col-label">${escapeHTML(curr.name)}</span>
        <span class="vs-col-value">${formatMoney(currSpent)}</span>
      </div>
    </div>
    <div class="vs-delta ${delta <= 0 ? "positive" : "negative"}">
      ${delta <= 0 ? "Você gastou" : "Você gastou"} ${formatMoney(Math.abs(delta))} ${delta <= 0 ? "a menos" : "a mais"}
      ${prevSpent > 0 ? `(${delta <= 0 ? "-" : "+"}${Math.abs(pctDelta).toFixed(1)}%)` : ""}
    </div>`;
}

function aggregateCategoryTotals(listIds) {
  const totals = {};
  Object.keys(CATEGORIES).forEach((c) => (totals[c] = 0));
  listIds.forEach((id) => {
    itemsForList(id).filter((i) => i.checked).forEach((i) => {
      const c = totals[i.category] !== undefined ? i.category : "other";
      totals[c] += itemTotal(i);
    });
  });
  return totals;
}

function renderCategoryBars(containerId, totals, showPct = false) {
  const box = document.getElementById(containerId);
  const entries = Object.entries(totals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    box.innerHTML = `<div class="empty-inline">Nenhum gasto registrado ainda.</div>`;
    return;
  }
  const max = Math.max(...entries.map(([, v]) => v));
  const sum = entries.reduce((s, [, v]) => s + v, 0);
  box.innerHTML = entries.map(([cat, v]) => {
    const info = catInfo(cat);
    const pct = (v / max) * 100;
    return `
      <div class="cat-bar-row">
        <div class="cat-bar-top"><span>${info.name}</span><strong>${formatMoney(v)}${showPct && sum > 0 ? ` <em class="cat-pct">${formatPct((v / sum) * 100)}</em>` : ""}</strong></div>
        <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%;background:${info.color}"></div></div>
      </div>`;
  }).join("");
}

function renderCompareTable() {
  const tbody = document.getElementById("compare-table-body");
  const all = sortedLists();
  if (all.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px 0;">Nenhuma lista criada ainda.</td></tr>`;
    return;
  }
  tbody.innerHTML = all.map((l) => {
    const planned = plannedTotal(l.id);
    const spent = spentTotal(l.id);
    const { done, total } = checkedCount(l.id);
    const isDone = l.status === "completed";
    const eco = isDone ? economyFor(l).value : null;
    let ecoCell = "—";
    if (eco != null) {
      ecoCell = `<span class="${eco >= 0 ? "eco-pos" : "eco-neg"}">${eco >= 0 ? "+" : "−"}${formatMoney(Math.abs(eco))}</span>`;
    }
    return `
      <tr>
        <td>${escapeHTML(l.name)}</td>
        <td>${isDone ? formatDate(l.completedDate) : "Em andamento"}</td>
        <td class="num">${done}/${total}</td>
        <td class="num">${formatMoney(planned)}</td>
        <td class="num">${formatMoney(spent)}</td>
        <td class="num">${ecoCell}</td>
      </tr>`;
  }).join("");
}

// ---------------------------------------------------------------
// 12. Exportar / importar / limpar
// ---------------------------------------------------------------
function exportReport() {
  if (lists.length === 0) { showNotification("Nenhuma lista para exportar.", "error"); return; }
  const done = completedListsSorted();
  const totalSpentAll = lists.reduce((s, l) => s + spentTotal(l.id), 0);
  const catTotals = aggregateCategoryTotals(lists.map((l) => l.id));

  let rows = "";
  sortedLists().forEach((l) => {
    const planned = plannedTotal(l.id);
    const spent = spentTotal(l.id);
    rows += `<tr><td>${escapeHTML(l.name)}</td><td>${l.status === "completed" ? formatDate(l.completedDate) : "Em andamento"}</td><td>${itemsForList(l.id).length}</td><td>R$ ${planned.toFixed(2)}</td><td>R$ ${spent.toFixed(2)}</td></tr>`;
  });

  let catRows = "";
  Object.entries(catTotals).filter(([, v]) => v > 0).forEach(([c, v]) => {
    catRows += `<tr><td>${catInfo(c).name}</td><td>R$ ${v.toFixed(2)}</td></tr>`;
  });

  const monthTotals = new Map();
  getPurchases().forEach((pc) => {
    const k = pc.date.getFullYear() + "-" + String(pc.date.getMonth() + 1).padStart(2, "0");
    monthTotals.set(k, (monthTotals.get(k) || 0) + pc.total);
  });
  const monthRows = [...monthTotals.entries()].sort().map(([k, v]) => `<tr><td>${k.slice(5)}/${k.slice(0, 4)}</td><td>R$ ${v.toFixed(2)}</td></tr>`).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Relatório ShopSmart</title>
    <style>body{font-family:Arial,sans-serif;padding:24px;color:#1B2420}h1{color:#173C36}
    table{width:100%;border-collapse:collapse;margin:16px 0}th,td{padding:9px;text-align:left;border-bottom:1px solid #ddd;font-size:13px}
    th{background:#F6F4EC}.total{font-weight:bold}</style></head><body>
    <h1>Relatório de Compras — ShopSmart</h1>
    <p>Gerado em ${formatDate(new Date().toISOString())}</p>
    <p><strong>Listas concluídas:</strong> ${done.length} &nbsp; <strong>Total gasto (todas as listas):</strong> R$ ${totalSpentAll.toFixed(2)}</p>
    <h2>Listas</h2>
    <table><tr><th>Lista</th><th>Status/Data</th><th>Itens</th><th>Previsto</th><th>Gasto</th></tr>${rows}</table>
    <h2>Gasto por categoria</h2>
    <table><tr><th>Categoria</th><th>Total</th></tr>${catRows}</table>
    <h2>Gasto por mês</h2>
    <table><tr><th>Mês</th><th>Total</th></tr>${monthRows}</table>
    </body></html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `relatorio-shopsmart-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showNotification("Relatório exportado!", "success");
}

function exportBackup() {
  const payload = { version: 3, exportedAt: new Date().toISOString(), lists, items, products };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `backup-shopsmart-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showNotification("Backup exportado!", "success");
}

function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const data = JSON.parse(evt.target.result);
      if (!Array.isArray(data.lists) || !Array.isArray(data.items)) throw new Error("formato inválido");
      showConfirm("Importar backup?", "Isso vai substituir todos os dados atuais pelos dados do arquivo.", "fa-upload", async () => {
        await dbClear(STORES.LISTS);
        await dbClear(STORES.ITEMS);
        await dbClear(STORES.PRODUCTS);
        for (const l of data.lists) { const { id, ...rest } = l; await dbPut(STORES.LISTS, l.id ? l : rest); }
        for (const i of data.items) { const { id, ...rest } = i; await dbPut(STORES.ITEMS, i.id ? i : rest); }
        // backups antigos (v2) não têm catálogo: ficam sem produtos e os itens sem productId
        for (const pr of (Array.isArray(data.products) ? data.products : [])) { const { id, ...rest } = pr; await dbPut(STORES.PRODUCTS, pr.id ? pr : rest); }
        await loadLists();
        await loadItems();
        await loadProducts();
        showNotification("Backup importado com sucesso!", "success");
        showTab("home");
      });
    } catch (err) {
      console.error(err);
      showNotification("Arquivo inválido.", "error");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
}

function confirmClearAll() {
  showConfirm("Apagar todos os dados?", "Todas as listas, itens e histórico serão apagados permanentemente. Esta ação não pode ser desfeita.", "fa-trash-can", clearAllData);
}
async function clearAllData() {
  await dbClear(STORES.LISTS);
  await dbClear(STORES.ITEMS);
  await dbClear(STORES.PRODUCTS);
  lists = []; items = []; products = [];
  invalidateCaches();
  showNotification("Todos os dados foram apagados.", "success");
  showTab("home");
}

// ---------------------------------------------------------------
// 13. Notificações (toast)
// ---------------------------------------------------------------
function showNotification(message, type = "success") {
  const notification = document.getElementById("notification");
  const text = document.getElementById("notification-text");
  const icon = notification.querySelector("i");

  if (notification._hideTimeout) clearTimeout(notification._hideTimeout);

  text.textContent = message;
  notification.className = "notification";
  notification.classList.add(`notification-${type}`);
  icon.className = type === "success" ? "fas fa-check-circle" : type === "error" ? "fas fa-circle-exclamation" : "fas fa-circle-info";

  notification.classList.remove("show");
  void notification.offsetWidth;
  requestAnimationFrame(() => notification.classList.add("show"));

  notification._hideTimeout = setTimeout(() => notification.classList.remove("show"), 3000);
}

// ---------------------------------------------------------------
// 14. PWA — service worker e instalação
// ---------------------------------------------------------------
let deferredInstallPrompt = null;
const INSTALL_DISMISS_KEY = "shopsmart_install_dismissed_at";
const DISMISS_DAYS = 7;

function isRunningInstalled() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker não registrado:", err));
  });
}

function setupInstallPrompt() {
  if (isRunningInstalled()) return;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById("install-app-btn").hidden = false;

    const dismissedAt = localStorage.getItem(INSTALL_DISMISS_KEY);
    const recentlyDismissed = dismissedAt && Date.now() - parseInt(dismissedAt, 10) < DISMISS_DAYS * 86400000;
    if (!recentlyDismissed) document.getElementById("install-banner").hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    document.getElementById("install-banner").hidden = true;
    document.getElementById("install-app-btn").hidden = true;
    showNotification("Aplicativo instalado com sucesso!", "success");
  });

  const triggerInstall = async () => {
    if (!deferredInstallPrompt) {
      showNotification("Seu navegador ainda não liberou a instalação. Tente novamente em instantes.", "info");
      return;
    }
    document.getElementById("install-banner").hidden = true;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome !== "accepted") {
      showNotification("Sem problema — você pode instalar depois em Mais.", "info");
    }
    deferredInstallPrompt = null;
  };

  document.getElementById("install-banner-btn").addEventListener("click", triggerInstall);
  document.getElementById("install-app-btn").addEventListener("click", triggerInstall);
  document.getElementById("install-banner-close").addEventListener("click", () => {
    document.getElementById("install-banner").hidden = true;
    localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  });
}

// ===============================================================
// 15. v2.1 — Item por peso, catálogo de produtos e histórico de preço
// ===============================================================
// Modelo de dados:
//   product  = { id, name, brand, barcode|null, unitType: "un"|"kg", category, createdDate }
//   item     = { ..., unitType, brand, barcode, productId|null }
//   - productId é o "ID do produto" usado nas comparações de preço.
//   - O código de barras é a chave mais precisa. Sem código, o produto é
//     identificado por nome + marca + tipo (un/kg), normalizados.
//   - productId = null  -> item fora das comparações de preço (mas continua
//     contando nas análises de gasto por período/categoria).
// ---------------------------------------------------------------

let _purchCache = null;
let _priceIdx = null;
function invalidateCaches() { _purchCache = null; _priceIdx = null; }

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function formatPct(n) { return Math.abs(n).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%"; }
function formatDateFull(ts) { return new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }); }

function normText(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
// Normaliza para só dígitos; UPC-A (12) vira EAN-13 (13) para o mesmo produto não ficar duplicado.
function canonBarcode(s) {
  let c = String(s || "").replace(/\D/g, "");
  if (c.length === 12) c = "0" + c;
  return c;
}
// Valida o dígito verificador GTIN (EAN-8 / EAN-13 / GTIN-14).
function isValidGTIN(code) {
  if (!/^(\d{8}|\d{13}|\d{14})$/.test(code)) return false;
  const d = code.split("").map(Number);
  const check = d.pop();
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}
function productKey(name, brand) { return normText(name) + "|" + normText(brand); }

// ---------- Compras (itens marcados no carrinho) ----------
function getPurchases() {
  if (_purchCache) return _purchCache;
  const listMap = new Map(lists.map((l) => [l.id, l]));
  _purchCache = items
    .filter((i) => i.checked)
    .map((i) => {
      const l = listMap.get(i.listId);
      const iso = i.checkedDate || (l && (l.completedDate || l.createdDate)) || i.addedDate;
      const ts = new Date(iso).getTime();
      return { item: i, ts, date: new Date(ts), total: itemTotal(i), price: Number(i.unitPrice) || 0, list: l };
    })
    .filter((p) => !isNaN(p.ts))
    .sort((a, b) => a.ts - b.ts);
  return _purchCache;
}
function getPriceIndex() {
  if (_priceIdx) return _priceIdx;
  _priceIdx = new Map();
  getPurchases().forEach((p) => {
    if (p.item.productId == null || !(p.price > 0)) return;
    if (!_priceIdx.has(p.item.productId)) _priceIdx.set(p.item.productId, []);
    _priceIdx.get(p.item.productId).push(p);
  });
  return _priceIdx;
}
function purchasesOfProduct(pid, excludeItemId = null) {
  const arr = getPriceIndex().get(pid) || [];
  return excludeItemId == null ? arr : arr.filter((p) => p.item.id !== excludeItemId);
}
// Variação do preço deste item vs. a compra anterior do MESMO produto.
function priceDelta(item) {
  if (item.productId == null || !(item.unitPrice > 0)) return null;
  const hist = purchasesOfProduct(item.productId, item.id);
  if (!hist.length) return null;
  let ref;
  if (item.checked) {
    const own = (getPriceIndex().get(item.productId) || []).find((p) => p.item.id === item.id);
    const before = own ? hist.filter((p) => p.ts <= own.ts) : hist;
    ref = before[before.length - 1];
  } else {
    ref = hist[hist.length - 1];
  }
  if (!ref || !(ref.price > 0)) return null;
  return { pct: ((item.unitPrice - ref.price) / ref.price) * 100, ref };
}

// ---------- Catálogo ----------
function productLastUseMap() {
  const m = new Map();
  items.forEach((i) => {
    if (i.productId == null) return;
    const t = new Date(i.checkedDate || i.addedDate).getTime() || 0;
    if (t > (m.get(i.productId) || 0)) m.set(i.productId, t);
  });
  return m;
}
function mostRecentlyUsed(cands) {
  if (cands.length <= 1) return cands[0] || null;
  const last = productLastUseMap();
  return [...cands].sort((a, b) => (last.get(b.id) || 0) - (last.get(a.id) || 0))[0];
}
// Encontra o produto do catálogo (sem criar nada).
function matchProduct(spec) {
  if (spec.barcode) {
    const byCode = products.find((p) => p.barcode === spec.barcode);
    if (byCode) return byCode;
    // código novo + produto já cadastrado só por nome: o código será "adotado" por ele
    const key = productKey(spec.name, spec.brand);
    return mostRecentlyUsed(products.filter((p) => !p.barcode && p.unitType === spec.unitType && productKey(p.name, p.brand) === key));
  }
  const key = productKey(spec.name, spec.brand);
  return mostRecentlyUsed(products.filter((p) => p.unitType === spec.unitType && productKey(p.name, p.brand) === key));
}
async function resolveProduct(spec) {
  const found = matchProduct(spec);
  if (found) {
    if (found.unitType !== spec.unitType) {
      return { error: `Esse código já está cadastrado como produto ${found.unitType === "kg" ? "por peso (kg)" : "por unidade"}. Ajuste o tipo do item.` };
    }
    if (spec.barcode && !found.barcode) {
      found.barcode = spec.barcode;
      await dbPut(STORES.PRODUCTS, found);
    }
    return { product: found };
  }
  const np = {
    name: spec.name, brand: spec.brand, barcode: spec.barcode || null,
    unitType: spec.unitType, category: spec.category, createdDate: new Date().toISOString(),
  };
  np.id = await dbPut(STORES.PRODUCTS, np);
  products.push(np);
  return { product: np };
}
async function pruneOrphanProducts() {
  const used = new Set(items.map((i) => i.productId).filter((v) => v != null));
  const orphans = products.filter((p) => !used.has(p.id));
  for (const p of orphans) await dbDelete(STORES.PRODUCTS, p.id);
  if (orphans.length) await loadProducts();
}

// ===============================================================
// 16. Formulário do item (peso, sugestões, dica de preço)
// ===============================================================
let pickedProduct = null; // produto escolhido na lista de sugestões

function setUnit(unit) {
  const kg = unit === "kg";
  document.getElementById("product-unit").value = kg ? "kg" : "un";
  document.querySelectorAll("#unit-toggle .unit-btn").forEach((b) => b.classList.toggle("active", b.dataset.unit === (kg ? "kg" : "un")));
  const qty = document.getElementById("product-quantity");
  if (kg) {
    qty.step = "any"; qty.min = "0.001"; qty.setAttribute("inputmode", "decimal"); qty.placeholder = "Ex: 0,750";
  } else {
    qty.step = "1"; qty.min = "1"; qty.setAttribute("inputmode", "numeric"); qty.placeholder = "";
    const v = parseFloat(qty.value);
    if (!Number.isInteger(v) || v < 1) qty.value = 1;
  }
  document.getElementById("qty-label").textContent = kg ? "Peso (kg)" : "Quantidade";
  document.getElementById("price-label").textContent = kg ? "Preço por kg (R$)" : "Preço unit. (R$)";
  updateScaleDisplay();
  updatePriceHint();
}

// "Visor de balança": preço/kg × peso = total, em tempo real.
function updateScaleDisplay() {
  const kg = document.getElementById("product-unit").value === "kg";
  const q = parseFloat(document.getElementById("product-quantity").value) || 0;
  const p = parseFloat(document.getElementById("product-price").value) || 0;
  document.getElementById("sc-price-label").textContent = kg ? "Preço/kg" : "Preço/un";
  document.getElementById("sc-price").textContent = formatMoney(p);
  document.getElementById("sc-qty-label").textContent = kg ? "Peso" : "Qtd";
  document.getElementById("sc-qty").textContent = kg
    ? q.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + " kg"
    : String(q);
  document.getElementById("sc-total").textContent = formatMoney(lineTotal(q, p));
}

function readProductSpec() {
  return {
    name: document.getElementById("product-name").value.trim(),
    brand: document.getElementById("product-brand").value.trim(),
    barcode: canonBarcode(document.getElementById("product-barcode").value),
    unitType: document.getElementById("product-unit").value === "kg" ? "kg" : "un",
    category: document.getElementById("product-category").value,
    track: document.getElementById("track-check").checked,
  };
}

function syncTrackFields() {
  const on = document.getElementById("track-check").checked;
  document.getElementById("track-fields").hidden = !on;
}

function hideSuggest() {
  const box = document.getElementById("name-suggest");
  if (box) { box.hidden = true; box.innerHTML = ""; }
}
function renderNameSuggestions() {
  const box = document.getElementById("name-suggest");
  const q = normText(document.getElementById("product-name").value);
  if (q.length < 2 || !document.getElementById("track-check").checked) { hideSuggest(); return; }
  const last = productLastUseMap();
  const found = products
    .filter((p) => normText(p.name + " " + (p.brand || "")).includes(q))
    .sort((a, b) => (last.get(b.id) || 0) - (last.get(a.id) || 0))
    .slice(0, 5);
  if (!found.length) { hideSuggest(); return; }
  box.innerHTML = found.map((p) => `
    <button type="button" class="suggest-item" data-pid="${p.id}">
      <strong>${escapeHTML(p.name)}</strong>
      <small>${p.brand ? escapeHTML(p.brand) + " · " : ""}${p.unitType === "kg" ? "por kg" : "por unidade"}${p.barcode ? " · " + p.barcode : ""}</small>
    </button>`).join("");
  box.hidden = false;
  box.querySelectorAll(".suggest-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const prod = products.find((x) => x.id === parseInt(btn.dataset.pid, 10));
      if (prod) applyProductToForm(prod, true);
    });
  });
}

// Preenche o formulário com um produto do catálogo.
function applyProductToForm(prod, overrideName) {
  const nameEl = document.getElementById("product-name");
  if (overrideName || !nameEl.value.trim()) nameEl.value = prod.name;
  document.getElementById("product-brand").value = prod.brand || "";
  document.getElementById("product-barcode").value = prod.barcode || "";
  if (document.getElementById("product-category").querySelector(`option[value="${prod.category}"]`)) {
    document.getElementById("product-category").value = prod.category;
  }
  pickedProduct = prod;
  setUnit(prod.unitType);
  hideSuggest();
}

// Se o usuário trocar nome/marca depois de escolher uma sugestão, o código
// herdado dela não vale mais (senão o item seria ligado ao produto errado).
function dropInheritedBarcodeIfRenamed() {
  if (!pickedProduct) return;
  const spec = readProductSpec();
  if (productKey(spec.name, spec.brand) !== productKey(pickedProduct.name, pickedProduct.brand)) {
    if (pickedProduct.barcode && spec.barcode === pickedProduct.barcode) {
      document.getElementById("product-barcode").value = "";
    }
    pickedProduct = null;
  }
}

function updatePriceHint() {
  const box = document.getElementById("price-hint");
  if (!box) return;
  const spec = readProductSpec();
  if (!spec.track || spec.name.length < 2) { box.hidden = true; return; }

  const editingId = parseInt(document.getElementById("product-id").value, 10) || null;
  const u = spec.unitType;
  const price = parseFloat(document.getElementById("product-price").value);
  let html = "", cls = "";

  if (spec.barcode && !isValidGTIN(spec.barcode)) {
    html = `<i class="fa-solid fa-triangle-exclamation"></i> Código de barras inválido: confira os dígitos (EAN-13 tem 13 números).`;
    cls = "warn";
  } else {
    const prod = matchProduct(spec);
    if (!prod) {
      html = `<i class="fa-solid fa-circle-info"></i> Produto novo: ainda sem histórico de preço.`;
    } else if (prod.unitType !== u) {
      html = `<i class="fa-solid fa-triangle-exclamation"></i> Esse produto está cadastrado ${prod.unitType === "kg" ? "por peso (kg)" : "por unidade"}.`;
      cls = "warn";
    } else {
      const hist = purchasesOfProduct(prod.id, editingId);
      const nameDiffers = spec.barcode && prod.barcode === spec.barcode && normText(prod.name) !== normText(spec.name);
      if (!hist.length) {
        html = `<i class="fa-solid fa-circle-info"></i> Produto já cadastrado, sem compras registradas ainda.`;
      } else {
        const last = hist[hist.length - 1];
        const min = hist.reduce((m, p) => (p.price < m.price ? p : m), hist[0]);
        let cmp = "";
        if (price > 0) {
          const pct = ((price - last.price) / last.price) * 100;
          if (Math.abs(pct) >= 0.5) {
            cls = pct > 0 ? "up" : "down";
            cmp = `<br><strong>${pct > 0 ? "▲" : "▼"} ${formatPct(pct)} ${pct > 0 ? "mais caro" : "mais barato"}</strong> que na última compra.`;
          } else {
            cmp = `<br>Mesmo preço da última compra.`;
          }
        }
        html = `<i class="fa-solid fa-clock-rotate-left"></i> Última: <strong>${formatMoney(last.price)}/${u}</strong> em ${formatDateShort(last.ts)} · menor já pago: <strong>${formatMoney(min.price)}/${u}</strong>${cmp}`;
      }
      if (nameDiffers) html += `<br><i class="fa-solid fa-barcode"></i> Este código está cadastrado como <strong>${escapeHTML(prod.name)}</strong>.`;
    }
  }
  box.className = "price-hint" + (cls ? " " + cls : "");
  box.innerHTML = html;
  box.hidden = false;
}

function onBarcodeInput() {
  const el = document.getElementById("product-barcode");
  const clean = el.value.replace(/\D/g, "");
  if (el.value !== clean) el.value = clean;
  const code = canonBarcode(clean);
  if (code && isValidGTIN(code)) {
    const prod = products.find((p) => p.barcode === code);
    if (prod) applyProductToForm(prod, false);
  }
  updatePriceHint();
}

function onScanResult(code) {
  document.getElementById("track-check").checked = true;
  syncTrackFields();
  document.getElementById("product-barcode").value = code;
  const prod = products.find((p) => p.barcode === code);
  if (prod) {
    applyProductToForm(prod, false);
    showNotification(`Reconhecido: ${prod.name}`, "success");
  } else {
    pickedProduct = null;
    showNotification("Código lido. Produto novo: preencha o nome.", "info");
    if (!document.getElementById("product-name").value.trim()) document.getElementById("product-name").focus();
  }
  updatePriceHint();
}

function setupProductFormEvents() {
  document.querySelectorAll("#unit-toggle .unit-btn").forEach((b) => b.addEventListener("click", () => setUnit(b.dataset.unit)));
  ["product-quantity", "product-price"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => { updateScaleDisplay(); updatePriceHint(); });
  });
  document.getElementById("product-name").addEventListener("input", () => {
    dropInheritedBarcodeIfRenamed();
    renderNameSuggestions();
    updatePriceHint();
  });
  document.getElementById("product-brand").addEventListener("input", () => {
    dropInheritedBarcodeIfRenamed();
    updatePriceHint();
  });
  document.getElementById("product-barcode").addEventListener("input", onBarcodeInput);
  document.getElementById("track-check").addEventListener("change", () => {
    syncTrackFields();
    if (!document.getElementById("track-check").checked) hideSuggest();
    updatePriceHint();
  });
  document.getElementById("scan-btn").addEventListener("click", () => openScanner(onScanResult));
  document.addEventListener("click", (e) => { if (!e.target.closest(".suggest-wrap")) hideSuggest(); });
}

function openProductModal(productId = null) {
  const form = document.getElementById("product-form");
  form.reset();
  hideSuggest();
  pickedProduct = null;
  if (productId) {
    const item = items.find((i) => i.id === productId);
    const prod = item.productId != null ? products.find((p) => p.id === item.productId) : null;
    document.getElementById("modal-title").textContent = "Editar item";
    document.getElementById("product-id").value = item.id;
    document.getElementById("product-name").value = item.name;
    document.getElementById("product-brand").value = item.brand || (prod && prod.brand) || "";
    setUnit(item.unitType === "kg" ? "kg" : "un");
    document.getElementById("product-quantity").value = item.quantity;
    document.getElementById("product-price").value = item.unitPrice;
    document.getElementById("product-category").value = item.category;
    // itens antigos (productId indefinido) entram como "acompanhar" por padrão
    document.getElementById("track-check").checked = item.productId !== null;
    document.getElementById("product-barcode").value = item.barcode || (prod && prod.barcode) || "";
  } else {
    document.getElementById("modal-title").textContent = "Adicionar item";
    document.getElementById("product-id").value = "";
    document.getElementById("product-quantity").value = 1;
    document.getElementById("track-check").checked = true;
    setUnit("un");
  }
  syncTrackFields();
  updateScaleDisplay();
  updatePriceHint();
  openModal("product-modal");
}

async function handleProductSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("product-id").value;
  const spec = readProductSpec();
  const kg = spec.unitType === "kg";
  const rawQty = parseFloat(document.getElementById("product-quantity").value);
  const unitPrice = parseFloat(document.getElementById("product-price").value);
  const quantity = kg ? Math.round(rawQty * 1000) / 1000 : rawQty;

  if (spec.name.length < 2) { showNotification("Digite um nome válido.", "error"); return; }
  if (isNaN(quantity) || quantity <= 0) { showNotification(kg ? "Peso inválido." : "Quantidade inválida.", "error"); return; }
  if (!kg && !Number.isInteger(quantity)) { showNotification("A quantidade por unidade deve ser um número inteiro. Para pesar, use \"Por peso (kg)\".", "error"); return; }
  if (isNaN(unitPrice) || unitPrice < 0) { showNotification("Preço inválido.", "error"); return; }
  if (spec.track && spec.barcode && !isValidGTIN(spec.barcode)) {
    showNotification("Código de barras inválido. Corrija ou apague o campo.", "error");
    return;
  }

  try {
    let productId = null;
    if (spec.track) {
      const res = await resolveProduct(spec);
      if (res.error) { showNotification(res.error, "error"); return; }
      productId = res.product.id;
    }
    const fields = {
      name: spec.name, quantity, unitPrice, category: spec.category,
      unitType: spec.unitType, brand: spec.brand,
      barcode: spec.track && spec.barcode ? spec.barcode : null,
      productId,
    };
    if (id) {
      const item = items.find((i) => i.id === parseInt(id, 10));
      Object.assign(item, fields);
      await dbPut(STORES.ITEMS, item);
      showNotification("Item atualizado.", "success");
    } else {
      const newItem = {
        listId: currentListId, ...fields,
        checked: false, checkedDate: null, addedDate: new Date().toISOString(),
      };
      const newId = await dbPut(STORES.ITEMS, newItem);
      newItem.id = newId;
      items.push(newItem);
      showNotification("Item adicionado à lista.", "success");
    }
    await loadItems();
    await pruneOrphanProducts();
    closeModal("product-modal");
    renderListDetail();
  } catch (err) {
    console.error(err);
    showNotification("Erro ao salvar o item.", "error");
  }
}

// ===============================================================
// 17. Análise de gastos (semana / mês / ano)
// ===============================================================
const MONTHS_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const GRAN_INFO = {
  week: { prev: "semana anterior", avg: "MÉDIA POR SEMANA", evo: "semanal" },
  month: { prev: "mês anterior", avg: "MÉDIA POR MÊS", evo: "mensal" },
  year: { prev: "ano anterior", avg: "MÉDIA POR ANO", evo: "anual" },
};

function periodStart(d, g) {
  if (g === "week") {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // semana começa na segunda
    return x;
  }
  if (g === "month") return new Date(d.getFullYear(), d.getMonth(), 1);
  return new Date(d.getFullYear(), 0, 1);
}
function shiftPeriod(start, g, n) {
  if (g === "week") return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * n);
  if (g === "month") return new Date(start.getFullYear(), start.getMonth() + n, 1);
  return new Date(start.getFullYear() + n, 0, 1);
}
function periodShortLabel(start, g) {
  if (g === "week") return formatDateShort(start.toISOString());
  if (g === "month") return `${MONTHS_SHORT[start.getMonth()]}/${String(start.getFullYear()).slice(2)}`;
  return String(start.getFullYear());
}
function periodLongLabel(start, g) {
  if (g === "week") {
    const end = shiftPeriod(start, "week", 1); end.setDate(end.getDate() - 1);
    return `Semana de ${formatDateShort(start.toISOString())} a ${formatDateShort(end.toISOString())}`;
  }
  if (g === "month") return start.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return String(start.getFullYear());
}
function catTotalsOf(arr) {
  const t = {};
  Object.keys(CATEGORIES).forEach((c) => (t[c] = 0));
  arr.forEach((p) => {
    const c = t[p.item.category] !== undefined ? p.item.category : "other";
    t[c] += p.total;
  });
  Object.keys(t).forEach((c) => (t[c] = round2(t[c])));
  return t;
}
function topProducts(arr, limit = 5) {
  const prodMap = new Map(products.map((p) => [p.id, p]));
  const groups = new Map();
  arr.forEach((p) => {
    const it = p.item;
    const pr = it.productId != null ? prodMap.get(it.productId) : null;
    const key = pr ? "p" + pr.id : "n:" + normText(it.name);
    if (!groups.has(key)) groups.set(key, { name: pr ? pr.name : it.name, brand: pr ? pr.brand : it.brand || "", total: 0, count: 0, kg: 0, allKg: true });
    const g = groups.get(key);
    g.total += p.total; g.count++;
    if (isKg(it)) g.kg += Number(it.quantity) || 0; else g.allKg = false;
  });
  return [...groups.values()].map((g) => ({ ...g, total: round2(g.total) })).sort((a, b) => b.total - a.total).slice(0, limit);
}
function chartMoney(v) {
  return v >= 1000 ? "R$" + (v / 1000).toFixed(1).replace(".", ",") + "k" : "R$" + Math.round(v);
}

function spendBarsSVG(buckets, selTs, g) {
  const W = 320, H = 150, PADL = 6, PADB = 18, PADT = 18;
  const n = buckets.length;
  const slot = (W - PADL * 2) / n;
  const bw = Math.min(slot * 0.62, 26);
  const max = Math.max(...buckets.map((b) => b.total), 1);
  const chartH = H - PADB - PADT;
  const bars = buckets.map((b, i) => {
    const sel = b.start === selTs;
    const x = PADL + i * slot + (slot - bw) / 2;
    const h = b.total > 0 ? Math.max((b.total / max) * chartH, 2) : 0;
    const y = H - PADB - h;
    const cx = x + bw / 2;
    const label = periodShortLabel(new Date(b.start), g);
    const val = sel ? `<text x="${Math.min(Math.max(cx, 24), W - 24)}" y="${y - 4}" font-size="8" font-weight="800" text-anchor="middle" fill="#173C36">${chartMoney(b.total)}</text>` : "";
    return `<g class="sb" data-start="${b.start}">
      <rect x="${PADL + i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/>
      <rect x="${x}" y="${b.total > 0 ? y : H - PADB - 1}" width="${bw}" height="${b.total > 0 ? h : 1}" rx="3" fill="${sel ? "#173C36" : b.total > 0 ? "#9DB8AE" : "#E4E1D6"}"/>
      ${val}
      <text x="${cx}" y="${H - 5}" font-size="7" text-anchor="middle" fill="${sel ? "#173C36" : "#7C877F"}" font-weight="${sel ? 800 : 400}">${label}</text>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;">${bars}</svg>`;
}

function renderSpend() {
  const body = document.getElementById("spend-body");
  document.querySelectorAll("#gran-tabs .ptab").forEach((t) => t.classList.toggle("active", t.dataset.gran === spendGran));
  const purchases = getPurchases();
  if (!purchases.length) {
    body.innerHTML = `<div class="card"><div class="empty-inline">Marque itens como <strong>no carrinho</strong> para ver a análise de gastos por semana, mês e ano.</div></div>`;
    return;
  }
  const g = spendGran;
  const info = GRAN_INFO[g];
  const curStart = periodStart(new Date(), g);
  const curTs = curStart.getTime();
  const N = g === "year" ? 5 : 12;
  const firstStart = shiftPeriod(curStart, g, -(N - 1));
  const buckets = [];
  for (let i = 0; i < N; i++) buckets.push({ start: shiftPeriod(firstStart, g, i).getTime(), total: 0, count: 0 });
  const idx = new Map(buckets.map((b, i) => [b.start, i]));
  purchases.forEach((p) => {
    const i = idx.get(periodStart(p.date, g).getTime());
    if (i !== undefined) { buckets[i].total += p.total; buckets[i].count++; }
  });
  buckets.forEach((b) => (b.total = round2(b.total)));

  const selTs = spendSelected !== null && idx.has(spendSelected) ? spendSelected : curTs;
  const selBucket = buckets[idx.get(selTs)];
  const inSel = purchases.filter((p) => periodStart(p.date, g).getTime() === selTs);
  const prevTs = shiftPeriod(new Date(selTs), g, -1).getTime();
  const inPrev = purchases.filter((p) => periodStart(p.date, g).getTime() === prevTs);
  const selTotal = selBucket.total;
  const prevTotal = round2(inPrev.reduce((s, p) => s + p.total, 0));

  // Variação vs. período anterior
  let deltaHTML;
  if (prevTotal > 0) {
    const diff = selTotal - prevTotal;
    const pct = (diff / prevTotal) * 100;
    const cls = diff > 0 ? "up" : diff < 0 ? "down" : "";
    deltaHTML = `<span class="delta-badge ${cls}">${diff > 0 ? "▲" : diff < 0 ? "▼" : "="} ${formatPct(pct)}</span> vs ${info.prev} (${formatMoney(prevTotal)})`;
  } else {
    deltaHTML = `sem compras na ${info.prev}`.replace("na mês", "no mês").replace("na ano", "no ano");
  }

  // Média por período desde a primeira compra (dentro da janela exibida)
  const firstPurchaseStart = periodStart(purchases[0].date, g).getTime();
  const considered = buckets.filter((b) => b.start >= firstPurchaseStart && b.start <= curTs);
  const avg = considered.length ? considered.reduce((s, b) => s + b.total, 0) / considered.length : 0;
  const listsCount = new Set(inSel.map((p) => p.item.listId)).size;

  // Categorias e destaque de variação
  const selCats = catTotalsOf(inSel);
  const prevCats = catTotalsOf(inPrev);
  let riser = null;
  if (prevTotal > 0) {
    Object.keys(selCats).forEach((c) => {
      const d = selCats[c] - prevCats[c];
      if (d >= 1 && (!riser || d > riser.d)) riser = { c, d };
    });
  }
  const insight = riser
    ? `<div class="insight"><i class="fa-solid fa-arrow-trend-up"></i><span><strong>${catInfo(riser.c).name}</strong> foi a categoria que mais subiu: ${formatMoney(riser.d)} a mais que na ${info.prev}.</span></div>`
    : "";

  // Produtos que mais pesam
  const tops = topProducts(inSel, 5);
  const topsHTML = tops.length
    ? tops.map((t, i) => `
      <div class="top-row">
        <span class="top-rank">${i + 1}</span>
        <div class="top-info">
          <strong>${escapeHTML(t.name)}</strong>
          <small>${t.brand ? escapeHTML(t.brand) + " · " : ""}${t.count} ${t.count === 1 ? "compra" : "compras"}${t.allKg && t.kg > 0 ? " · " + t.kg.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " kg" : ""} · ${selTotal > 0 ? formatPct((t.total / selTotal) * 100) : "0%"} do total</small>
        </div>
        <span class="top-val">${formatMoney(t.total)}</span>
      </div>`).join("")
    : `<div class="empty-inline">Sem compras neste período.</div>`;

  body.innerHTML = `
    <div class="compare-summary">
      <div class="cs-card wide">
        <div>
          <span class="cs-label">GASTO · ${escapeHTML(periodLongLabel(new Date(selTs), g)).toUpperCase()}</span>
          <span class="cs-value">${formatMoney(selTotal)}</span>
          <span class="cs-sub">${deltaHTML}</span>
        </div>
      </div>
      <div class="cs-card">
        <span class="cs-label">${info.avg}</span>
        <span class="cs-value">${formatMoney(avg)}</span>
        <span class="cs-sub">desde a 1ª compra</span>
      </div>
      <div class="cs-card">
        <span class="cs-label">ITENS COMPRADOS</span>
        <span class="cs-value">${inSel.length}</span>
        <span class="cs-sub">em ${listsCount} ${listsCount === 1 ? "lista" : "listas"}</span>
      </div>
    </div>

    <div class="section-head" style="margin-top:26px;">
      <h2><i class="fa-solid fa-chart-column"></i> Evolução ${info.evo}</h2>
      ${selTs !== curTs ? `<button class="text-btn" id="spend-reset">Ir para o atual</button>` : ""}
    </div>
    <div class="card spend-chart">
      ${spendBarsSVG(buckets, selTs, g)}
      <div class="chart-hint">Toque numa barra para ver o detalhe daquele período.</div>
    </div>

    <div class="section-head" style="margin-top:26px;">
      <h2><i class="fa-solid fa-tags"></i> Onde você mais gasta</h2>
    </div>
    <div class="card">
      <div id="spend-cat-chart"></div>
      ${insight}
    </div>

    <div class="section-head" style="margin-top:26px;">
      <h2><i class="fa-solid fa-ranking-star"></i> Produtos que mais pesam</h2>
    </div>
    <div class="card top-card">${topsHTML}</div>
  `;

  renderCategoryBars("spend-cat-chart", selCats, true);
  body.querySelectorAll(".sb").forEach((el) => {
    el.addEventListener("click", () => { spendSelected = parseInt(el.dataset.start, 10); renderSpend(); });
  });
  const reset = document.getElementById("spend-reset");
  if (reset) reset.addEventListener("click", () => { spendSelected = null; renderSpend(); });
}

// ===============================================================
// 18. Histórico de preços por produto
// ===============================================================
function sparklineSVG(values) {
  if (values.length < 2) return "";
  const W = 64, H = 22, P = 2;
  const min = Math.min(...values), max = Math.max(...values);
  const pts = values.map((v, i) => [P + (i * (W - P * 2)) / (values.length - 1), H - P - ((v - min) / (max - min || 1)) * (H - P * 2)]);
  const last = values[values.length - 1], prev = values[values.length - 2];
  const color = last > prev ? "#C1502E" : last < prev ? "#4C7A6C" : "#7C877F";
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${pts[pts.length - 1][0]}" cy="${pts[pts.length - 1][1]}" r="2.2" fill="${color}"/></svg>`;
}

function renderPrices() {
  const body = document.getElementById("prices-body");
  const idx = getPriceIndex();
  const prodMap = new Map(products.map((p) => [p.id, p]));
  const q = normText(priceSearch);

  const all = [];
  idx.forEach((hist, pid) => {
    const p = prodMap.get(pid);
    if (p) all.push({ p, hist });
  });
  const untracked = getPurchases().filter((x) => x.item.productId == null).length;

  if (!all.length) {
    body.innerHTML = `
      <div class="card"><div class="empty-inline">
        Nenhum preço para comparar ainda.<br>
        Ao adicionar um item, deixe <strong>Acompanhar preço</strong> marcado e marque-o no carrinho. A comparação aparece a partir da 2ª compra do mesmo produto (mesmo código de barras, ou mesmo nome + marca).
        ${untracked ? `<br><br>${untracked} ${untracked === 1 ? "item comprado" : "itens comprados"} sem acompanhamento.` : ""}
      </div></div>`;
    return;
  }

  let rose = 0, fell = 0;
  all.forEach(({ hist }) => {
    if (hist.length < 2) return;
    const a = hist[hist.length - 1].price, b = hist[hist.length - 2].price;
    if (a > b) rose++; else if (a < b) fell++;
  });

  let rows = all.filter(({ p }) => !q || normText(p.name + " " + (p.brand || "") + " " + (p.barcode || "")).includes(q));
  rows.sort((a, b) => b.hist[b.hist.length - 1].ts - a.hist[a.hist.length - 1].ts);

  const rowsHTML = rows.length
    ? rows.map(({ p, hist }) => {
        const last = hist[hist.length - 1];
        const u = p.unitType === "kg" ? "kg" : "un";
        let badge = `<span class="delta-badge flat">1ª compra</span>`;
        if (hist.length > 1) {
          const prev = hist[hist.length - 2];
          const pct = ((last.price - prev.price) / prev.price) * 100;
          badge = Math.abs(pct) < 0.5
            ? `<span class="delta-badge flat">= igual</span>`
            : `<span class="delta-badge ${pct > 0 ? "up" : "down"}">${pct > 0 ? "▲" : "▼"} ${formatPct(pct)}</span>`;
        }
        return `
          <button class="price-row" data-pid="${p.id}">
            <div class="pr-main">
              <strong>${escapeHTML(p.name)}</strong>
              <small>${p.brand ? escapeHTML(p.brand) + " · " : ""}${hist.length} ${hist.length === 1 ? "compra" : "compras"}${p.barcode ? "" : " · sem código"}</small>
            </div>
            <div class="pr-spark">${sparklineSVG(hist.slice(-8).map((h) => h.price))}</div>
            <div class="pr-price"><strong>${formatMoney(last.price)}/${u}</strong>${badge}</div>
          </button>`;
      }).join("")
    : `<div class="empty-inline">Nenhum produto encontrado.</div>`;

  body.innerHTML = `
    <div class="compare-summary">
      <div class="cs-card"><span class="cs-label">SUBIRAM</span><span class="cs-value negative">${rose}</span><span class="cs-sub">vs compra anterior</span></div>
      <div class="cs-card"><span class="cs-label">CAÍRAM</span><span class="cs-value positive">${fell}</span><span class="cs-sub">vs compra anterior</span></div>
    </div>
    <div class="section-head" style="margin-top:22px;"><h2><i class="fa-solid fa-barcode"></i> Produtos acompanhados</h2></div>
    <div class="price-list">${rowsHTML}</div>
    ${untracked ? `<p class="fine-print">${untracked} ${untracked === 1 ? "item comprado ficou" : "itens comprados ficaram"} fora desta análise (acompanhamento desativado ou item antigo). Os gastos deles continuam contando na aba Gastos.</p>` : ""}
  `;
  body.querySelectorAll(".price-row").forEach((el) => el.addEventListener("click", () => openPriceDetail(parseInt(el.dataset.pid, 10))));
}

function priceLineSVG(hist) {
  const W = 300, H = 130, PX = 22, PT = 20, PB = 20;
  const prices = hist.map((h) => h.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const n = hist.length;
  const xs = hist.map((_, i) => (n === 1 ? W / 2 : PX + (i * (W - PX * 2)) / (n - 1)));
  const ys = prices.map((v) => PT + (1 - (v - min) / (max - min || 1)) * (H - PT - PB));
  const path = xs.map((x, i) => `${i ? "L" : "M"}${x},${ys[i]}`).join(" ");
  const showAll = n <= 6;
  const dots = xs.map((x, i) => {
    const label = showAll || i === 0 || i === n - 1
      ? `<text x="${x}" y="${ys[i] - 7}" font-size="8" font-weight="700" text-anchor="middle" fill="#173C36">${formatMoney(prices[i])}</text>` : "";
    return `<circle cx="${x}" cy="${ys[i]}" r="3.4" fill="#173C36" stroke="#fff" stroke-width="1.4"/>${label}`;
  }).join("");
  const dates = [0, n - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) =>
    `<text x="${xs[i]}" y="${H - 5}" font-size="7.5" text-anchor="${i === 0 && n > 1 ? "start" : n === 1 ? "middle" : "end"}" fill="#7C877F">${formatDateFull(hist[i].ts)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;">${n > 1 ? `<path d="${path}" fill="none" stroke="#173C36" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` : ""}${dots}${dates}</svg>`;
}

function openPriceDetail(pid) {
  const p = products.find((x) => x.id === pid);
  if (!p) return;
  const hist = purchasesOfProduct(pid);
  if (!hist.length) return;
  const u = p.unitType === "kg" ? "kg" : "un";
  const prices = hist.map((h) => h.price);
  const last = hist[hist.length - 1];
  const minP = hist.reduce((m, h) => (h.price < m.price ? h : m), hist[0]);
  const maxP = Math.max(...prices);
  const avgP = prices.reduce((s, v) => s + v, 0) / prices.length;

  let insight = "";
  if (hist.length > 1) {
    const first = hist[0];
    const pct = ((last.price - first.price) / first.price) * 100;
    insight = `<div class="insight"><i class="fa-solid ${pct > 0 ? "fa-arrow-trend-up" : "fa-arrow-trend-down"}"></i><span>${Math.abs(pct) < 0.5 ? "Preço estável" : `${pct > 0 ? "Subiu" : "Caiu"} <strong>${formatPct(pct)}</strong>`} desde a 1ª compra (${formatDateFull(first.ts)}). Menor preço: <strong>${formatMoney(minP.price)}</strong> em ${formatDateFull(minP.ts)}.</span></div>`;
  }

  const rows = [...hist].reverse().slice(0, 15).map((h) => `
    <tr>
      <td>${formatDateFull(h.ts)}</td>
      <td>${h.list ? escapeHTML(h.list.name) : "—"}</td>
      <td class="num">${formatQty(h.item)}</td>
      <td class="num">${formatMoney(h.price)}</td>
    </tr>`).join("");

  document.getElementById("price-modal-title").textContent = p.name;
  document.getElementById("price-modal-body").innerHTML = `
    <p class="pm-sub">${p.brand ? escapeHTML(p.brand) + " · " : ""}${p.unitType === "kg" ? "preço por kg" : "preço por unidade"} · ${p.barcode ? "código " + p.barcode : "identificado por nome + marca (sem código de barras)"}</p>
    <div class="stat-grid">
      <div><span>Último</span><strong>${formatMoney(last.price)}</strong></div>
      <div><span>Menor</span><strong>${formatMoney(minP.price)}</strong></div>
      <div><span>Média</span><strong>${formatMoney(avgP)}</strong></div>
      <div><span>Maior</span><strong>${formatMoney(maxP)}</strong></div>
    </div>
    <div class="card-flat">${priceLineSVG(hist)}</div>
    ${insight}
    <div class="table-wrap" style="margin-top:12px;">
      <table class="compare-table">
        <thead><tr><th>Data</th><th>Lista</th><th class="num">Qtd</th><th class="num">Preço/${u}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  openModal("price-modal");
}

// ===============================================================
// 19. Leitor de código de barras (câmera)
//     1) BarcodeDetector nativo (Chrome/Android) — rápido e sem download
//     2) ZXing local (vendor/zxing.min.js) como alternativa (iOS/Safari/Firefox)
//     Só aceita leitura com dígito verificador válido, confirmada 2x seguidas.
// ===============================================================
const scanState = { active: false, stream: null, raf: 0, reader: null, detector: null, onResult: null, lastCode: null, hits: 0, torchOn: false };

function loadZXing() {
  if (window.ZXing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/zxing.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("zxing indisponível"));
    document.head.appendChild(s);
  });
}

async function openScanner(onResult) {
  if (scanState.active) return;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showNotification("A câmera só funciona em HTTPS. Digite o código manualmente.", "error");
    return;
  }
  const overlay = document.getElementById("scanner");
  const video = document.getElementById("scanner-video");
  const msg = document.getElementById("scanner-msg");
  Object.assign(scanState, { active: true, onResult, lastCode: null, hits: 0, torchOn: false });
  overlay.hidden = false;
  msg.textContent = "Iniciando câmera…";

  try {
    scanState.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    closeScanner();
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    showNotification(denied ? "Permissão da câmera negada. Libere nas configurações do navegador." : "Não foi possível abrir a câmera.", "error");
    return;
  }
  if (!scanState.active) { // fechado enquanto o navegador pedia permissão
    scanState.stream.getTracks().forEach((t) => t.stop());
    scanState.stream = null;
    return;
  }
  video.srcObject = scanState.stream;
  try { await video.play(); } catch (e) { /* autoplay bloqueado: o stream segue anexado */ }
  setupTorch();
  msg.textContent = "Aponte para o código de barras";

  try {
    await startDecoding(video);
  } catch (err) {
    console.warn("Leitor de código de barras:", err);
    closeScanner();
    showNotification("Leitor indisponível agora. Digite o código manualmente.", "error");
  }
}

async function startDecoding(video) {
  const WANT = ["ean_13", "ean_8", "upc_a"];
  if ("BarcodeDetector" in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = WANT.filter((f) => supported.includes(f));
      if (formats.length) {
        scanState.detector = new window.BarcodeDetector({ formats });
        loopNativeDetect(video);
        return;
      }
    } catch (e) { /* cai para o ZXing */ }
  }
  await loadZXing();
  if (!scanState.active) return;
  const { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } = window.ZXing;
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  scanState.reader = new BrowserMultiFormatReader(hints, 200);
  scanState.reader.decodeFromStream(scanState.stream, video, (result) => {
    if (result) handleScanned(result.getText());
  });
}

function loopNativeDetect(video) {
  let busy = false, lastRun = 0;
  const tick = async (t) => {
    if (!scanState.active) return;
    if (!busy && t - lastRun > 120 && video.readyState >= 2) {
      busy = true; lastRun = t;
      try {
        const codes = await scanState.detector.detect(video);
        if (codes.length) handleScanned(codes[0].rawValue);
      } catch (e) { /* frame inválido: tenta no próximo */ }
      busy = false;
    }
    scanState.raf = requestAnimationFrame(tick);
  };
  scanState.raf = requestAnimationFrame(tick);
}

function handleScanned(raw) {
  if (!scanState.active) return;
  const code = canonBarcode(raw);
  if (!isValidGTIN(code)) return;
  if (code === scanState.lastCode) scanState.hits++; else { scanState.lastCode = code; scanState.hits = 1; }
  if (scanState.hits < 2) return;
  const cb = scanState.onResult;
  if (navigator.vibrate) navigator.vibrate(60);
  closeScanner();
  if (cb) cb(code);
}

function setupTorch() {
  const btn = document.getElementById("scanner-torch");
  const track = scanState.stream && scanState.stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  btn.hidden = !caps.torch;
  btn.classList.remove("on");
}
async function toggleTorch() {
  const track = scanState.stream && scanState.stream.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: !scanState.torchOn }] });
    scanState.torchOn = !scanState.torchOn;
    document.getElementById("scanner-torch").classList.toggle("on", scanState.torchOn);
  } catch (e) {
    showNotification("Lanterna indisponível neste aparelho.", "info");
  }
}

function closeScanner() {
  scanState.active = false;
  cancelAnimationFrame(scanState.raf);
  try { if (scanState.reader) scanState.reader.reset(); } catch (e) { /* ignora */ }
  scanState.reader = null;
  scanState.detector = null;
  if (scanState.stream) scanState.stream.getTracks().forEach((t) => t.stop());
  scanState.stream = null;
  scanState.torchOn = false;
  const video = document.getElementById("scanner-video");
  if (video) video.srcObject = null;
  const overlay = document.getElementById("scanner");
  if (overlay) overlay.hidden = true;
  const torch = document.getElementById("scanner-torch");
  if (torch) { torch.hidden = true; torch.classList.remove("on"); }
}

// ===============================================================
// 20. Eventos das novidades da v2.1
// ===============================================================
function setupV21Events() {
  // Comparar: visões (Listas | Gastos | Preços)
  document.querySelectorAll("#compare-seg .seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      compareView = b.dataset.cview;
      renderCompare();
      document.getElementById("app-main").scrollTo({ top: 0, behavior: "instant" });
    });
  });
  document.querySelectorAll("#gran-tabs .ptab").forEach((t) => {
    t.addEventListener("click", () => { spendGran = t.dataset.gran; spendSelected = null; renderSpend(); });
  });
  document.getElementById("price-search-input").addEventListener("input", (e) => {
    priceSearch = e.target.value.trim();
    renderPrices();
  });

  // Formulário do item
  setupProductFormEvents();

  // Scanner
  document.getElementById("scanner-close").addEventListener("click", closeScanner);
  document.getElementById("scanner-torch").addEventListener("click", toggleTorch);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && scanState.active) closeScanner(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && scanState.active) closeScanner(); });
}
