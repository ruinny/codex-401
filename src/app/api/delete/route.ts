import { NextResponse } from 'next/server';
import axios from 'axios';

export async function POST(request: Request) {
  try {
    const { baseUrl, token, name, timeout } = await request.json();

    const encodedName = encodeURIComponent(name);
    const response = await axios.delete(
      `${baseUrl}/v0/management/auth-files?name=${encodedName}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
        timeout: (timeout || 12) * 1000,
      }
    );

    return NextResponse.json(response.data);
  } catch (error: any) {
    console.error('Delete error:', error.message);
    return NextResponse.json(
      { error: error.response?.data || error.message },
      { status: error.response?.status || 500 }
    );
  }
}
