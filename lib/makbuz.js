// Dijital aidat makbuzu: mail (sunucu) ve doğrulama sayfası (tarayıcı) aynı tasarımı kullanır.
// E-posta istemcileri için tablo düzeni + satır içi stil; dış CSS / font yok.

export const APT_ADI = "Mert Apartmanı No 105";
const AYLAR = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
export const tl = n => new Intl.NumberFormat("tr-TR", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n || 0);
export const makbuzNo = (yil, sira) => `MRT-${yil}-${String(sira).padStart(5, "0")}`;

// "2026-09-05" → "5 Eylül 2026"
export function tarihYazi(t) {
  const [y, m, d] = String(t || "").slice(0, 10).split("-").map(Number);
  return y && m && d ? `${d} ${AYLAR[m - 1]} ${y}` : "—";
}

// "Ali Çelik" → "A** Ç****" (herkese açık doğrulama kaydında tam ad tutulmaz)
export const maskele = ad => String(ad || "").trim().split(/\s+/).filter(Boolean)
  .map(p => p[0].toLocaleUpperCase("tr-TR") + "*".repeat(Math.max(2, p.length - 1))).join(" ");

// 2500 → "ikibinbeşyüz"  (makbuzlardaki "Yalnız ..." satırı)
const BIR = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const ON  = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];
function ucHane(n) {
  const y = Math.floor(n / 100), o = Math.floor(n / 10) % 10, b = n % 10;
  return (y ? (y > 1 ? BIR[y] : "") + "yüz" : "") + ON[o] + BIR[b];
}
export function sayiYazi(n) {
  n = Math.floor(Math.abs(n || 0));
  if (n === 0) return "sıfır";
  const basamak = [["milyar", 1e9], ["milyon", 1e6], ["bin", 1e3]];
  let s = "";
  for (const [ad, v] of basamak) {
    const k = Math.floor(n / v);
    if (k) { s += (ad === "bin" && k === 1 ? "" : ucHane(k)) + ad; n %= v; }
  }
  return s + ucHane(n);
}
export function tlYazi(tutar) {
  const lira = Math.floor(tutar || 0), kurus = Math.round(((tutar || 0) - lira) * 100);
  return `Yalnız ${sayiYazi(lira)} Türk lirası${kurus ? ` ${sayiYazi(kurus)} kuruş` : ""}`;
}

const RENK = { yesil:"#1D9E75", koyu:"#0B6B4D", acik:"#E8F7F1", metin:"#111827", soluk:"#6B7280", cizgi:"#EEF0F3", kirmizi:"#C7332F" };

