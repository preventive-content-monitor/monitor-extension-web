/**
 * Guardian Extension - Options Page (Simplificado)
 * Apenas: Login, Vinculação de dispositivo, Status
 */
import { API_BASE_URL } from "../shared/constants.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const isPopup = new URLSearchParams(location.search).get("popup") === "1";
document.documentElement.classList.toggle("popup-mode", isPopup);

// Estado
let authState = { isLoggedIn: false, email: null };
let keywordRequired = false;

// ================== BLOQUEIO POR PALAVRA-CHAVE ==================
async function refreshLock() {
  try {
    const st = await chrome.runtime.sendMessage({ type: "GET_LOCK_STATUS" });
    const locked = !!st?.ok && st.locked;
    document.body.classList.toggle("is-locked", locked);
    $("#lockCard").hidden = !locked;
    if (locked) {
      $("#lockChildName").textContent = st.dependentNickname || "seu filho";
      $("#lockIncognitoWarning").hidden = st.anonimoPermitido !== false;
      $("#lockNoKeyword").hidden = st.palavraChaveDefinida;
      $("#unlockForm").hidden = !st.palavraChaveDefinida;
      updateStatusBadge(true);
      setTimeout(() => $("#unlockKeyword")?.focus(), 50);
    }
    return locked;
  } catch (e) {
    console.warn("Failed to load lock status:", e);
    return false;
  }
}

async function handleUnlock(event) {
  event.preventDefault();
  const input = $("#unlockKeyword");
  const errorEl = $("#unlockError");
  errorEl.textContent = "";
  if (!input.value.trim()) {
    errorEl.textContent = "Digite a palavra-chave.";
    return;
  }
  const btn = $("#unlockBtn");
  btn.disabled = true;
  btn.textContent = "Conferindo...";
  try {
    const response = await chrome.runtime.sendMessage({ type: "UNLOCK_SETTINGS", palavraChave: input.value });
    if (response?.ok) {
      input.value = "";
      await refreshLock();
      await Promise.all([loadAuthStatus(), loadConnectionStatus()]);
      if (!isPopup) await loadPolicyStatus();
      showToast("Configurações liberadas por 5 minutos", "success");
    } else {
      errorEl.textContent = response?.error || "Palavra-chave errada.";
      input.select();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Abrir configurações";
  }
}

async function handleLockNow() {
  await chrome.runtime.sendMessage({ type: "LOCK_SETTINGS" });
  await refreshLock();
}

async function checkKeywordSetup() {
  keywordRequired = false;
  if (authState.isLoggedIn) {
    const response = await chrome.runtime.sendMessage({ type: "KEYWORD_STATUS" }).catch(() => null);
    keywordRequired = !!response?.ok && !response.definida;
  }
  $("#keywordSetup").hidden = !keywordRequired;
}

// ================== INICIALIZAÇÃO ==================
document.addEventListener("DOMContentLoaded", async () => {
  // Injeta o IP dinâmico gerado pelo Terraform no link do dashboard e no placeholder
  const dashboardLink = document.getElementById("dashboardLink");
  if (dashboardLink) dashboardLink.href = `${API_BASE_URL}/dashboard/`;
  $("#popupDashboardLink").href = `${API_BASE_URL}/dashboard/dependents.html`;
  const backendUrlInput = document.getElementById("backendUrl");
  if (backendUrlInput) backendUrlInput.placeholder = API_BASE_URL;

  await Promise.all([loadAuthStatus(), loadConnectionStatus()]);
  setupEventListeners();
  const locked = await refreshLock();
  if (!locked) await checkKeywordSetup();
  if (!isPopup && !locked) await loadPolicyStatus();
});

// ================== AUTH ==================
async function loadAuthStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_AUTH_STATUS",
    });
    if (!response?.ok) throw new Error(response?.error || "Não foi possível consultar sua sessão.");
    authState = {
      isLoggedIn: response.isLoggedIn,
      email: response.email,
    };
  } catch (e) {
    console.warn("Failed to load auth status:", e);
    $("#loginError").textContent = e.message || "Não foi possível consultar sua sessão. Reabra a extensão.";
  }
  updateAuthUI();
}

function updateAuthUI() {
  const notLoggedIn = $("#notLoggedIn");
  const loggedIn = $("#loggedIn");

  if (authState.isLoggedIn) {
    notLoggedIn.style.display = "none";
    loggedIn.style.display = "grid";
    $("#loggedEmail").textContent = authState.email || "-";
    document.body.classList.add("logged-in");
  } else {
    notLoggedIn.style.display = "block";
    loggedIn.style.display = "none";
    document.body.classList.remove("logged-in");
  }
}

