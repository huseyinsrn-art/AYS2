# 🏢 Mert Apartmanı No 105 — Yönetim Sistemi

React + Vite + Firebase (Auth & Firestore) ile yapılmış apartman yönetim uygulaması.

## Özellikler
- Yönetici ve daire sakini girişi (Firebase Authentication)
- Aidat takibi (aya özel tutar), tek sayfada gelir–gider, borç / eksik ödeme takibi
- Daire bazlı PDF raporu, sakin geçmişi, denetim logu
- 12 saat hareketsizlikte otomatik çıkış

## Giriş
- Yönetici: tam e-posta adresiyle giriş yapar. Yönetici hesabı `firestore.rules` içinde tanımlıdır, uygulama kodunda yer almaz.
- Daireler: `d1`, `d2` … `d10` (e-posta karşılığı `d1@105numara.com` …)
- Şifreler Firebase Console → Authentication → Users içinde tanımlıdır.

## Güvenlik kuralları
Yetki `firestore.rules` dosyasıyla sunucuda uygulanır:
- Sakin yalnızca kendi dairesini, kendi ödeme ve borç kayıtlarını ve ayarları okur; hiçbir şey yazamaz.
- Gelir, gider ve denetim logu yalnızca yöneticiye açıktır. Denetim logu yalnızca eklenebilir (silinemez, değiştirilemez).
- Burada tanımlanmayan koleksiyonlar kapalıdır.

**Yönetici değişirse:** `firestore.rules` içindeki `isAdmin()` e-postasını değiştirip kuralları yeniden deploy edin.

```bash
npm run test:rules    # kural testleri (Firebase emulator, Java 21+ gerekir)
npx firebase login
npm run deploy:rules  # kuralları Firebase'e yükler
```

Kuralları değiştirmeden önce Yönetici Paneli → Ayarlar → 💾 Yedek ile verilerin yedeğini alın.

## Yerelde çalıştırma
```bash
npm install
npm run dev
```

## Dijital makbuz (e-posta + QR doğrulama)
- Sakin e-postaları: Yönetici Paneli → Ayarlar → Daire Sakinleri → Düzelt.
- Tek makbuz: Aidat sekmesinde ödenmiş satırdaki **📧 Makbuz gönder**.
- Toplu: Rapor sekmesinde bir ay seçip **Makbuzları gönder** (henüz gönderilmemişlere).
- Her ödeme için bir kez makbuz düzenlenir: `MRT-<yıl>-<sıra>` numarası + tahmin edilemez doğrulama kodu. Tekrar gönderimde numara değişmez. Ödeme iptal edilirse makbuz silinmez, "İPTAL EDİLDİ" olur.
- QR kod `https://<site>/makbuz/<kod>` sayfasını açar; giriş gerektirmez, sakin adını kısaltılmış gösterir.

**Gmail kurulumu (bir kez):**
1. mertaparmani@gmail.com → Google Hesabı → Güvenlik → **2 Adımlı Doğrulama**'yı açın.
2. Aynı sayfada **Uygulama şifreleri** → yeni şifre oluşturun (16 karakter).
3. Vercel → Proje → Settings → Environment Variables:
   - `GMAIL_USER` = `mertaparmani@gmail.com`
   - `GMAIL_APP_PASSWORD` = oluşturduğunuz uygulama şifresi
   - (isteğe bağlı) `SITE_URL` = sitenin adresi, örn. `https://xxx.vercel.app`
4. Yeniden deploy edin. Gmail günde en fazla ~500 mail gönderir.

Gmail ayarı yokken (yerel deneme) mail gönderilmez; makbuzlar bilgisayarın geçici klasöründe `ays-makbuz-onizleme/` altına HTML olarak kaydedilir.

## Canlı veriye dokunmadan yerelde deneme (emülatör)
Java 21+ gerekir. Üç ayrı terminalde:
```bash
npm run emu        # Firestore + Auth emülatörü (firestore.rules ile)
npm run seed:emu   # örnek veri + deneme hesapları (şifre: deneme123)
npm run dev:emu    # uygulama emülatöre bağlı açılır
```
Deneme hesapları: `mertaparmani@gmail.com`, `huseyinsrn@gmail.com` (eski yönetici, erişimi olmamalı), `d1` … `d10`.

## Vercel'e deploy
1. Projeyi yeni bir GitHub deposuna yükleyin.
2. vercel.com → Add New → Project → depoyu seçin (Framework: **Vite** otomatik algılanır).
3. Ortam değişkeni gerekmez. **Deploy**.

## Firebase kontrol listesi
- Authentication → Sign-in method → **Email/Password** etkin olmalı.
- Firestore Database oluşturulmuş olmalı; Rules, depodaki `firestore.rules` dosyasından `npm run deploy:rules` ile yüklenir (Console'da elle düzenlemeyin).
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
