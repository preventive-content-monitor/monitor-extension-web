import { API_BASE_URL } from "../shared/constants.js";

function buildUrl(baseUrl, path) {
  return `${(baseUrl || API_BASE_URL).replace(/\/+$/, "")}${path}`;
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
 * POST /api/autenticacao/entrar
 */
export async function loginUser(email, password, baseUrl) {
  const url = buildUrl(baseUrl, "/api/autenticacao/entrar");

  console.log("[Guardian] Logging in:", email);

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

  return await res.json(); // { token: "..." }
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
  const url = buildUrl(baseUrl, "/api/eventos/lote");

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

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

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
export async function enrollDevice(code, deviceName, baseUrl) {
  const url = buildUrl(baseUrl, "/api/dispositivos/vincular");

  console.log("[Guardian] Enrolling device:", { code, deviceName, url });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codigo: code, nomeDispositivo: deviceName }),
  });

  if (!res.ok) {
    const errorMessage = await readErrorPayload(res);
    throw new Error(errorMessage || `Enrollment failed: ${res.status}`);
  }

  return await res.json();
}

/**
 * Busca política atual para o dispositivo
 * GET /api/politica/atual?dispositivoId=...
 * Endpoint público (sem autenticação)
 */
export async function fetchPolicy(deviceId, baseUrl) {
  const url = buildUrl(
    baseUrl,
    `/api/politica/atual?dispositivoId=${encodeURIComponent(deviceId)}`,
  );

  console.log("[Guardian] Fetching policy:", url);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

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