async function handleLogin() {
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  const errorEl = $("#loginError");

  errorEl.textContent = "";

  if (!email || !password) {
    errorEl.textContent = "Preencha email e senha";
    return;
  }

  const btn = $("#loginBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Entrando...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: "LOGIN",
      email,
      password,
    });

    if (response?.ok) {
      $("#loginPassword").value = "";
      if (response.migrated) {
        await loadAuthStatus();
        showToast(response.warning || "Vínculo atualizado com segurança!", response.warning ? "error" : "success");
      } else {
        authState = { isLoggedIn: true, email };
        updateAuthUI();
        await checkKeywordSetup();
        showToast("Autorização temporária concedida.", "success");
      }
      await loadConnectionStatus();
      if (!response.migrated) ($("#keywordSetup").hidden ? $("#connectionCode") : $("#newKeyword")).focus();
    } else {
      errorEl.textContent = response?.error || "Erro ao fazer login";
    }
  } catch (e) {
    errorEl.textContent = "Erro de conexão";
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">🔓</span> Entrar';
  }
}

async function handleRegister() {
  const email = $("#registerEmail").value.trim();
  const password = $("#registerPassword").value;
  const passwordConfirm = $("#registerPasswordConfirm").value;
  const errorEl = $("#registerError");

  errorEl.textContent = "";

  if (!email || !password) {
    errorEl.textContent = "Preencha todos os campos";
    return;
  }

  if (password.length < 6) {
    errorEl.textContent = "A senha deve ter pelo menos 6 caracteres";
    return;
  }

  if (password !== passwordConfirm) {
    errorEl.textContent = "As senhas não coincidem";
    return;
  }

  const btn = $("#registerBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Criando...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: "REGISTER",
      email,
      password,
    });

    if (response?.ok) {
      showToast("Conta criada! Faça login.", "success");
      // Switch to login tab
      $$(".auth-tab").forEach((t) => t.classList.remove("active"));
      $(".auth-tab[data-tab='login']").classList.add("active");
      $("#loginForm").style.display = "block";
      $("#registerForm").style.display = "none";
      $("#loginEmail").value = email;
    } else {
      errorEl.textContent = response?.error || "Erro ao criar conta";
    }
  } catch (e) {
    errorEl.textContent = "Erro de conexão";
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">📝</span> Criar Conta';
  }
}

async function handleLogout() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "LOGOUT" });
    if (!response?.ok) throw new Error(response?.error || "Não foi possível sair da conta.");
    authState = { isLoggedIn: false, email: null };
    $("#connectionCode").value = "";
    updateAuthUI();
    showToast("Você saiu da conta", "info");
  } catch (e) {
    console.error("Logout failed:", e);
    showToast(e.message || "Não foi possível sair da conta.", "error");
    await loadAuthStatus();
  }
}

// ================== CONEXÃO DO DISPOSITIVO ==================
async function loadConnectionStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_CONNECTION_STATUS",
    });
    if (!response?.ok) throw new Error(response?.error || "Não foi possível consultar o vínculo.");
    $("#connectionError").textContent = "";
    document.body.classList.toggle("is-enrolled", !!response.enrolled);

    if (response?.enrolled) {
      $("#notConnected").style.display = "none";
      $("#connected").style.display = "block";
      const dependentName =
        typeof response.dependentNickname === "string"
          ? response.dependentNickname.trim()
          : "";
      $("#childName").textContent = dependentName || "Dependente";
      $("#connectedSince").textContent = response.enrolledAt
        ? new Date(response.enrolledAt).toLocaleDateString("pt-BR")
        : "-";
      updateStatusBadge(true);
    } else {
      $("#notConnected").style.display = "block";
      $("#connected").style.display = "none";
      if (response.requiresAuthorization) {
        $("#loginError").textContent = "Para atualizar a proteção, entre com a conta do responsável. O vínculo existente será mantido.";
      }
      updateStatusBadge(false);
    }
  } catch (e) {
    console.warn("Failed to load connection status:", e);
    $("#statusText").textContent = "Status indisponível";
    $("#connectionError").textContent = e.message || "Não foi possível consultar o vínculo. Reabra a extensão.";
  }
}

