/**
 * Script da página de bloqueio
 * - Exibe a URL bloqueada
 * - Registra o evento no backend
 */

import { lerParametrosIntercepcao } from "../shared/paramsIntercepcao.js";

const { url: blockedUrl, domain, mode } = lerParametrosIntercepcao();

// Extrai o domínio (o helper já tenta; aqui cobre o caso de texto simples)
let blockedDomain = domain;
if (!blockedDomain) {
  try {
    blockedDomain = new URL(blockedUrl).hostname;
  } catch (e) {
    // URL inválida — pode ser texto simples no modo whitelist
    blockedDomain = blockedUrl || "desconhecido";
  }
}

document.getElementById("blockedUrl").textContent = blockedDomain;

// Atualiza mensagem para modo whitelist
if (mode === "whitelist") {
  const reasonBox = document.querySelector(".info-box");
  if (reasonBox) {
    reasonBox.innerHTML = `
      <h3>🔒 Por que este site foi bloqueado?</h3>
      <p>
        Seu responsável configurou uma lista de sites permitidos.
        <strong>Apenas os sites dessa lista podem ser acessados.</strong>
        Este site não está na lista de sites permitidos.
      </p>
    `;
  }
}

// Timestamp
const now = new Date();
document.getElementById("timestamp").textContent =
  `Bloqueado em ${now.toLocaleDateString("pt-BR")} às ${now.toLocaleTimeString("pt-BR")}`;

function goBack() {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.href = "https://google.com";
  }
}

// addEventListener em vez de onclick inline: o CSP padrão do Manifest V3
// (script-src 'self') bloqueia handlers inline, deixando o botão inerte.
document.getElementById("btnBack").addEventListener("click", goBack);

// Registra o evento de bloqueio no backend
async function registerBlockEvent() {
  try {
    await chrome.runtime.sendMessage({
      type: "BLOCK_ATTEMPT",
      url: blockedUrl,
      domain: blockedDomain,
      reason: mode === "whitelist" ? "not_in_allowlist" : "domain_blocked",
    });
    console.log("[Guardian] Evento de bloqueio registrado");
  } catch (error) {
    console.error("[Guardian] Erro ao registrar bloqueio:", error);
  }
}

registerBlockEvent();
