import { API_BASE_URL } from "../shared/constants.js";

function buildUrl(baseUrl, path) {
  const base = new URL(baseUrl || API_BASE_URL);
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  ) {
    throw new Error("O servidor deve usar HTTPS.");
  }
  return `${base.toString().replace(/\/+$/, "")}${path}`;
}

function extractApiErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback;
  return payload.mensagem || payload.message || payload.erro || fallback;
}

async function readErrorPayload(res) {
  const payload = await res.json().catch(() => null);
  return extractApiErrorMessage(payload, `Request failed: ${res.status}`);
}

/**
 * Autentica usuário e retorna JWT
 * POST /api/autenticacao/entrar-vinculo
 */
export async function loginUser(email, password, baseUrl) {
  const url = buildUrl(baseUrl, "/api/autenticacao/entrar-vinculo");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, senha: password }),
  });

  if (!res.ok) {
    const errorMessage = await readErrorPayload(res);
    if (res.status === 401) {
      throw new Error("Email ou senha incorretos");
    }
    throw new Error(errorMessage);
  }

  return await res.json();
}

export async function logoutUser(token, baseUrl) {
  if (!token) return;
  const res = await fetch(buildUrl(baseUrl, "/api/autenticacao/sair"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 401) {
    throw new Error("Não foi possível encerrar a autorização temporária.");
  }
}

export async function authorizeExistingDevice(deviceId, token, baseUrl) {
  const res = await fetch(buildUrl(baseUrl, `/api/dispositivos/${encodeURIComponent(deviceId)}/credencial`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await readErrorPayload(res));
  return await res.json();
}

let renewalPromise = null;

async function bearerJson(path, method, token, body, baseUrl) {
  const res = await fetch(buildUrl(baseUrl, path), {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await readErrorPayload(res));
  return res.status === 204 ? null : await res.json();
}

export async function getKeywordStatus(token, baseUrl) {
  const data = await bearerJson("/api/protecao/palavra-chave", "GET", token, null, baseUrl);
  return !!data?.definida;
}

export async function setKeyword(token, palavraChave, baseUrl) {
  await bearerJson("/api/protecao/palavra-chave", "PUT", token, { palavraChave }, baseUrl);
}

function tokenExpiration(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(payload));
    if (!Number.isFinite(claims.exp)) throw new Error("expiração ausente");
    return claims.exp * 1000;
  } catch (error) {
    throw new Error("A autorização do dispositivo é inválida. Entre novamente para atualizá-la.");
  }
}

async function getDeviceToken(baseUrl) {
  const { deviceToken } = await chrome.storage.local.get(["deviceToken"]);
  if (!deviceToken) throw new Error("Entre na extensão para autorizar este dispositivo.");
  const expiration = tokenExpiration(deviceToken);
  if (expiration <= Date.now()) {
    await chrome.storage.local.remove(["deviceToken"]);
    throw new Error("A autorização do dispositivo expirou. Entre novamente na extensão.");
  }
  if (expiration - Date.now() > 30 * 24 * 60 * 60 * 1000) return deviceToken;
  if (!renewalPromise) {
    renewalPromise = (async () => {
      const res = await fetch(buildUrl(baseUrl, "/api/dispositivos/renovar-credencial"), {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceToken}` },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) await chrome.storage.local.remove(["deviceToken"]);
        throw new Error("Não foi possível renovar a autorização do dispositivo.");
      }
      const data = await res.json();
      if (!data.token) throw new Error("O servidor não retornou a nova autorização do dispositivo.");
      await chrome.storage.local.set({ deviceToken: data.token });
      return data.token;
    })().finally(() => { renewalPromise = null; });
  }
  return await renewalPromise;
}

export async function authenticatedDeviceFetch(path, options, baseUrl) {
  const token = await getDeviceToken(baseUrl);
  const res = await fetch(buildUrl(baseUrl, path), {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    await chrome.storage.local.remove(["deviceToken"]);
    throw new Error("A autorização do dispositivo não é mais válida. Entre novamente na extensão.");
  }
  return res;
}

/**
 * Registra novo usuário
 * POST /api/autenticacao/registrar
 */
export async function registerUser(email, password, baseUrl) {
  const url = buildUrl(baseUrl, "/api/autenticacao/registrar");

  console.log("[Guardian] Registering:", email);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, senha: password }),
  });

  if (!res.ok) {
    const errorMessage = await readErrorPayload(res);
    if (res.status === 409) {
      throw new Error("Este email já está cadastrado");
    }
    throw new Error(errorMessage);
  }

  return true;
}

/**
 * Envia lote de eventos para o backend Guardian
 * POST /api/eventos/lote
 */
export async function postEventsBatch(deviceId, events, baseUrl) {
  const toBackendEventType = (eventType) => {
    if (eventType === "BLOCK_ATTEMPT") return "BLOCK_ATTEMPT";
    if (eventType === "PERMISSION_REQUEST") return "PERMISSION_REQUEST";
    return "NAVIGATION";
  };

  const payload = {
    dispositivoId: deviceId,
    eventos: events.map((e) => ({
      tipo: toBackendEventType(e.type),
      url: e.url,
      titulo: e.title || "",
      ocorridoEm: e.occurredAt || new Date(e.ts).toISOString(),
      metadados: e.metadata || {},
    })),
  };

  const res = await authenticatedDeviceFetch("/api/eventos/lote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, baseUrl);

  if (!res.ok) {
    const errorMessage = await readErrorPayload(res);
    throw new Error(
      `POST /api/eventos/lote failed: ${res.status} ${errorMessage}`,
    );
  }

  return await res.json();
}

/**
 * Vincula dispositivo usando código de enrollment
 * POST /api/dispositivos/vincular
 */
export async function enrollDevice(code, deviceName, baseUrl, token) {
  const url = buildUrl(baseUrl, "/api/dispositivos/vincular");
  if (!token) throw new Error("Confirme a conta do responsável antes de vincular.");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ codigo: code, nomeDispositivo: deviceName }),
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error("A autorização temporária expirou. Entre novamente.");
    const errorMessage = await readErrorPayload(res);
    throw new Error(errorMessage || `Enrollment failed: ${res.status}`);
  }

  return await res.json();
}

/**
 * Busca política atual para o dispositivo
 * GET /api/politica/atual?dispositivoId=...
 * Requer a credencial limitada do dispositivo.
 */
export async function fetchPolicy(deviceId, baseUrl) {
  const res = await authenticatedDeviceFetch(`/api/politica/atual?dispositivoId=${encodeURIComponent(deviceId)}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  }, baseUrl);

  if (!res.ok) {
    const errorMessage = await readErrorPayload(res);
    throw new Error(
      `GET /api/politica/atual failed: ${res.status} ${errorMessage}`,
    );
  }

  const policy = await res.json();

  let blockedDomains = [];
  if (typeof policy.dominiosBloqueados === "string") {
    try {
      blockedDomains = JSON.parse(policy.dominiosBloqueados);
    } catch {
      blockedDomains = [];
    }
  }

  let allowedDomains = [];
  if (typeof policy.dominiosPermitidos === "string") {
    try {
      allowedDomains = JSON.parse(policy.dominiosPermitidos);
    } catch {
      allowedDomains = [];
    }
  }

  return {
    ...policy,
    blockedDomains: Array.isArray(blockedDomains) ? blockedDomains : [],
    allowedDomains: Array.isArray(allowedDomains) ? allowedDomains : [],
    riskThreshold: policy.limiteRisco ?? 50,
    // Mapeia "modo" (backend Kotlin enum) → "mode" (extensão JS)
    mode: policy.modo || "BLOCK",
    schoolModeEnabled: policy.modoEscolaAtivo === true,
    schoolStart: policy.escolaInicio || "07:00",
    schoolEnd: policy.escolaFim || "17:00",
  };
}

/**
 * Atualiza política no backend
 * PUT /api/politica?dispositivoId=...
 * Requer JWT token
 */
export async function updatePolicy(deviceId, policyData, token, baseUrl) {
  const url = buildUrl(
    baseUrl,
    `/api/politica?dispositivoId=${encodeURIComponent(deviceId)}`,
  );

  console.log("[Guardian] Updating policy:", url, policyData);

  if (!token) {
    throw new Error("Token JWT necessário para atualizar política");
  }

  const payload = {
    modo: policyData.mode,
    limiteRisco: policyData.riskThreshold,
    dominiosBloqueados: Array.isArray(policyData.blockedDomains)
      ? policyData.blockedDomains
      : [],
    dominiosPermitidos: Array.isArray(policyData.allowedDomains)
      ? policyData.allowedDomains
      : [],
    modoEscolaAtivo: policyData.schoolModeEnabled === true,
    escolaInicio: policyData.schoolStart || null,
    escolaFim: policyData.schoolEnd || null,
  };

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Sessão expirada. Faça login novamente.");
    }
    const errorMessage = await readErrorPayload(res);
    throw new Error(`PUT /api/politica failed: ${res.status} ${errorMessage}`);
  }

  return await res.json();
}

/**
 * Verifica saúde do backend
 */
export async function checkHealth(baseUrl = API_BASE_URL) {
  const url = `${baseUrl.replace(/\/+$/, "")}/v3/api-docs`;
  const res = await fetch(url, { method: "GET" });
  return { ok: res.ok, status: res.status };
}

// Legacy - mantido para compatibilidade
export async function postEvents(backendUrl, batch) {
  const url = `${backendUrl.replace(/\/+$/, "")}/events`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: batch }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`POST /events failed: ${res.status} ${txt}`);
  }
}
