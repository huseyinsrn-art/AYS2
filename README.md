# 🏢 105 Numara — Bina Yönetim Sistemi

React + Vite + Firebase (Auth & Firestore) ile yapılmış apartman yönetim uygulaması.

## Özellikler
- Yönetici ve daire sakini girişi (Firebase Authentication)
- Aidat takibi (ay bazlı), gelir / gider kayıtları, grafikli özet
- Duyuru ve mesaj yönetimi, denetim logu
- 12 saat hareketsizlikte otomatik çıkış

## Giriş
- Yönetici: kullanıcı adı `admin`
- Daireler: `d1`, `d2` … `d10` (e-posta karşılığı `d1@105numara.com` …)
- Şifreler Firebase Console → Authentication → Users içinde tanımlıdır.

## Yerelde çalıştırma
```bash
npm install
npm run dev
```

## Vercel'e deploy
1. Projeyi yeni bir GitHub deposuna yükleyin.
2. vercel.com → Add New → Project → depoyu seçin (Framework: **Vite** otomatik algılanır).
3. Ortam değişkeni gerekmez. **Deploy**.

## Firebase kontrol listesi
- Authentication → Sign-in method → **Email/Password** etkin olmalı.
- Firestore Database oluşturulmuş olmalı; Rules, giriş yapmış kullanıcıların `ayarlar`, `daireler`, `odemeler`, `duyurular` okumasına; yönetici hesabının tüm koleksiyonlara yazmasına izin vermeli.
- Authentication → Settings → Authorized domains listesinde Vercel alan adınız (`xxx.vercel.app`) bulunsun.

## Yapı
```
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
└── src/
    ├── main.jsx
    ├── firebase.js   ← Firebase yapılandırması
    └── App.jsx       ← Tüm uygulama
```
