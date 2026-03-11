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
 * Vincula este dispositivo usando código do responsável
 * @param {string} code - Código de 6 caracteres gerado pelo responsável
 * @param {string} deviceName - Nome amigável do dispositivo
 * @param {string} baseUrl - URL do backend
 * @returns {Promise<{deviceId: string, dependentNickname: string}>}
 */
export async function enrollWithCode(code, deviceName, baseUrl) {
  const result = await apiEnroll(code, deviceName, baseUrl);
  
  // Salva o deviceId retornado pelo backend
  await chrome.storage.local.set({ deviceId: result.id });
  
  // Salva dados de enrollment no sync storage
  await chrome.storage.sync.set({
    deviceId: result.id,
    deviceName: result.deviceName,
    enrolledAt: result.enrolledAt,
    dependentNickname: result.dependent?.nickname || "",
    // Habilita upload de eventos após enrollment
    uploadEnabled: true,
    backendUrl: baseUrl,
  });

  return {
    deviceId: result.id,
    dependentNickname: result.dependent?.nickname || "",
  };
}

/**
 * Verifica se o dispositivo está vinculado ao backend
 */
export async function isEnrolled() {
  const { enrolledAt } = await chrome.storage.sync.get(["enrolledAt"]);
  return !!enrolledAt;
}

/**
 * Remove vinculação (para re-vincular a outro dependente)
 */
export async function clearEnrollment() {
  await chrome.storage.local.remove(["deviceId"]);
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
  return {
    deviceId: data.deviceId || "",
    deviceName: data.deviceName || "",
    enrolledAt: data.enrolledAt || null,
    dependentNickname: data.dependentNickname || "",
    isEnrolled: !!data.enrolledAt,
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
