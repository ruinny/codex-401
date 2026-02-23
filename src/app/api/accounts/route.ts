import { NextResponse } from 'next/server';
import axios from 'axios';

export async function POST(request: Request) {
  try {
    const { baseUrl, token, timeout } = await request.json();

    const response = await axios.get(`${baseUrl}/v0/management/auth-files`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
      timeout: (timeout || 12) * 1000,
    });

    return NextResponse.json(response.data);
  } catch (error: any) {
    console.error('Fetch accounts error:', error.message);
    return NextResponse.json(
      { error: error.response?.data || error.message },
      { status: error.response?.status || 500 }
    );
  }
}
