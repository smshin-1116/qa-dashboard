import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  const isDev = process.env.PORT === '3001';

  const bg = isDev
    ? 'linear-gradient(135deg, #F59E0B, #EF4444)'   // 주황-레드: 고도화
    : 'linear-gradient(135deg, #4F46E5, #7C3AED)';  // 인디고: 안정

  return new ImageResponse(
    (
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 17,
          fontWeight: 800,
          color: 'white',
          fontFamily: 'system-ui, sans-serif',
          letterSpacing: '-0.5px',
        }}
      >
        Q
      </div>
    ),
    { ...size }
  );
}
