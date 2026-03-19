import path from 'node:path';

function boolFromEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null) {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

export const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || '/data'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:8080',
  jwtSecret: process.env.JWT_SECRET || 'dev-change-me',
  adminKey: process.env.ADMIN_KEY || '',
  aliModelEndpoint: process.env.ALI_MODEL_ENDPOINT || '',
  aliApiKey: process.env.ALI_API_KEY || '',
  aliVlmModel: process.env.ALI_VLM_MODEL || 'qwen3.5-plus',
  aliDisableThinking: boolFromEnv('ALI_DISABLE_THINKING', true),
  aliRequestTimeoutMs: Number(process.env.ALI_REQUEST_TIMEOUT_MS || 60000),
  aliMaxTokens: Number(process.env.ALI_MAX_TOKENS || 1200),
  pptSkill: process.env.PPT_SKILL || 'ide-rea/ai-ppt-generator',
  openclawBaseUrl: process.env.OPENCLAW_BASE_URL || '',
  openclawApiKey: process.env.OPENCLAW_API_KEY || '',
  openclawGatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || '',
  openclawPptTool: process.env.OPENCLAW_PPT_TOOL || 'skills_run',
  openclawPptToolArgSkillKey: process.env.OPENCLAW_PPT_TOOL_ARG_SKILL_KEY || 'skill',
  mockMode: boolFromEnv('MOCK_MODE', false)
};

export function resolveMockMode() {
  if (config.mockMode) {
    return true;
  }
  return !(config.aliModelEndpoint && config.aliApiKey);
}
