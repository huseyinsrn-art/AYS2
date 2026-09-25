import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Geliştirmede /api/* isteklerini Vercel fonksiyonlarına yönlendirir (üretimde Vercel çalıştırır)
function apiDev() {
  return {
    name: 'api-dev',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        try {
          const mod = await server.ssrLoadModule(`/api${req.url.split('?')[0]}.js`)
          let govde = ''
          for await (const p of req) govde += p
          req.body = govde ? JSON.parse(govde) : {}
          res.status = kod => { res.statusCode = kod; return res }
          res.json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) }
          await mod.default(req, res)
        } catch (e) { next(e) }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Sunucu tarafı değişkenler (GMAIL_*, SITE_URL …) .env.local'dan process.env'e.
  // .env dosyası değişince Vite bu fonksiyonu aynı süreçte yeniden çalıştırır; loadEnv ise
  // process.env'deki değeri dosyadakine tercih eder. Bu yüzden önceki turda eklenenler önce silinir,
  // aksi halde dosyadaki yeni değer (örn. şifre) hiç görülmez.
  for (const k of globalThis.__aysEnvKeys || []) delete process.env[k]
  const dosyadan = loadEnv(mode, process.cwd(), '')
  const eklenen = Object.keys(dosyadan).filter(k => !(k in process.env))
  for (const k of eklenen) process.env[k] = dosyadan[k]
  globalThis.__aysEnvKeys = eklenen
  if (mode === 'emu') {
    process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099'
  }
  return {
    plugins: [react(), apiDev()],
    build: { chunkSizeWarningLimit: 1500 },
  }
})
