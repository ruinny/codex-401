import { ApiRequestError } from '@/lib/server/api-error';

export const DEFAULT_TIMEOUT_SECONDS = 12;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 120;

export interface ProbePayload {
  authIndex?: string | number;
  method: 'GET';
  url: 'https://chatgpt.com/backend-api/wham/usage';
  header: Record<string, string>;
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const ALLOWED_PROBE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

const readAllowedBaseHosts = (): string[] => {
  const raw = process.env.ALLOWED_BASE_HOSTS;
  if (!raw) return [];

  return raw
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
};

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

export const clampInteger = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, Math.floor(value)));
};

export const parseRequiredString = (value: unknown, fieldName: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiRequestError(`${fieldName} 不能为空`, 400, 'INVALID_INPUT');
  }

  return value.trim();
};

export const parseBaseUrl = (value: unknown): string => {
  const raw = parseRequiredString(value, 'baseUrl');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ApiRequestError('baseUrl 格式无效', 400, 'INVALID_BASE_URL');
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new ApiRequestError('baseUrl 仅支持 http/https', 400, 'INVALID_BASE_URL_PROTOCOL');
  }

  const allowlist = readAllowedBaseHosts();
  if (allowlist.length > 0 && !allowlist.includes(parsed.hostname.toLowerCase())) {
    throw new ApiRequestError('baseUrl 不在允许的主机列表中', 403, 'BASE_URL_NOT_ALLOWED');
  }

  return parsed.origin;
};

export const parseTimeoutSeconds = (
  value: unknown,
  fallback = DEFAULT_TIMEOUT_SECONDS,
  min = MIN_TIMEOUT_SECONDS,
  max = MAX_TIMEOUT_SECONDS
): number => {
  const parsed = toFiniteNumber(value);
  const withFallback = parsed === null ? fallback : parsed;

  return clampInteger(withFallback, min, max);
};

export const parseProbePayload = (value: unknown): ProbePayload => {
  if (!isRecord(value)) {
    throw new ApiRequestError('payload 必须是对象', 400, 'INVALID_PAYLOAD');
  }

  const method = parseRequiredString(value.method, 'payload.method').toUpperCase();
  if (method !== 'GET') {
    throw new ApiRequestError('payload.method 仅支持 GET', 400, 'INVALID_PAYLOAD_METHOD');
  }

  const url = parseRequiredString(value.url, 'payload.url');
  if (url !== ALLOWED_PROBE_URL) {
    throw new ApiRequestError('payload.url 非允许目标地址', 400, 'INVALID_PAYLOAD_URL');
  }

  if (!isRecord(value.header)) {
    throw new ApiRequestError('payload.header 必须是对象', 400, 'INVALID_PAYLOAD_HEADER');
  }

  const header: Record<string, string> = {};
  for (const [key, val] of Object.entries(value.header)) {
    if (typeof val !== 'string') {
      throw new ApiRequestError(`payload.header.${key} 必须是字符串`, 400, 'INVALID_PAYLOAD_HEADER');
    }
    header[key] = val;
  }

  const authIndexRaw = value.authIndex;
  let authIndex: string | number | undefined;
  if (typeof authIndexRaw === 'string' || typeof authIndexRaw === 'number') {
    authIndex = authIndexRaw;
  } else if (authIndexRaw !== undefined && authIndexRaw !== null) {
    throw new ApiRequestError('payload.authIndex 类型无效', 400, 'INVALID_PAYLOAD_AUTH_INDEX');
  }

  return {
    authIndex,
    method: 'GET',
    url: ALLOWED_PROBE_URL,
    header,
  };
};