// Makbuz kartı (gövde). m: { no, daire, sakin, donemAd, tutar, odemeTarihi, duzenlenme, dogrulaUrl, qrSrc, iptal }
export function makbuzKart(m) {
  const satir = (k, v, vurgu) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid ${RENK.cizgi};font-size:13px;color:${RENK.soluk};">${k}</td>
      <td style="padding:10px 0;border-bottom:1px solid ${RENK.cizgi};font-size:14px;color:${RENK.metin};text-align:right;font-weight:${vurgu ? 700 : 600};">${v}</td>
    </tr>`;
  const damga = m.iptal
    ? `<div style="display:inline-block;padding:6px 14px;border:2px solid ${RENK.kirmizi};border-radius:8px;color:${RENK.kirmizi};font-weight:800;font-size:13px;letter-spacing:.08em;">İPTAL EDİLDİ</div>`
    : `<div style="display:inline-block;padding:6px 14px;border:2px solid ${RENK.yesil};border-radius:8px;color:${RENK.yesil};font-weight:800;font-size:13px;letter-spacing:.08em;">ÖDENDİ</div>`;
  const qr = m.qrSrc ? `
    <tr><td colspan="2" style="padding:22px 0 4px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
        <td width="124" style="vertical-align:middle;">
          <img src="${esc(m.qrSrc)}" width="112" height="112" alt="Doğrulama QR kodu" style="display:block;border:1px solid ${RENK.cizgi};border-radius:10px;padding:4px;background:#fff;">
        </td>
        <td style="vertical-align:middle;padding-left:14px;font-size:12px;line-height:1.55;color:${RENK.soluk};">
          <b style="color:${RENK.metin};font-size:13px;">Makbuzu doğrulayın</b><br>
          QR kodu telefonunuzun kamerasıyla okutun ya da aşağıdaki bağlantıyı açın. Sayfada bu makbuzun yönetim kayıtlarındaki karşılığı görünür.<br>
          <a href="${esc(m.dogrulaUrl)}" style="color:${RENK.koyu};font-weight:700;text-decoration:none;">Makbuzu doğrula →</a>
        </td>
      </tr></table>
    </td></tr>` : "";
  return `
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid ${RENK.cizgi};border-radius:18px;overflow:hidden;font-family:'DM Sans',Segoe UI,Helvetica,Arial,sans-serif;">
  <tr><td style="background:${RENK.yesil};background:linear-gradient(135deg,${RENK.yesil},#15805F);padding:22px 28px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td style="color:#fff;">
        <div style="font-size:12px;opacity:.85;letter-spacing:.06em;text-transform:uppercase;">Dijital Aidat Makbuzu</div>
        <div style="font-size:20px;font-weight:700;margin-top:2px;">${esc(APT_ADI)}</div>
      </td>
      <td style="text-align:right;color:#fff;font-size:12px;vertical-align:top;">
        <div style="opacity:.85;">Makbuz No</div>
        <div style="font-size:14px;font-weight:700;font-family:Consolas,Menlo,monospace;">${esc(m.no)}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:26px 28px 8px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td>
        <div style="font-size:12px;color:${RENK.soluk};">${esc(m.donemAd)} aidatı</div>
        <div style="font-size:34px;font-weight:800;color:${m.iptal ? RENK.soluk : RENK.metin};letter-spacing:-.02em;${m.iptal ? "text-decoration:line-through;" : ""}">₺${tl(m.tutar)}</div>
        <div style="font-size:12px;color:${RENK.soluk};margin-top:2px;">${esc(tlYazi(m.tutar))}</div>
      </td>
      <td style="text-align:right;vertical-align:middle;">${damga}</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:8px 28px 6px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      ${satir("Daire", esc(m.daire))}
      ${satir("Sakin", esc(m.sakin))}
      ${satir("Dönem", esc(m.donemAd))}
      ${satir("Ödeme tarihi", esc(tarihYazi(m.odemeTarihi)))}
      ${satir("Düzenlenme tarihi", esc(tarihYazi(m.duzenlenme)))}
      ${satir("Tutar", `₺${tl(m.tutar)}`, true)}
      ${qr}
    </table>
  </td></tr>
  <tr><td style="padding:16px 28px 22px;font-size:11px;line-height:1.5;color:#9CA3AF;border-top:1px solid ${RENK.cizgi};">
    Bu makbuz ${esc(APT_ADI)} yönetimi tarafından elektronik olarak düzenlenmiştir, imza gerektirmez.
    Her makbuzun numarası ve doğrulama kodu benzersizdir.
  </td></tr>
</table>`;
}

// Mail HTML'i (tam belge)
export function makbuzMail(m) {
  return `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.no)}</title></head>
<body style="margin:0;padding:0;background:#F6F7F9;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F6F7F9;"><tr><td style="padding:28px 12px;">
    <div style="max-width:560px;margin:0 auto 14px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#374151;">
      Sayın ${esc(m.sakin)},<br>${esc(m.donemAd)} dönemine ait aidat ödemeniz alınmıştır. Makbuzunuz aşağıdadır.
    </div>
    ${makbuzKart(m)}
    <div style="max-width:560px;margin:14px auto 0;text-align:center;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:11px;color:#9CA3AF;">
      Bu e-posta ${esc(APT_ADI)} yönetim sistemi tarafından gönderilmiştir.
    </div>
  </td></tr></table>
</body></html>`;
}

// Düz metin sürümü (HTML göstermeyen istemciler ve spam filtreleri için)
export function makbuzMetin(m) {
  return [
    `${APT_ADI} — Dijital Aidat Makbuzu`,
    `Makbuz No: ${m.no}`,
    "",
    `Sayın ${m.sakin},`,
    `${m.donemAd} dönemine ait aidat ödemeniz alınmıştır.`,
    "",
    `Daire: ${m.daire}`,
    `Dönem: ${m.donemAd}`,
    `Ödeme tarihi: ${tarihYazi(m.odemeTarihi)}`,
    `Tutar: ₺${tl(m.tutar)} (${tlYazi(m.tutar)})`,
    "",
    `Doğrulama: ${m.dogrulaUrl}`,
  ].join("\n");
}
