import { API_BASE_URL } from "../shared/constants.js";

/**
 * Autentica usuário e retorna JWT
 * POST /api/auth/login
 */
export async function loginUser(email, password, baseUrl) {
  const base = baseUrl || API_BASE_URL;
  const url = `${base.replace(/\/+$/, "")}/api/auth/login`;

  console.log("[Guardian] Logging in:", email);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    if (res.status === 401) {
      throw new Error("Email ou senha incorretos");
    }
    throw new Error(error.message || `Login failed: ${res.status}`);
  }

  return await res.json(); // { token: "..." }
}

/**
 * Registra novo usuário
 * POST /api/auth/register
 */
export async function registerUser(email, password, baseUrl) {
  const base = baseUrl || API_BASE_URL;
  const url = `${base.replace(/\/+$/, "")}/api/auth/register`;

  console.log("[Guardian] Registering:", email);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    if (res.status === 409) {
      throw new Error("Este email já está cadastrado");
    }
    throw new Error(error.message || `Register failed: ${res.status}`);
  }

  return true;
}

/**
 * Envia lote de eventos para o backend Guardian
 * POST /api/events/batch
 */
export async function postEventsBatch(deviceId, events, baseUrl) {
  const base = baseUrl || API_BASE_URL;
  const url = `${base.replace(/\/+$/, "")}/api/events/batch`;
  
  const payload = {
    deviceId,
    events: events.map(e => ({
      type: e.type,
      url: e.url,
      title: e.title || "",
      occurredAt: e.occurredAt || new Date(e.ts).toISOString(),
      metadata: e.metadata || null,
    })),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`POST /api/events/batch failed: ${res.status} ${txt}`);
  }

  return await res.json();
}

/**
 * Vincula dispositivo usando código de enrollment
 * POST /api/devices/enroll
 */
export async function enrollDevice(code, deviceName, baseUrl) {
  const base = baseUrl || API_BASE_URL;
  const url = `${base.replace(/\/+$/, "")}/api/devices/enroll`;

  console.log("[Guardian] Enrolling device:", { code, deviceName, url });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceName }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.message || `Enrollment failed: ${res.status}`);
  }

  return await res.json();
}

/**
 * Busca política atual para o dispositivo
 * GET /api/policy/current?deviceId=...
 * Endpoint público (sem autenticação)
 */
export async function fetchPolicy(deviceId, baseUrl) {
  const base = baseUrl || API_BASE_URL;
  const url = `${base.replace(/\/+$/, "")}/api/policy/current?deviceId=${deviceId}`;

  console.log("[Guardian] Fetching policy:", url);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GET /api/policy/current failed: ${res.status} ${txt}`);
  }

  const policy = await res.json();
  
  // Parse blockedDomains se vier como string JSON
  if (typeof policy.blockedDomains === "string") {
    try {
      policy.blockedDomains = JSON.parse(policy.blockedDomains);
    } catch {
      policy.blockedDomains = [];
    }
  }

  return policy;
}

/**
 * Atualiza política no backend
 * PUT /api/policy?deviceId=...
 * Requer JWT token
 */
export async function updatePolicy(deviceId, policyData, token, baseUrl) {
  const base = baseUrl || API_BASE_URL;
  const url = `${base.replace(/\/+$/, "")}/api/policy?deviceId=${deviceId}`;

  console.log("[Guardian] Updating policy:", url, policyData);

  if (!token) {
    throw new Error("Token JWT necessário para atualizar política");
  }

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(policyData),
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Sessão expirada. Faça login novamente.");
    }
    const txt = await res.text().catch(() => "");
    throw new Error(`PUT /api/policy failed: ${res.status} ${txt}`);
  }

  return await res.json();
}

/**
 * Verifica saúde do backend
 */
export async function checkHealth(baseUrl = API_BASE_URL) {
  const url = `${baseUrl.replace(/\/+$/, "")}/actuator/health`;
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
