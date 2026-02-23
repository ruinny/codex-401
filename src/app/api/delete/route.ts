import { NextResponse } from 'next/server';
import axios from 'axios';

import {
  ApiRequestError,
  toApiError,
} from '@/lib/server/api-error';

import {
  isRecord,
  parseBaseUrl,
  parseRequiredString,
  parseTimeoutSeconds,
} from '@/lib/server/request-validation';

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) {
      throw new ApiRequestError('请求体必须是 JSON 对象', 400, 'INVALID_INPUT');
    }

    const baseUrl = parseBaseUrl(body.baseUrl);
    const token = parseRequiredString(body.token, 'token');
    const name = parseRequiredString(body.name, 'name');
    const timeout = parseTimeoutSeconds(body.timeout);

    const encodedName = encodeURIComponent(name);
    const response = await axios.delete(
      `${baseUrl}/v0/management/auth-files?name=${encodedName}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        timeout: timeout * 1000,
      }
    );

    return NextResponse.json(response.data);
  } catch (error: unknown) {
    const apiError = toApiError(error);
    console.error('Delete error:', apiError.message);
    return NextResponse.json(
      { error: apiError },
      { status: apiError.status }
    );
  }
}
