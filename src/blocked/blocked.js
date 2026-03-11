/**
 * Script da página de bloqueio
 * - Exibe a URL bloqueada
 * - Registra o evento no backend
 */

// Pega a URL bloqueada dos parâmetros
const params = new URLSearchParams(window.location.search);
const blockedUrl = params.get('url') || 'URL desconhecida';
const mode = params.get('mode') || 'blacklist'; // blacklist ou whitelist

// Extrai o domínio
let blockedDomain = 'desconhecido';
try {
  blockedDomain = new URL(blockedUrl).hostname;
} catch (e) {
  // URL inválida - pode ser texto simples no modo whitelist
  blockedDomain = blockedUrl;
}

// Exibe a URL formatada
document.getElementById('blockedUrl').textContent = blockedDomain;

// Atualiza mensagem para modo whitelist
if (mode === 'whitelist') {
  const reasonBox = document.querySelector('.info-box');
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
document.getElementById('timestamp').textContent = 
  `Bloqueado em ${now.toLocaleDateString('pt-BR')} às ${now.toLocaleTimeString('pt-BR')}`;

// Função voltar
window.goBack = function() {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.href = 'https://google.com';
  }
};

// Registra o evento de bloqueio no backend
async function registerBlockEvent() {
  try {
    // Envia mensagem pro service worker registrar o evento
    await chrome.runtime.sendMessage({
      type: 'BLOCK_ATTEMPT',
      url: blockedUrl,
      domain: blockedDomain,
      reason: mode === 'whitelist' ? 'not_in_allowlist' : 'domain_blocked'
    });
    console.log('[Guardian] Evento de bloqueio registrado');
  } catch (error) {
    console.error('[Guardian] Erro ao registrar bloqueio:', error);
  }
}

// Registra o evento
registerBlockEvent();
