import { NextResponse } from 'next/server';
import axios from 'axios';

export async function POST(request: Request) {
  try {
    const { baseUrl, token, payload, timeout } = await request.json();

    const response = await axios.post(
      `${baseUrl}/v0/management/api-call`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        timeout: (timeout || 12) * 1000,
      }
    );

    return NextResponse.json(response.data);
  } catch (error: any) {
    // We return status code even on error if it's a 401 from the target,
    // but here we are talking about management API errors.
    console.error('Probe error:', error.message);
    return NextResponse.json(
      { error: error.response?.data || error.message },
      { status: error.response?.status || 500 }
    );
  }
}
