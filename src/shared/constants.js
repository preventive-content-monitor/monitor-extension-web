// GERADO AUTOMATICAMENTE pelo Terraform — não edite manualmente.
// Edite monitor-extension-web/src/shared/constants.js.tpl e rode `terraform apply`.

// Backend API (Spring Boot EC2 - autenticação, política, dispositivos)
export const API_BASE_URL = "http://184.72.167.216";

// Events API (API Gateway → SQS → Lambda - envio de eventos)
export const EVENTS_API_URL = "https://eg6eybtnf9.execute-api.us-east-1.amazonaws.com/";

// Blocklist via S3 publico (gerado pelo deploy-front.ps1 a partir dos outputs do Terraform S3)
// CloudFront nao esta disponivel no AWS Academy (role voclabs nao tem cloudfront:CreateDistribution).
// O bucket S3 esta configurado como publico com CORS habilitado para acesso pela extensao Chrome.
export const S3_BLACKLIST_URL = "https://guardian-blocklist-tcc-a7f3.s3.us-east-1.amazonaws.com/blackList.json";

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
