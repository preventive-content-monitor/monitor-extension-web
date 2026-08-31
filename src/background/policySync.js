import { getSettings } from "./policyStore.js";
import { isEnrolled } from "./deviceIdentity.js";
import { fetchPolicy } from "./apiClient.js";
import { API_BASE_URL, POLICY_MODES } from "../shared/constants.js";
import { syncBlocklistToDNR } from "./dnrRules.js";
import { getS3Blacklist } from "./blocklistSync.js";

export const POLICY_CACHE_KEY = "cachedPolicy";
const POLICY_CACHE_TTL = 15 * 1000; // 15 segundos

/**
 * Busca política do backend
 * Faz fallback para política local se falhar
 */
export async function syncPolicy() {
  const s = await getSettings();

  if (!(await isEnrolled()) || !s.deviceId) {
    return null;
  }

  try {
    // Tenta buscar do backend
    const backendPolicy = await fetchPolicy(
      s.deviceId,
      s.backendUrl || API_BASE_URL,
    );

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

    const dependentNickname =
      typeof backendPolicy.nomeDependente === "string"
        ? backendPolicy.nomeDependente.trim()
        : "";

    // Mantem o nome do dependente atualizado para exibir corretamente na options page
    if (dependentNickname) {
      const { dependentNickname: currentNickname } =
        await chrome.storage.sync.get(["dependentNickname"]);
      if (currentNickname !== dependentNickname) {
        await chrome.storage.sync.set({ dependentNickname });
      }
    }

    console.log(
      "[Guardian] Parsed policy - blocked:",
      blockedDomains,
      "allowed:",
      allowedDomains,
      "enabled:",
      protectionEnabled,
    );

    // IMPORTANTE: Atualiza o DNR com a blocklist do backend + S3 blacklist
    const s3Blocked = await getS3Blacklist();
    const policyMode = backendPolicy.mode || POLICY_MODES.BLOCK;

    // Modo BLOCK: DNR bloqueia domínios do responsável + S3 blacklist (score >= 70)
    // Modo WARN/EDUCATE: DNR usa apenas S3 blacklist (conteúdo globalmente perigoso)
    //   → domínios da política são tratados em _verificarEBloquearUrl (bypassável pelo usuário)
    //
    // NOTA: A S3 whitelist NÃO é usada aqui. Motivos:
    //  1. Ela causaria bug: poderia remover bloqueios explícitos do responsável
    //  2. Ela não é necessária: a blacklist já contém só conteúdo score >= 70
    //  3. Ela cresceria indefinidamente (todo site safe vira entrada)
    //  A whitelist existe apenas no backend (para cache de classificação e /api/blocklist/verificar)
    const dnrDomains = policyMode === POLICY_MODES.BLOCK
      ? [...new Set([...blockedDomains, ...s3Blocked])]
      : [...s3Blocked];

    // allowedDomains do DNR = APENAS a lista explícita do responsável (backend).
    await syncBlocklistToDNR(dnrDomains, protectionEnabled, allowedDomains, policyMode);
    console.log("[Guardian] DNR updated successfully, mode:", policyMode);

    // Cache: blockedDomains = backend + S3 blacklist (para _verificarEBloquearUrl em SPAs)
    //        allowedDomains = APENAS backend (S3 whitelist não deve bypassar política do dispositivo)
    const result = {
      mode: policyMode,
      riskThreshold: backendPolicy.riskThreshold || 50,
      blockedDomains: [...new Set([...blockedDomains, ...s3Blocked])],
      allowedDomains,
      protectionEnabled,
      nomeDependente: dependentNickname,
      schoolModeEnabled: backendPolicy.schoolModeEnabled || false,
      schoolStart: backendPolicy.schoolStart || "07:00",
      schoolEnd: backendPolicy.schoolEnd || "17:00",
      fromBackend: true,
    };

    // Salva no cache — garante que _verificarEBloquearUrl sempre lê política atualizada
    await chrome.storage.local.set({
      [POLICY_CACHE_KEY]: { policy: result, timestamp: Date.now() },
    });

    return result;
  } catch (e) {
    console.warn(
      "[Guardian] Failed to fetch policy from backend, using local:",
      e.message,
    );
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
  const { [POLICY_CACHE_KEY]: cached } = await chrome.storage.local.get([
    POLICY_CACHE_KEY,
  ]);

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
    const isAllowed = policy.allowedDomains.some((d) => {
      const domain = d.replace(/^www\./, "").toLowerCase();
      return hostname === domain || hostname.endsWith("." + domain);
    });

    if (isAllowed) {
      return { blocked: false, reason: "allowlisted" };
    }

    // Depois verifica blocklist
    const isBlocked = policy.blockedDomains.some((d) => {
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