async function handleConnect() {
  const code = $("#connectionCode").value.trim().toLowerCase();
  const errorEl = $("#connectionError");

  errorEl.textContent = "";

  if (!authState.isLoggedIn) {
    $("#loginError").textContent = "Entre com a mesma conta do painel antes de vincular.";
    $("#loginEmail").focus();
    return;
  }

  if (!/^[a-z0-9]{6}$/.test(code)) {
    errorEl.textContent = "Digite o código de 6 caracteres";
    return;
  }

  if (keywordRequired) {
    const palavra = $("#newKeyword").value.trim();
    if (palavra.length < 4) {
      errorEl.textContent = "A palavra-chave precisa ter pelo menos 4 letras.";
      $("#newKeyword").focus();
      return;
    }
    if (palavra !== $("#newKeywordConfirm").value.trim()) {
      errorEl.textContent = "As palavras-chave não são iguais.";
      $("#newKeywordConfirm").focus();
      return;
    }
    const saved = await chrome.runtime.sendMessage({ type: "SET_KEYWORD", palavraChave: palavra });
    if (!saved?.ok) {
      errorEl.textContent = saved?.error || "Não foi possível salvar a palavra-chave.";
      return;
    }
    keywordRequired = false;
    $("#keywordSetup").hidden = true;
    $("#newKeyword").value = "";
    $("#newKeywordConfirm").value = "";
  }

  const btn = $("#connectBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Conectando...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ENROLL_DEVICE",
      code,
    });

    if (response?.ok) {
      showToast(response.warning || "Dispositivo conectado!", response.warning ? "error" : "success");
      $("#connectionCode").value = "";
      await loadAuthStatus();
      await loadConnectionStatus();
      if (!isPopup) await loadPolicyStatus();
      await refreshLock();
    } else {
      errorEl.textContent = response?.error || "Código inválido ou expirado";
      if (response?.error?.includes("autorização temporária expirou")) {
        await loadAuthStatus();
        $("#loginError").textContent = response.error;
      }
    }
  } catch (e) {
    errorEl.textContent = "Erro de conexão";
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">🔗</span> Conectar';
  }
}

async function handleDisconnect() {
  const palavraChave = await showModal(
    "Desconectar este navegador?",
    "A proteção será desligada. Digite a palavra-chave do responsável para confirmar.",
    "⚠️",
    { input: true },
  );

  if (!palavraChave) return;

  try {
    const response = await chrome.runtime.sendMessage({ type: "DISCONNECT_DEVICE", palavraChave });
    if (!response?.ok) throw new Error(response?.error || "Não foi possível desconectar.");
    showToast("Dispositivo desconectado", "info");
    await loadConnectionStatus();
    await loadPolicyStatus();
    await refreshLock();
  } catch (e) {
    showToast(e.message || "Erro ao desconectar", "error");
  }
}

async function handleSyncNow() {
  const btn = $("#syncNowBtn");
  const originalText = btn.innerHTML;

  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Sincronizando...';

  try {
    // Solicita sincronização imediata ao service worker
    const response = await chrome.runtime.sendMessage({
      type: "SYNC_POLICY_NOW",
    });

    if (response?.ok) {
      showToast("Política sincronizada!", "success");
      // Atualiza o display
      await loadPolicyStatus();
    } else {
      showToast(response?.error || "Erro ao sincronizar", "error");
    }
  } catch (e) {
    console.error("Sync error:", e);
    showToast("Erro ao sincronizar", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

function updateStatusBadge(isConnected) {
  const badge = $("#statusBadge");
  const text = $("#statusText");

  if (isConnected) {
    badge.classList.add("status-active");
    badge.classList.remove("status-inactive");
    text.textContent = "Proteção ativa";
  } else {
    badge.classList.add("status-inactive");
    badge.classList.remove("status-active");
    text.textContent = "Não conectado";
  }
}

// ================== STATUS DA POLÍTICA ==================
async function loadPolicyStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_POLICY_STATUS",
    });

    if (response?.policy) {
      const policy = response.policy;

      const modeLabels = {
        BLOCK: "🚫 Bloquear",
        WARN: "⚠️ Avisar",
        EDUCATE: "📝 Educar",
      };

      $("#policyMode").textContent =
        modeLabels[policy.mode] || policy.mode || "-";

      const blockedCount = Array.isArray(policy.blockedDomains)
        ? policy.blockedDomains.length
        : 0;
      $("#blockedCount").textContent = blockedCount.toString();

      $("#lastSync").textContent = response.lastSync
        ? new Date(response.lastSync).toLocaleTimeString("pt-BR")
        : "Agora";
    } else {
      $("#policyMode").textContent = "-";
      $("#blockedCount").textContent = "-";
      $("#lastSync").textContent = "-";
    }
  } catch (e) {
    console.warn("Failed to load policy status:", e);
  }
}

