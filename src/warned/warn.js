const params = new URLSearchParams(window.location.search);
const originalUrl = params.get("url") || "";
const domain = params.get("domain") || (() => {
  try { return new URL(originalUrl).hostname.replace(/^www\./i, ""); } catch { return ""; }
})();

document.getElementById("blockedUrl").textContent = domain || originalUrl || "Domínio desconhecido";

const now = new Date();
document.getElementById("timestamp").textContent =
  `Aviso exibido em ${now.toLocaleDateString("pt-BR")} às ${now.toLocaleTimeString("pt-BR")}`;

window.goBack = function () {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.href = "https://google.com";
  }
};

window.continueAnyway = async function () {
  const btn = document.getElementById("btnContinue");
  btn.disabled = true;
  btn.textContent = "Aguardando...";
  try {
    await chrome.runtime.sendMessage({
      type: "WARN_BYPASS",
      domain,
      url: originalUrl,
    });
    // A navegação será feita pelo service worker
  } catch (e) {
    // Fallback: navega diretamente
    if (originalUrl) window.location.href = originalUrl;
  }
};

// Registra evento de aviso no backend
try {
  chrome.runtime.sendMessage({
    type: "BLOCK_ATTEMPT",
    url: originalUrl,
    domain,
    reason: "warn_page_shown",
  });
} catch (_) {}
