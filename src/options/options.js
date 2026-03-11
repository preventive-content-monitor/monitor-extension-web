/**
 * Guardian Extension - Options Page (Simplificado)
 * Apenas: Login, Vinculação de dispositivo, Status
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Estado
let authState = { isLoggedIn: false, email: null };

// ================== INICIALIZAÇÃO ==================
document.addEventListener("DOMContentLoaded", async () => {
  await loadAuthStatus();
  await loadConnectionStatus();
  await loadPolicyStatus();
  setupEventListeners();
});

// ================== AUTH ==================
async function loadAuthStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_AUTH_STATUS" });
    if (response?.ok) {
      authState = {
        isLoggedIn: response.isLoggedIn,
        email: response.email,
      };
    }
  } catch (e) {
    console.warn("Failed to load auth status:", e);
  }
  updateAuthUI();
}

function updateAuthUI() {
  const notLoggedIn = $("#notLoggedIn");
  const loggedIn = $("#loggedIn");
  
  if (authState.isLoggedIn) {
    notLoggedIn.style.display = "none";
    loggedIn.style.display = "flex";
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
      authState = { isLoggedIn: true, email };
      updateAuthUI();
      showToast("Login realizado com sucesso!", "success");
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
      $$(".auth-tab").forEach(t => t.classList.remove("active"));
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
    await chrome.runtime.sendMessage({ type: "LOGOUT" });
    authState = { isLoggedIn: false, email: null };
    updateAuthUI();
    showToast("Você saiu da conta", "info");
  } catch (e) {
    console.error("Logout failed:", e);
  }
}

// ================== CONEXÃO DO DISPOSITIVO ==================
async function loadConnectionStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_CONNECTION_STATUS" });
    
    if (response?.enrolled) {
      $("#notConnected").style.display = "none";
      $("#connected").style.display = "block";
      $("#childName").textContent = response.dependentNickname || "Dependente";
      $("#connectedSince").textContent = response.enrolledAt 
        ? new Date(response.enrolledAt).toLocaleDateString("pt-BR")
        : "-";
      updateStatusBadge(true);
    } else {
      $("#notConnected").style.display = "block";
      $("#connected").style.display = "none";
      updateStatusBadge(false);
    }
  } catch (e) {
    console.warn("Failed to load connection status:", e);
    updateStatusBadge(false);
  }
}

async function handleConnect() {
  const code = $("#connectionCode").value.trim().toLowerCase();
  const errorEl = $("#connectionError");
  
  errorEl.textContent = "";
  
  if (!code || code.length < 6) {
    errorEl.textContent = "Digite o código de 6 caracteres";
    return;
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
      showToast("Dispositivo conectado!", "success");
      await loadConnectionStatus();
      await loadPolicyStatus();
    } else {
      errorEl.textContent = response?.error || "Código inválido ou expirado";
    }
  } catch (e) {
    errorEl.textContent = "Erro de conexão";
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">🔗</span> Conectar';
  }
}

async function handleDisconnect() {
  const confirmed = await showModal(
    "Desconectar dispositivo?",
    "A proteção será desativada neste navegador.",
    "⚠️"
  );
  
  if (!confirmed) return;
  
  try {
    await chrome.runtime.sendMessage({ type: "DISCONNECT_DEVICE" });
    showToast("Dispositivo desconectado", "info");
    await loadConnectionStatus();
    await loadPolicyStatus();
  } catch (e) {
    showToast("Erro ao desconectar", "error");
  }
}

async function handleSyncNow() {
  const btn = $("#syncNowBtn");
  const originalText = btn.innerHTML;
  
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> Sincronizando...';
  
  try {
    // Solicita sincronização imediata ao service worker
    const response = await chrome.runtime.sendMessage({ type: "SYNC_POLICY_NOW" });
    
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
    const response = await chrome.runtime.sendMessage({ type: "GET_POLICY_STATUS" });
    
    if (response?.policy) {
      const policy = response.policy;
      
      const modeLabels = {
        BLOCK: "🚫 Bloquear",
        WARN: "⚠️ Avisar",
        EDUCATE: "📝 Educar"
      };
      
      $("#policyMode").textContent = modeLabels[policy.mode] || policy.mode || "-";
      
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
  
  await chrome.storage.sync.set({
    backendUrl: backendUrl || "http://localhost:8080",
    uploadEnabled: true,
  });
  
  showToast("Configurações salvas!", "success");
}

async function handleTestBackend() {
  const backendUrl = $("#backendUrl").value.trim() || "http://localhost:8080";
  
  try {
    const response = await fetch(`${backendUrl}/actuator/health`, {
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
  $$(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const tabName = tab.dataset.tab;
      
      $$(".auth-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      
      $("#loginForm").style.display = tabName === "login" ? "block" : "none";
      $("#registerForm").style.display = tabName === "register" ? "block" : "none";
      
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
    $("#modalOverlay").classList.remove("show");
    modalResolve?.(true);
  });
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
    warning: "⚠"
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

function showModal(title, message, icon = "⚠️") {
  return new Promise((resolve) => {
    modalResolve = resolve;
    
    $("#modalIcon").textContent = icon;
    $("#modalTitle").textContent = title;
    $("#modalMessage").textContent = message;
    $("#modalOverlay").classList.add("show");
  });
}
