// GERADO AUTOMATICAMENTE pelo Terraform — não edite manualmente.
// Edite monitor-extension-web/src/shared/constants.js.tpl e rode `terraform apply`.

// Backend API (Spring Boot EC2 - autenticação, política, dispositivos)
export const API_BASE_URL = "${api_base_url}";

// Events API (API Gateway → SQS → Lambda - envio de eventos)
export const EVENTS_API_URL = "${events_api_url}";

// Blocklist via CloudFront CDN (gerado pelo deploy-front.ps1 a partir dos outputs do Terraform S3)
// NAO usar a URL do S3 diretamente — com 1000+ usuarios causaria sobrecarga.
// CloudFront serve do edge mais proximo e o S3 recebe apenas 1 requisicao por TTL (5 min).
export const S3_BLACKLIST_URL = "${cloudfront_blacklist_url}";

// Tipos de evento compatíveis com o backend Guardian
export const EVENT_TYPES = {
  NAVIGATION: "NAVIGATION",
  BLOCK_ATTEMPT: "BLOCK_ATTEMPT",
  PERMISSION_REQUEST: "PERMISSION_REQUEST",
  // Legacy (local only)
  SEARCH_QUERY: "SEARCH_QUERY",
};

// Modos de política do backend
export const POLICY_MODES = {
  BLOCK: "BLOCK",
  WARN: "WARN",
  EDUCATE: "EDUCATE",
};

// Thresholds de risco
export const RISK_THRESHOLDS = {
  LOW: 30,
  MEDIUM: 50,
  HIGH: 70,
  CRITICAL: 90,
};

export const DEFAULT_SETTINGS = {
  backendUrl: API_BASE_URL,
  uploadEnabled: false,
  uploadIntervalSec: 30,

  childProfile: "10-14",
  sensitivity: 70, // 0..100
  actionOnHighRisk: "block", // block | warn | educate

  // Policies
  protectionEnabled: true,
  blocklistDomains: ["pornhub.com", "xvideos.com"],
  allowlistDomains: [],
  urlPatternsBlock: [],
  schoolModeEnabled: false,
  schoolModeSchedule: {
    days: ["mon", "tue", "wed", "thu", "fri"],
    start: "07:00",
    end: "17:00",
  },

  // Privacy
  dataMinimization: "metadata",
  maskSearchQueries: true,
  retentionDays: 15,

  // IA-ready
  remoteClassificationEnabled: false,
  classifyEndpointPath: "/classify",

  // Device enrollment (Guardian Backend)
  deviceId: "",
  deviceName: "",
  enrolledAt: null,
  dependentNickname: "",
};
