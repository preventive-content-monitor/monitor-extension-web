import { normalizeDomain } from "./policyStore.js";

const RULESET_ID_BASE = 1000;
const WHITELIST_RULE_ID = 999; // ID especial para a regra "bloquear tudo"

// URL da página de bloqueio da extensão
const BLOCKED_PAGE_BASE = chrome.runtime.getURL('src/blocked/blocked.html');

/**
 * Sincroniza regras de bloqueio/permissão com o DNR
 * @param {string[]} blockedDomains - Domínios a bloquear (modo blacklist)
 * @param {string[]} allowedDomains - Domínios permitidos (modo whitelist)
 * @param {boolean} enabled - Se a proteção está habilitada
 */
export async function syncBlocklistToDNR(blockedDomains = [], enabled = true, allowedDomains = []) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const toRemove = existing
    .filter((r) => r.id >= WHITELIST_RULE_ID && r.id < RULESET_ID_BASE + 10000)
    .map((r) => r.id);

  // Sempre remove o que a gente gerou antes
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: toRemove,
    addRules: [],
  });

  // Se estiver desabilitado, para aqui (sem adicionar nada)
  if (!enabled) {
    console.log("[Guardian DNR] Proteção desabilitada");
    return;
  }

  const cleanedAllowed = [...new Set(allowedDomains.map(normalizeDomain).filter(Boolean))];
  const cleanedBlocked = [...new Set(blockedDomains.map(normalizeDomain).filter(Boolean))];

  let newRules = [];

  // MODO WHITELIST: Se tem allowedDomains, bloqueia TUDO exceto esses sites
  if (cleanedAllowed.length > 0) {
    console.log("[Guardian DNR] Modo WHITELIST ativo - apenas permitidos:", cleanedAllowed);
    
    // Estratégia: Uma única regra que bloqueia tudo EXCETO os domínios permitidos
    // Usa excludedRequestDomains para a whitelist - muito mais confiável que regexFilter
    newRules.push({
      id: WHITELIST_RULE_ID,
      priority: 1,
      action: { 
        type: "redirect",
        redirect: {
          url: `${BLOCKED_PAGE_BASE}?url=site-nao-permitido&mode=whitelist`
        }
      },
      condition: {
        urlFilter: "|http", // Matcha qualquer URL que começa com http (inclui https)
        excludedRequestDomains: cleanedAllowed, // EXCETO estes domínios
        resourceTypes: ["main_frame"],
      },
    });
    
    console.log("[Guardian DNR] Regra whitelist criada - bloqueando tudo exceto:", cleanedAllowed);

  } else if (cleanedBlocked.length > 0) {
    // MODO BLACKLIST: Bloqueia apenas os domínios específicos
    console.log("[Guardian DNR] Modo BLACKLIST ativo - bloqueados:", cleanedBlocked);
    
    newRules = cleanedBlocked.slice(0, 5000).map((d, idx) => ({
      id: RULESET_ID_BASE + idx,
      priority: 1,
      action: { 
        type: "redirect",
        redirect: {
          url: `${BLOCKED_PAGE_BASE}?url=https://${d}`
        }
      },
      condition: {
        requestDomains: [d],
        resourceTypes: ["main_frame"],
      },
    }));
  }

  if (newRules.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [],
      addRules: newRules,
    });
    console.log("[Guardian DNR] Aplicadas", newRules.length, "regras");
  }
}
