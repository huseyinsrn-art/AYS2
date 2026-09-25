// Emülatöre örnek veri + deneme hesapları yükler (canlı veriye dokunmaz).
//   npm run emu        (ayrı terminalde)
//   npm run seed:emu
// Deneme şifresi yalnızca emülator içindir: deneme123
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";

const PROJE = "ays105", SIFRE = "deneme123";
const AUTH = "http://127.0.0.1:9099";

// Emülatördeki eski hesapları temizle, deneme hesaplarını aç
await fetch(`${AUTH}/emulator/v1/projects/${PROJE}/accounts`, { method: "DELETE" });
const hesaplar = ["mertaparmani@gmail.com", "huseyinsrn@gmail.com", ...Array.from({ length: 10 }, (_, i) => `d${i + 1}@105numara.com`)];
for (const email of hesaplar) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: SIFRE, returnSecureToken: true }),
  });
  if (!r.ok) throw new Error(`${email}: ${await r.text()}`);
}

const env = await initializeTestEnvironment({ projectId: PROJE, firestore: { host: "127.0.0.1", port: 8080 } });
await env.clearFirestore();
const ADLAR = ["Ayşe Yılmaz", "Mehmet Kaya", "Zeynep Demir", "Ali Çelik", "Elif Şahin", "Mustafa Arslan", "Fatma Koç", "Ahmet Aydın", "Emine Öztürk", "Hasan Polat"];
const ay = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
const AY_AD = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];

await env.withSecurityRulesDisabled(async ctx => {
  const f = ctx.firestore();
  await setDoc(doc(f, "ayarlar", "genel"), { aidatTutar: 2500, aylikAidat: {} });
  for (let i = 1; i <= 10; i++) {
    await setDoc(doc(f, "daireler", `D${i}`), {
      id: `D${i}`, username: `d${i}`, ad: `Daire ${i}`, email: `d${i}@105numara.com`, aktif: true,
      sakinAd: ADLAR[i - 1], tel: `0532 000 00 ${String(i).padStart(2, "0")}`, mail: i <= 8 ? `daire${i}@example.com` : "",
      sakinGecmis: [{ ad: ADLAR[i - 1], baslangic: "0000-00" }],
    });
  }
  // Mart–Ağustos 2026: çoğu daire ödemiş; D4 ve D7 bazı ayları ödememiş. Eski düzen: rastgele kimlik.
  let n = 0;
  for (let m = 3; m <= 8; m++) {
    for (let i = 1; i <= 10; i++) {
      if ((i === 4 && m >= 7) || (i === 7 && m === 8)) continue;
      const key = ay(2026, m), adAy = `${AY_AD[m - 1]} 2026`, id = `eski${++n}`;
      await setDoc(doc(f, "odemeler", id), { daire: `D${i}`, donem: key, donemAd: adAy, tutar: 2500, durum: "odendi", tarih: `${key}-0${1 + (i % 9)}`, sakinAd: ADLAR[i - 1] });
      await setDoc(doc(f, "gelirler", `g${id}`), { kaynak: "aidat", daire: `D${i}`, donem: key, odemeId: id, tutar: 2500, tarih: `${key}-0${1 + (i % 9)}`, not: `D${i} ${ADLAR[i - 1]} - ${adAy} aidatı`, otomatik: true });
    }
  }
  const giderler = [["Elektrik", 1850, "2026-06-10"], ["Su", 920, "2026-06-12"], ["Temizlik", 3000, "2026-07-01"], ["Asansör", 4200, "2026-07-15"], ["Elektrik", 1990, "2026-08-10"], ["Bakım", 2750, "2026-09-03"]];
  for (const [i, [kategori, tutar, tarih]] of giderler.entries()) {
    await setDoc(doc(f, "giderler", `x${i}`), { kategori, tutar, tarih, not: "" });
  }
  await setDoc(doc(f, "borclar", "b1"), { daire: "D2", donem: "2026-08", donemAd: "Ağustos 2026", eksik: 500, kapali: false, model: 2, not: "kalanı eylülde", tarih: "2026-08-20" });
  await setDoc(doc(f, "auditLog", "l1"), { kullanici: "admin", detay: "Örnek veri yüklendi", tur: "seed", tarih: "2026-09-25", saat: "10:00:00", olusturuldu: serverTimestamp() });
});
await env.cleanup();
console.log(`Hazır: ${hesaplar.length} deneme hesabı (şifre: ${SIFRE}), örnek veri yüklendi.`);
