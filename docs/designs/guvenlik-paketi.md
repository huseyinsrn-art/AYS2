# Tasarım: Güvenlik ve Veri Doğruluğu Paketi (Minimal yaklaşım)

/office-hours ile üretildi · 2026-09-25
Repo: huseyinsrn-art/AYS2 · Branch: main
Durum: TASLAK (onay bekliyor)
Mod: Intrapreneurship / kendi apartmanı için iç araç

## Problem

Uygulama (React + Vite + Firebase, tek dosya `src/App.jsx`) çalışıyor. Yine de dört ciddi açığı var:

1. **Yetki kontrolü tarayıcıda yapılıyor.** Rol kontrolü `App.jsx:197` üzerinde `user.email === ADMIN_EMAIL` ile yapılıyor. `firestore.rules` depoda yok. README'deki "giriş yapan herkes okuyabilir" kuralı uygulandıysa her sakin diğer dairelerin telefonlarını ve ödemelerini okuyabilir.
2. **Birbirine bağlı yazmalar tek işlemde yapılmıyor.** Ödeme işaretlemede önce `odemeler`, ardından ayrı bir çağrıyla `gelirler` yazılıyor (`:436-437`). Arada bağlantı koparsa kasa hesabı sessizce bozulur. Aynı daire ve ay iki kez ödenmiş olarak girilebilir.
3. **Ödenmiş kayıtlar geriye dönük değişiyor.** Aidat tutarı değişince ödenmiş kayıtların tutarı da değiştirilebiliyor (`:411-420`).
4. **Tarih hataları var.** `NOW` sayfa açılışında sabitleniyor (`:12`). `tumAylar()` 2029 sonunda bitiyor (`:83`).

Bunlara ek olarak **yönetici hesabı huseyinsrn@gmail.com'dan mertaparmani@gmail.com'a geçecek.**

## Kararlar

- **Yaklaşım A (Minimal) seçildi.** Yönetici, Firestore Rules içinde e-posta ile tanımlanır. Veri taşıma yapılmaz, mevcut kayıtlar olduğu gibi kalır.
  - Bu bir kısayol. Sınırı şu: yönetici her değiştiğinde hem `firestore.rules` hem `App.jsx` elle güncellenmeli ve yeniden deploy edilmeli. Eski çift kayıtlar temizlenmez.
  - Yükseltme tetikleyicisi: ikinci bir yönetici veya yardımcı yönetici gerekirse ya da uygulama başka bir apartmana sunulursa B'ye (rol belgesi) geçilir.
- Reddedilen B, rol belgesi ve sabit kimlikler: kullanıcı minimal yolu tercih etti.
- Reddedilen C, Cloud Functions: Blaze plan maliyeti 10 daire için fazla.
- Sakinin dairesi e-postadan türetilir: `d3@105numara.com` → `D3`. Rules bunu `email.split('@')[0].upper()` ile yapar, ek eşleme belgesi gerekmez.
- Tahsil edilmiş aidat kaydı değiştirilmez. Tutar değişikliği yalnızca ödenmemiş ayları etkiler.

## Kapsam (uygulama sırası)

