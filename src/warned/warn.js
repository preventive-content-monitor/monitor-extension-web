import { lerParametrosIntercepcao } from "../shared/paramsIntercepcao.js";

const { url: originalUrl, domain } = lerParametrosIntercepcao();

document.getElementById("blockedUrl").textContent =
  domain || originalUrl || "Domínio desconhecido";

const now = new Date();
document.getElementById("timestamp").textContent =
  `Aviso exibido em ${now.toLocaleDateString("pt-BR")} às ${now.toLocaleTimeString("pt-BR")}`;

function goBack() {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.href = "https://google.com";
  }
}

async function continueAnyway() {
  const btn = document.getElementById("btnContinue");
  btn.disabled = true;
  btn.textContent = "Aguardando...";

  try {
    await chrome.runtime.sendMessage({
      type: "WARN_BYPASS",
      domain,
      url: originalUrl,
    });
    // O service worker libera o domínio no DNR e navega de volta.
    // Se por algum motivo não navegar, o fallback abaixo garante a saída.
    setTimeout(() => {
      if (originalUrl && document.visibilityState !== "hidden") {
        window.location.href = originalUrl;
      }
    }, 1200);
  } catch (e) {
    if (originalUrl) window.location.href = originalUrl;
  }
}

// addEventListener em vez de onclick inline: o CSP padrão do Manifest V3
// (script-src 'self') bloqueia handlers inline, deixando os botões inertes.
document.getElementById("btnBack").addEventListener("click", goBack);
document.getElementById("btnContinue").addEventListener("click", continueAnyway);

// Registra evento de aviso no backend
try {
  chrome.runtime.sendMessage({
    type: "BLOCK_ATTEMPT",
    url: originalUrl,
    domain,
    reason: "warn_page_shown",
  });
} catch (_) {}
