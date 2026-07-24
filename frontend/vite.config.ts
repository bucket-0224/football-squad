import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: '풋볼 스쿼드',
        short_name: '풋볼 스쿼드',
        description: '나만의 스쿼드를 만들어 실시간 대전에서 승리하세요',
        lang: 'ko',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0d1117',
        theme_color: '#0d1117',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 실시간 대전(WS)/코인·경기 결과 같은 API 응답을 캐시하면 실제 상태와
        // 어긋난 값을 보여줄 수 있어 위험하다 — 여기서는 정적 빌드 산출물만
        // 프리캐시하고, /api/*, WS 업그레이드 요청은 캐싱 대상에서 제외한다.
        // img/players는 선수 사진 수백 장(장당 최대 수 MB, 총 수백 MB)이라
        // 서비스워커 설치 시 통째로 내려받게 되므로 프리캐시 대상에서 제외 —
        // 어차피 server.cjs가 이미 장기 캐시 헤더를 붙여 보내므로 평범한
        // HTTP 캐시로 충분하다.
        globPatterns: ['**/*.{js,css,html}', 'icons/*.png', 'favicon.svg'],
        globIgnores: ['img/players/**'],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
