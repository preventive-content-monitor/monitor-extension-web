import { getSettings } from "./policyStore.js";
import { isEnrolled } from "./deviceIdentity.js";
import { fetchPolicy } from "./apiClient.js";
import { API_BASE_URL, POLICY_MODES } from "../shared/constants.js";
import { syncBlocklistToDNR } from "./dnrRules.js";

const POLICY_CACHE_KEY = "cachedPolicy";
const POLICY_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

/**
 * Busca política do backend
 * Faz fallback para política local se falhar
 */
export async function syncPolicy() {
  const s = await getSettings();
  
  if (!await isEnrolled() || !s.deviceId) {
    return null;
  }

  try {
    // Tenta buscar do backend
    const backendPolicy = await fetchPolicy(s.deviceId, s.backendUrl || API_BASE_URL);
    
    console.log("[Guardian] Policy from backend:", backendPolicy);
    
    // Parse blockedDomains (pode vir como string JSON do backend)
    let blockedDomains = [];
    if (typeof backendPolicy.blockedDomains === "string") {
      try {
        blockedDomains = JSON.parse(backendPolicy.blockedDomains);
      } catch {
        blockedDomains = [];
      }
    } else if (Array.isArray(backendPolicy.blockedDomains)) {
      blockedDomains = backendPolicy.blockedDomains;
    }
    
    // Parse allowedDomains (pode vir como string JSON do backend)
    let allowedDomains = [];
    if (typeof backendPolicy.allowedDomains === "string") {
      try {
        allowedDomains = JSON.parse(backendPolicy.allowedDomains);
      } catch {
        allowedDomains = [];
      }
    } else if (Array.isArray(backendPolicy.allowedDomains)) {
      allowedDomains = backendPolicy.allowedDomains;
    }
    
    // protectionEnabled pode não vir do backend - assume true por padrão
    const protectionEnabled = backendPolicy.protectionEnabled !== false;
    
    console.log("[Guardian] Parsed policy - blocked:", blockedDomains, "allowed:", allowedDomains, "enabled:", protectionEnabled);
    
    // IMPORTANTE: Atualiza o DNR com a blocklist/allowlist do backend
    await syncBlocklistToDNR(blockedDomains, protectionEnabled, allowedDomains);
    console.log("[Guardian] DNR updated successfully");
    
    // Converte para formato interno
    return {
      mode: backendPolicy.mode || POLICY_MODES.BLOCK,
      riskThreshold: backendPolicy.riskThreshold || 50,
      blockedDomains,
      allowedDomains,
      protectionEnabled,
      schoolModeEnabled: backendPolicy.schoolModeEnabled || false,
      schoolStart: backendPolicy.schoolStart || "07:00",
      schoolEnd: backendPolicy.schoolEnd || "17:00",
      fromBackend: true,
    };
  } catch (e) {
    console.warn("[Guardian] Failed to fetch policy from backend, using local:", e.message);
    // Fallback para política local
    return buildLocalPolicy(s);
  }
}

/**
 * Constrói política local baseada nas configurações do usuário
 */
function buildLocalPolicy(settings) {
  let mode = POLICY_MODES.BLOCK;
  
  switch (settings.actionOnHighRisk) {
    case "warn":
      mode = POLICY_MODES.WARN;
      break;
    case "educate":
      mode = POLICY_MODES.EDUCATE;
      break;
    default:
      mode = POLICY_MODES.BLOCK;
  }

  return {
    mode,
    riskThreshold: settings.sensitivity || 70,
    blockedDomains: settings.blocklistDomains || [],
    allowedDomains: settings.allowlistDomains || [],
  };
}

/**
 * Obtém política atual (cache ou recalcula)
 */
export async function getCurrentPolicy() {
  const { [POLICY_CACHE_KEY]: cached } = await chrome.storage.local.get([POLICY_CACHE_KEY]);
  
  if (cached && Date.now() - cached.timestamp < POLICY_CACHE_TTL) {
    return cached.policy;
  }

  const policy = await syncPolicy();
  
  if (policy) {
    await chrome.storage.local.set({
      [POLICY_CACHE_KEY]: {
        policy,
        timestamp: Date.now(),
      },
    });
  }

  return policy;
}

/**
 * Verifica se uma URL deve ser bloqueada
 */
export async function shouldBlockUrl(url) {
  try {
    const policy = await getCurrentPolicy();
    if (!policy) return { blocked: false };

    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();

    // Primeiro verifica allowlist
    const isAllowed = policy.allowedDomains.some(d => {
      const domain = d.replace(/^www\./, "").toLowerCase();
      return hostname === domain || hostname.endsWith("." + domain);
    });

    if (isAllowed) {
      return { blocked: false, reason: "allowlisted" };
    }

    // Depois verifica blocklist
    const isBlocked = policy.blockedDomains.some(d => {
      const domain = d.replace(/^www\./, "").toLowerCase();
      return hostname === domain || hostname.endsWith("." + domain);
    });

    if (isBlocked) {
      if (policy.mode === POLICY_MODES.BLOCK) {
        return { blocked: true, reason: "domain_blocked" };
      } else if (policy.mode === POLICY_MODES.WARN) {
        return { blocked: false, warn: true, reason: "domain_flagged" };
      }
    }

    return { blocked: false };
  } catch (e) {
    console.warn("shouldBlockUrl error:", e);
    return { blocked: false };
  }
}

/**
 * Invalida cache de política (forçar nova sincronização)
 */
export async function invalidatePolicyCache() {
  await chrome.storage.local.remove([POLICY_CACHE_KEY]);
}
