import { DEFAULT_SETTINGS } from "../shared/constants.js";
import { enrollDevice as apiEnroll } from "./apiClient.js";

/**
 * Garante que existe um deviceId local (fallback UUID)
 */
export async function ensureDeviceId() {
  const { deviceId } = await chrome.storage.local.get(["deviceId"]);
  if (deviceId) return deviceId;

  const newId = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: newId });
  return newId;
}

/**
 * Identidade do computador (perfil do Chrome). O site GuardIAn guarda uma cópia no
 * localStorage, que sobrevive à remoção da extensão; a cópia do site prevalece.
 */
const COMPUTER_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
export async function ensureComputerId(fromSite) {
  if (typeof fromSite === "string" && COMPUTER_ID_RE.test(fromSite)) {
    await chrome.storage.local.set({ computerId: fromSite });
    return fromSite;
  }
  const { computerId } = await chrome.storage.local.get(["computerId"]);
  if (computerId) return computerId;
  const novo = crypto.randomUUID();
  await chrome.storage.local.set({ computerId: novo });
  return novo;
}

/**
 * Vincula este dispositivo usando código do responsável
 * @param {string} code - Código de 6 caracteres gerado pelo responsável
 * @param {string} deviceName - Nome amigável do dispositivo
 * @param {string} baseUrl - URL do backend
 * @returns {Promise<{deviceId: string, dependentNickname: string}>}
 */
export async function enrollWithCode(code, deviceName, baseUrl, token, computerId = null) {
  const result = await apiEnroll(code, deviceName, baseUrl, token, computerId);
  if (!result.id || !result.tokenDispositivo) {
    throw new Error("O servidor não retornou a autorização do dispositivo.");
  }
  const enrolledAt = result.vinculadoEm || new Date().toISOString();

  await chrome.storage.local.set({ deviceId: result.id, deviceToken: result.tokenDispositivo });

  // Salva dados de enrollment no sync storage
  await chrome.storage.sync.set({
    deviceId: result.id,
    deviceName: result.nomeDispositivo || deviceName,
    enrolledAt,
    dependentNickname: result.apelidoDependente || "",
    // Habilita upload de eventos após enrollment
    uploadEnabled: true,
    backendUrl: baseUrl,
  });

  return {
    deviceId: result.id,
    dependentNickname: result.apelidoDependente || "",
  };
}

/**
 * Verifica se o dispositivo está vinculado ao backend
 */
export async function isEnrolled() {
  const info = await getEnrollmentInfo();
  return info.isEnrolled;
}

/**
 * Remove vinculação (para re-vincular a outro dependente)
 */
export async function clearEnrollment() {
  await chrome.storage.local.remove(["deviceId", "deviceToken"]);
  await chrome.storage.sync.set({
    deviceId: "",
    deviceName: "",
    enrolledAt: null,
    dependentNickname: "",
  });
}

/**
 * Obtém informações de enrollment atual
 */
export async function getEnrollmentInfo() {
  const data = await chrome.storage.sync.get([
    "deviceId",
    "deviceName",
    "enrolledAt",
    "dependentNickname",
  ]);
  const local = await chrome.storage.local.get(["deviceId", "deviceToken"]);
  const sameDevice = !!data.deviceId && local.deviceId === data.deviceId;
  return {
    deviceId: data.deviceId || "",
    deviceName: data.deviceName || "",
    enrolledAt: data.enrolledAt || null,
    dependentNickname: data.dependentNickname || "",
    isEnrolled: !!data.enrolledAt && sameDevice && !!local.deviceToken,
    needsAuthorization: !!data.enrolledAt && sameDevice && !local.deviceToken,
  };
}

/**
 * Gera nome do dispositivo automaticamente
 */
export function generateDeviceName() {
  const ua = navigator.userAgent;
  let browser = "Browser";
  let os = "Unknown";

  if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Edge")) browser = "Edge";

  if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Mac")) os = "macOS";
  else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("Android")) os = "Android";

  return `${browser} - ${os}`;
}

export async function ensureDefaults() {
  const current = await chrome.storage.sync.get(null);
  const merged = { ...DEFAULT_SETTINGS, ...current };

  if (!merged.deviceId) {
    merged.deviceId = await ensureDeviceId();
  }

  await chrome.storage.sync.set(merged);
  return merged;
}