// ================== CONFIGURAÇÕES DO SERVIDOR ==================
async function loadServerSettings() {
  const settings = await chrome.storage.sync.get(["backendUrl"]);
  $("#backendUrl").value = settings.backendUrl || "";
}

async function handleSaveServer() {
  const backendUrl = $("#backendUrl").value.trim();
  try {
    const url = new URL(backendUrl || API_BASE_URL);
    if (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new Error("O servidor deve usar HTTPS.");
    }
    await chrome.storage.sync.set({ backendUrl: url.origin, uploadEnabled: true });
    showToast("Configurações salvas!", "success");
  } catch (error) {
    showToast(error.message || "Endereço de servidor inválido.", "error");
  }
}

async function handleTestBackend() {
  const backendUrl = $("#backendUrl").value.trim() || API_BASE_URL;

  try {
    const response = await fetch(`${backendUrl}/v3/api-docs`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      showToast("Conexão OK! ✓", "success");
    } else {
      showToast(`Erro: ${response.status}`, "error");
    }
  } catch (e) {
    showToast("Servidor não responde", "error");
  }
}

// ================== EVENT LISTENERS ==================
function setupEventListeners() {
  // Auth tabs
  $$(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabName = tab.dataset.tab;

      $$(".auth-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      $("#loginForm").style.display = tabName === "login" ? "block" : "none";
      $("#registerForm").style.display =
        tabName === "register" ? "block" : "none";

      $("#loginError").textContent = "";
      $("#registerError").textContent = "";
    });
  });

  // Login/Register
  $("#loginBtn").addEventListener("click", handleLogin);
  $("#registerBtn").addEventListener("click", handleRegister);
  $("#logoutBtn").addEventListener("click", handleLogout);

  // Enter key for login
  $("#loginPassword").addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleLogin();
  });
  $("#registerPasswordConfirm").addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleRegister();
  });

  // Connection
  $("#connectBtn").addEventListener("click", handleConnect);
  $("#disconnectBtn").addEventListener("click", handleDisconnect);
  $("#manageConnectionBtn").addEventListener("click", () => {
    document.body.classList.remove("is-enrolled");
    $("#loginEmail").focus();
  });

  // Sync Now button
  $("#syncNowBtn")?.addEventListener("click", handleSyncNow);

  // Enter key for connection
  $("#connectionCode").addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleConnect();
  });

  // Advanced toggle
  $("#toggleAdvanced").addEventListener("click", () => {
    const content = $("#advancedContent");
    const icon = $("#toggleAdvanced .collapse-icon");

    if (content.style.display === "none") {
      content.style.display = "block";
      icon.textContent = "▲";
      loadServerSettings();
    } else {
      content.style.display = "none";
      icon.textContent = "▼";
    }
  });

  // Server settings
  $("#saveServerBtn").addEventListener("click", handleSaveServer);
  $("#testBackend").addEventListener("click", handleTestBackend);

  // Modal
  $("#modalCancel").addEventListener("click", () => {
    $("#modalOverlay").classList.remove("show");
    modalResolve?.(false);
  });
  $("#modalConfirm").addEventListener("click", () => {
    const input = $("#modalInput");
    if (!input.hidden && !input.value.trim()) {
      $("#modalError").textContent = "Digite a palavra-chave.";
      input.focus();
      return;
    }
    $("#modalOverlay").classList.remove("show");
    modalResolve?.(input.hidden ? true : input.value);
    input.value = "";
  });
  $("#modalInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") $("#modalConfirm").click();
  });

  // Palavra-chave
  $("#unlockForm").addEventListener("submit", handleUnlock);
  $("#lockNowBtn").addEventListener("click", handleLockNow);
}

// ================== TOAST ==================
function showToast(message, type = "info") {
  const toast = $("#toast");
  const toastMessage = $("#toastMessage");
  const toastIcon = toast.querySelector(".toast-icon");

  const icons = {
    success: "✓",
    error: "✕",
    info: "ℹ",
    warning: "⚠",
  };

  toastIcon.textContent = icons[type] || icons.info;
  toastMessage.textContent = message;

  toast.className = `toast toast-${type} show`;

  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

// ================== MODAL ==================
let modalResolve = null;

function showModal(title, message, icon = "⚠️", options = {}) {
  return new Promise((resolve) => {
    modalResolve = resolve;

    $("#modalIcon").textContent = icon;
    $("#modalTitle").textContent = title;
    $("#modalMessage").textContent = message;
    $("#modalError").textContent = "";
    $("#modalInput").hidden = !options.input;
    $("#modalInput").value = "";
    $("#modalOverlay").classList.add("show");
    if (options.input) setTimeout(() => $("#modalInput").focus(), 50);
  });
}
