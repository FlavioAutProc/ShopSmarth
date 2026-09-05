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
const DB_VERSION = 1;
const STORES = { LISTS: "lists", ITEMS: "items" };

const CATEGORIES = {
  food: { name: "Alimentos", color: "#C6863A", cls: "category-food" },
  produce: { name: "Hortifruti", color: "#6B9080", cls: "category-produce" },
  clean: { name: "Limpeza", color: "#4E7EA6", cls: "category-clean" },
  hygiene: { name: "Higiene", color: "#9B7EBD", cls: "category-hygiene" },
  drinks: { name: "Bebidas", color: "#D4667A", cls: "category-drinks" },
  other: { name: "Outros", color: "#8A8578", cls: "category-other" },
};

let lists = [];
let items = [];

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

async function loadLists() { lists = await dbGetAll(STORES.LISTS); }
async function loadItems() { items = await dbGetAll(STORES.ITEMS); }

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
function plannedTotal(listId) {
  return itemsForList(listId).reduce((s, i) => s + i.quantity * i.unitPrice, 0);
}
function spentTotal(listId) {
  return itemsForList(listId).filter((i) => i.checked).reduce((s, i) => s + i.quantity * i.unitPrice, 0);
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

  const sorted = [...listItems].sort((a, b) => a.checked - b.checked || catInfo(a.category).name.localeCompare(catInfo(b).name));
  doc.autoTable({
    startY: 32,
    head: [["Item", "Categoria", "Qtd", "Preço un.", "Total", "Pego"]],
    body: sorted.map((i) => [
      i.name,
      catInfo(i.category).name,
      String(i.quantity),
      formatMoney(i.unitPrice),
      formatMoney(i.quantity * i.unitPrice),
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

function openProductModal(productId = null) {
  const form = document.getElementById("product-form");
  form.reset();
  if (productId) {
    const item = items.find((i) => i.id === productId);
    document.getElementById("modal-title").textContent = "Editar item";
    document.getElementById("product-id").value = item.id;
    document.getElementById("product-name").value = item.name;
    document.getElementById("product-quantity").value = item.quantity;
    document.getElementById("product-price").value = item.unitPrice;
    document.getElementById("product-category").value = item.category;
  } else {
    document.getElementById("modal-title").textContent = "Adicionar item";
    document.getElementById("product-id").value = "";
    document.getElementById("product-quantity").value = 1;
  }
  openModal("product-modal");
}

async function handleProductSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("product-id").value;
  const name = document.getElementById("product-name").value.trim();
  const quantity = parseInt(document.getElementById("product-quantity").value, 10);
  const unitPrice = parseFloat(document.getElementById("product-price").value);
  const category = document.getElementById("product-category").value;

  if (name.length < 2) { showNotification("Digite um nome válido.", "error"); return; }
  if (isNaN(quantity) || quantity <= 0) { showNotification("Quantidade inválida.", "error"); return; }
  if (isNaN(unitPrice) || unitPrice < 0) { showNotification("Preço inválido.", "error"); return; }

  try {
    if (id) {
      const item = items.find((i) => i.id === parseInt(id, 10));
      Object.assign(item, { name, quantity, unitPrice, category });
      await dbPut(STORES.ITEMS, item);
      showNotification("Item atualizado.", "success");
    } else {
      const newItem = {
        listId: currentListId, name, quantity, unitPrice, category,
        checked: false, checkedDate: null, addedDate: new Date().toISOString(),
      };
      const newId = await dbPut(STORES.ITEMS, newItem);
      newItem.id = newId;
      items.push(newItem);
      showNotification("Item adicionado à lista.", "success");
    }
    await loadItems();
    closeModal("product-modal");
    renderListDetail();
  } catch (err) {
    console.error(err);
    showNotification("Erro ao salvar o item.", "error");
  }
}

async function toggleItemChecked(itemId) {
  const item = items.find((i) => i.id === itemId);
  item.checked = !item.checked;
  item.checkedDate = item.checked ? new Date().toISOString() : null;
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
      return itemsForList(l.id).some((i) => i.name.toLowerCase().includes(searchTerm) || catInfo(i.category).name.toLowerCase().includes(searchTerm));
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
  const total = item.quantity * item.unitPrice;
  const cat = catInfo(item.category);
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
            <span>${item.quantity} un · ${formatMoney(item.unitPrice)}/un</span>
            <span class="category-badge ${cat.cls}">${cat.name}</span>
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
    itemsForList(id).filter((i) => i.checked).forEach((i) => { totals[i.category] += i.quantity * i.unitPrice; });
  });
  return totals;
}

function renderCategoryBars(containerId, totals) {
  const box = document.getElementById(containerId);
  const entries = Object.entries(totals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    box.innerHTML = `<div class="empty-inline">Nenhum gasto registrado ainda.</div>`;
    return;
  }
  const max = Math.max(...entries.map(([, v]) => v));
  box.innerHTML = entries.map(([cat, v]) => {
    const info = catInfo(cat);
    const pct = (v / max) * 100;
    return `
      <div class="cat-bar-row">
        <div class="cat-bar-top"><span>${info.name}</span><strong>${formatMoney(v)}</strong></div>
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
  const payload = { version: 2, exportedAt: new Date().toISOString(), lists, items };
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
        for (const l of data.lists) { const { id, ...rest } = l; await dbPut(STORES.LISTS, l.id ? l : rest); }
        for (const i of data.items) { const { id, ...rest } = i; await dbPut(STORES.ITEMS, i.id ? i : rest); }
        await loadLists();
        await loadItems();
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
  lists = []; items = [];
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