### 1. Yönetici geçişi
- `ADMIN_EMAIL` sabiti `mertaparmani@gmail.com` olur (`App.jsx:15`). README güncellenir.
- Giriş ekranındaki `admin` kısayolu yeni e-postaya yönlenir (bkz. Açık Sorular #2).
- Firebase Console → Authentication'da yeni kullanıcıyı **kullanıcı kendisi** oluşturur ve şifreyi kendisi belirler.

### 2. `firestore.rules` depoya girer (+ `firebase.json`)
Taslak:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    function signedIn()  { return request.auth != null; }
    function isAdmin()   { return signedIn() && request.auth.token.email == 'mertaparmani@gmail.com'; }
    function isSakin()   { return signedIn() && request.auth.token.email.matches('d[0-9]+@105numara[.]com'); }
    function myDaire()   { return request.auth.token.email.split('@')[0].upper(); }
    function ownsDaire(d){ return isSakin() && d == myDaire(); }

    match /ayarlar/{id}  { allow read: if signedIn(); allow write: if isAdmin(); }
    match /daireler/{id} { allow read: if isAdmin() || ownsDaire(id); allow write: if isAdmin(); }
    match /odemeler/{id} { allow read: if isAdmin() || ownsDaire(resource.data.daire); allow write: if isAdmin(); }
    match /borclar/{id}  { allow read: if isAdmin() || ownsDaire(resource.data.daire); allow write: if isAdmin(); }
    match /gelirler/{id} { allow read, write: if isAdmin(); }
    match /giderler/{id} { allow read, write: if isAdmin(); }
    match /auditLog/{id} { allow read, create: if isAdmin(); allow update, delete: if false; }
  }
}
```
- Denetim logu yalnızca eklenebilir hale gelir. Yönetici dahil kimse log kaydını değiştiremez veya silemez.
- **Kural testleri:** Firebase Emulator ile `@firebase/rules-unit-testing` + `vitest` kullanılır. Test edilecek durumlar: sakin kendi ödemesini okur; başka dairenin ödemesini okuyamaz; gelirleri okuyamaz; hiçbir şeye yazamaz. Yönetici her şeyi yazar ama auditLog kaydını silemez. Eski yönetici e-postası reddedilir.

### 3. Sakin tarafında veri yükleme
Kök bileşen şu an tüm `daireler` koleksiyonunu dinliyor (`:173`). Yeni kurallar bunu sakin için reddeder. Sakin yalnızca `daireler/{myDaire}` belgesini dinler. `DairePanel` sorguları zaten `where("daire","==",...)` kullandığı için kurallarla uyumlu.

### 4. Tek işlemde yazma (`writeBatch` / `runTransaction`)
- **Ödeme işaretleme:** `odemeler`, `gelirler` ve `auditLog` tek batch'te yazılır. Yeni ödemeler sabit kimlikle (`D3_2026-05`) ve bir transaction içinde oluşturulur: belge varsa işlem iptal edilir. Eski rastgele kimlikli kayıtlar için yazmadan önce `where(daire, donem)` kontrolü yapılır. Böylece taşıma gerekmez.
- **İptal:** Gelir kaydı `odemeId` ile bulunur (yeni kayıtlarda bu alan zaten var). Not metniyle eşleştirme (`aidatBul`) yalnızca `odemeId` alanı olmayan eski kayıtlar için yedek yol olarak kalır. İki silme tek batch'te yapılır.
- **Eski borç kaydı dönüştürme** (`:600-617`): Her kayıt kendi batch'inde işlenir.

### 5. Ödenmiş kayıtları koruma
`tutarKaydet` içindeki ödenmiş kayıtları güncelleme bloğu kaldırılır. Ekrandaki "ödenmiş kayıtlar değişmez" yazısı böylece doğru olur.

### 6. Tarih hataları
- `curKey()` her çağrıda `new Date()` kullanır. Ay değişimini yakalamak için kök bileşende dakikada bir çalışan bir tik eklenir.
- `tumAylar()`, `START_YEAR`'dan içinde bulunulan yıl + 1'e kadar dinamik olarak ay üretir.

### 7. Denetim logu sorgusu
`useCol("auditLog")` tüm koleksiyonu dinlemek yerine `orderBy("olusturuldu","desc"), limit(50)` ile sorgular.

### 8. Yedek indirme (yönetici)
Ayarlar sekmesine "Yedeği indir (JSON)" düğmesi eklenir. Tüm koleksiyonları tek dosyada indirir. Kurallar deploy edilmeden **önce** bir kez çalıştırılır.

## Yayına alma sırası
1. Yönetici (eski hesapla) yedeği indirir. (Yedek düğmesi ayrı ve önceden deploy edilir.)
2. Kullanıcı Console'da mertaparmani@gmail.com hesabını açar.
3. Kural testleri emulator'da yeşil olur.
4. `firebase deploy --only firestore:rules` ve ardından Vercel deploy'u, arka arkaya yapılır. Arada eski istemci kısa bir süre izin hatası verebilir.
5. Yeni hesapla giriş yapılır ve doğrulanır. Bir sakin hesabıyla (örn. d1) giriş yapılıp başka dairenin verisinin görünmediği kontrol edilir.
6. Eski hesap (huseyinsrn@gmail.com) Authentication'dan devre dışı bırakılır. Bu adımı kullanıcı yapar.

## Açık sorular
1. ~~Console'daki mevcut Rules metni nedir?~~ **Cevaplandı (2026-09-25):** `match /{document=**} { allow read: if isAuthenticated(); allow write: if isAdmin(); }` + ayrıca `auditLog` için yalnızca yönetici kuralı. Tespitler:
   - Giriş yapan **her sakin tüm koleksiyonları okuyabiliyor** (tüm dairelerin telefonları, ödemeleri, gelir-giderler).
   - Firestore kuralları VEYA ile birleşir: `{document=**}` joker kuralı `auditLog`'u da kapsadığı için ayrı yazılmış "yalnızca yönetici" kuralı **işe yaramıyor**. Sakinler denetim logunu da okuyabiliyor.
   - Yazma yalnızca huseyinsrn@gmail.com'a açık. Sakinler yazamıyor; bu kısım doğru.
   - Yeni kurallarda joker (`{document=**}`) kullanılmayacak, her koleksiyon ayrı tanımlanacak, tanımsız koleksiyonlar varsayılan olarak kapalı kalacak.
2. Giriş ekranındaki `admin` kısayolu kalsın mı? Kalırsa yönetici e-postası yine kodda görünür. Seçenek: yönetici tam e-postayla giriş yapar.
3. Yönetici hesabı için `email_verified` şartı konsun mu? Console'dan açılan hesaplar varsayılan olarak doğrulanmamış olur.
4. Eski denetim logu kayıtlarında `kullanici: "admin"` yazıyor. Yeni kayıtlar da "admin" olarak mı görünsün, yoksa e-posta ile mi?

## Başarı ölçütleri
- d1 hesabıyla giriş yapan sakin, tarayıcı konsolundan `gelirler`, `giderler`, `auditLog` ve başka dairelerin `odemeler`/`daireler` belgelerini okuyamaz. Rules testi bunu kanıtlar.
- Ödeme işaretleme sırasında ağ kesilirse ya iki kayıt da oluşur ya hiçbiri.
- Aynı daire ve ay için ikinci "✓ Ödendi" tıklaması yeni kayıt oluşturmaz.
- Aidat tutarı değiştirildiğinde ödenmiş hiçbir kaydın tutarı değişmez.
- huseyinsrn@gmail.com ile giriş yapıldığında hiçbir veriye erişilemez.

## Dağıtım
Mevcut Vercel akışı kullanılır. Rules deploy'u için Firebase CLI gerekir: `npm i -D firebase-tools`, ardından `npx firebase deploy --only firestore:rules`.

## Sonraki adımlar
Önce 2 (rules + testler), sonra 1 ve 3 (yönetici geçişi ve sakin yüklemesi, rules ile birlikte yayına alınmalı), sonra 4-7, en son 8. Yedek düğmesi ayrı ve daha önce deploy edilebilir.

## The Assignment
Firebase Console → Firestore Database → **Rules** sekmesindeki metnin tamamını kopyalayıp buraya yapıştırın. Aynı oturumda Authentication → Users → **Add user** ile mertaparmani@gmail.com hesabını açın. Şifreyi kendiniz belirleyin, bana göndermeyin.

## Gözlemler
- İlk cevabınızda bir paket seçmekle kalmayıp yönetici hesabını da değiştirdiniz: "huseyinsrn@gmail.com bu mail adresi artık admin olmayacak". Yönetimi kişisel hesaptan apartmana ait bir hesaba taşımak, yönetici değiştiğinde erişimin kaybolmamasını sağlar.
- Önerilen yaklaşım yerine minimal olanı seçtiniz. 10 dairelik bir apartman için bu makul. Yükseltme tetikleyicisi yukarıda yazılı.
