// POST /api/makbuz-gonder   { makbuzlar: ["<makbuz kodu>", ...] }   Authorization: Bearer <Firebase ID token>
//
// Makbuz, ödeme ve daire bilgisi istemciden değil Firestore'dan okunur (yöneticinin kendi oturumuyla,
// yani firestore.rules geçerli). QR kod üretilir ve makbuz Gmail üzerinden gönderilir.
//
// Vercel ortam değişkenleri:
//   GMAIL_USER          mertaparmani@gmail.com
//   GMAIL_APP_PASSWORD  Gmail → Google Hesabı → Güvenlik → Uygulama şifreleri
//   ADMIN_EMAIL         (isteğe bağlı) varsayılan mertaparmani@gmail.com — firestore.rules ile aynı olmalı
//   SITE_URL            (isteğe bağlı) QR'daki adres, örn. https://ays2.vercel.app
// GMAIL_* tanımlı değilse ve üretim ortamı değilse mail gönderilmez; makbuz önizleme dosyası olarak kaydedilir.
import nodemailer from "nodemailer";
import QRCode from "qrcode";
import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APT_ADI, makbuzMail, makbuzMetin } from "../lib/makbuz.js";

const PROJE = process.env.FIREBASE_PROJECT_ID || "ays105";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "mertaparmani@gmail.com";
const EN_FAZLA = 30;
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));

const docsUrl = () => {
  const emu = process.env.FIRESTORE_EMULATOR_HOST;
  return `${emu ? `http://${emu}` : "https://firestore.googleapis.com"}/v1/projects/${PROJE}/databases/(default)/documents`;
};

class Hata extends Error { constructor(kod, mesaj) { super(mesaj); this.kod = kod; } }

async function yoneticiDogrula(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new Hata(401, "Oturum bulunamadı.");
  let p;
  try {
    // Auth emülatörünün jetonları imzasızdır; yalnızca emülatörde imza kontrolü atlanır
    p = process.env.FIREBASE_AUTH_EMULATOR_HOST ? decodeJwt(token)
      : (await jwtVerify(token, JWKS, { issuer: `https://securetoken.google.com/${PROJE}`, audience: PROJE })).payload;
  } catch { throw new Hata(401, "Oturum doğrulanamadı, tekrar giriş yapın."); }
  if (String(p.email || "").toLowerCase() !== ADMIN_EMAIL.toLowerCase()) throw new Hata(403, "Makbuzu yalnızca yönetici gönderebilir.");
  return token;
}

// Firestore REST değerlerini düz nesneye çevirir
function duz(v) {
  if (!v) return null;
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, duz(x)]));
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(duz);
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("nullValue" in v) return null;
  return Object.values(v)[0];
}

async function belge(token, yol) {
  const r = await fetch(`${docsUrl()}/${yol}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Hata(r.status === 403 ? 403 : 502, `${yol} okunamadı (${r.status}).`);
  return duz({ mapValue: { fields: (await r.json()).fields } });
}

let tasiyici;
function gmail() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  // Google uygulama şifresini "abcd efgh ijkl mnop" biçiminde gösterir; boşluklar şifreye dahil değildir
  tasiyici ??= nodemailer.createTransport({ service: "gmail", pool: true, auth: { user: GMAIL_USER.trim(), pass: GMAIL_APP_PASSWORD.replace(/\s+/g, "") } });
  return tasiyici;
}

async function birMakbuz(token, kod, site, t) {
  const mk = await belge(token, `makbuzlar/${encodeURIComponent(kod)}`);
  if (!mk) throw new Error("Makbuz bulunamadı.");
  if (mk.iptal) throw new Error("Makbuz iptal edilmiş.");
  const [odeme, daire] = await Promise.all([
    belge(token, `odemeler/${encodeURIComponent(mk.odemeId)}`),
    belge(token, `daireler/${encodeURIComponent(mk.daire)}`),
  ]);
  if (!odeme || odeme.durum !== "odendi") throw new Error("Bağlı ödeme kaydı bulunamadı.");
  const email = String(daire?.mail || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${mk.daire} için e-posta adresi girilmemiş.`);

  const dogrulaUrl = `${site}/makbuz/${kod}`;
  const qrPng = await QRCode.toBuffer(dogrulaUrl, { width: 240, margin: 1, color: { dark: "#0B6B4D", light: "#FFFFFF" } });
  const m = {
    no: mk.no, daire: mk.daire, sakin: odeme.sakinAd || daire.sakinAd || mk.daire, donemAd: mk.donemAd,
    tutar: mk.tutar, odemeTarihi: mk.odemeTarihi, duzenlenme: mk.duzenlenme, dogrulaUrl,
  };
  const konu = `Aidat makbuzu · ${mk.donemAd} · ${mk.daire} · ${mk.no}`;

  if (!t) {
    // Önizleme modu: QR'ı gömülü görselle HTML dosyası olarak kaydet
    const klasor = join(tmpdir(), "ays-makbuz-onizleme");
    await mkdir(klasor, { recursive: true });
    const dosya = join(klasor, `${mk.no}.html`);
    await writeFile(dosya, makbuzMail({ ...m, qrSrc: `data:image/png;base64,${qrPng.toString("base64")}` }));
    return { email, onizleme: dosya };
  }
  await t.sendMail({
    from: { name: `${APT_ADI} Yönetimi`, address: process.env.GMAIL_USER },
    to: email, subject: konu,
    html: makbuzMail({ ...m, qrSrc: "cid:qr@makbuz" }),
    text: makbuzMetin(m),
    attachments: [{ filename: `${mk.no}-qr.png`, content: qrPng, cid: "qr@makbuz" }],
  });
  return { email };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ hata: "Yalnızca POST." });
  try {
    const token = await yoneticiDogrula(req);
    const kodlar = [...new Set(Array.isArray(req.body?.makbuzlar) ? req.body.makbuzlar : [])]
      .filter(k => /^[A-Za-z0-9]{10,40}$/.test(k));
    if (!kodlar.length) throw new Hata(400, "Gönderilecek makbuz yok.");
    if (kodlar.length > EN_FAZLA) throw new Hata(400, `Tek seferde en fazla ${EN_FAZLA} makbuz.`);

    const t = gmail();
    if (!t && process.env.VERCEL_ENV === "production") throw new Hata(500, "Mail ayarları eksik (GMAIL_USER / GMAIL_APP_PASSWORD).");
    const site = (process.env.SITE_URL || req.headers.origin || `https://${req.headers.host}`).replace(/\/$/, "");

    const sonuc = [];
    for (const kod of kodlar) {  // sırayla: Gmail hız sınırına takılmamak için
      try { sonuc.push({ kod, durum: "gonderildi", ...(await birMakbuz(token, kod, site, t)) }); }
      catch (e) {
        if (e.code === "EAUTH") {
          tasiyici = undefined;  // ayar düzeltilince yeniden bağlansın
          throw new Hata(502, "Gmail girişi reddedildi: GMAIL_USER / GMAIL_APP_PASSWORD hatalı ya da uygulama şifresi iptal edilmiş. Hesapta 2 Adımlı Doğrulama açık olmalı.");
        }
        console.error(kod, e);
        sonuc.push({ kod, durum: "hata", mesaj: e.message });
      }
    }
    return res.status(200).json({ onizleme: !t, sonuc });
  } catch (e) {
    console.error(e);
    return res.status(e.kod || 500).json({ hata: e.kod ? e.message : "Sunucu hatası." });
  }
}
