import axios from 'axios';

export interface ApiErrorShape {
  message: string;
  status: number;
  code: string;
}

export class ApiRequestError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

const extractMessage = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const message = (value as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim()) {
    return message;
  }

  const error = (value as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (error && typeof error === 'object') {
    const nestedMessage = (error as { message?: unknown }).message;
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage;
    }
  }

  return null;
};

export const toApiError = (error: unknown): ApiErrorShape => {
  if (error instanceof ApiRequestError) {
    return {
      message: error.message,
      status: error.status,
      code: error.code,
    };
  }

  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? 502;
    const upstreamMessage = extractMessage(error.response?.data);

    return {
      message: upstreamMessage || error.message || '上游服务请求失败',
      status,
      code: 'UPSTREAM_REQUEST_FAILED',
    };
  }

  if (error instanceof SyntaxError) {
    return {
      message: '请求体 JSON 格式错误',
      status: 400,
      code: 'INVALID_JSON',
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message || '服务器内部错误',
      status: 500,
      code: 'INTERNAL_ERROR',
    };
  }

  return {
    message: '服务器内部错误',
    status: 500,
    code: 'INTERNAL_ERROR',
  };
};
