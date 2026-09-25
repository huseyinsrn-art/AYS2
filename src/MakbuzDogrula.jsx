import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase.js";
import { APT_ADI, makbuzKart } from "../lib/makbuz.js";

// /makbuz/<kod> — QR koddan gelen, giriş gerektirmeyen doğrulama sayfası
export default function MakbuzDogrula({ kod }) {
  const [durum, setDurum] = useState({ yukleniyor: true });
  useEffect(() => {
    getDoc(doc(db, "makbuzlar", kod))
      .then(s => setDurum(s.exists() ? { makbuz: s.data() } : { yok: true }))
      .catch(e => { console.error(e); setDurum({ hata: true }); });
  }, [kod]);

  const { makbuz } = durum;
  const serit = makbuz
    ? makbuz.iptal
      ? { bg: "#FEE2E2", renk: "#991B1B", ikon: "⚠️", baslik: "Bu makbuz iptal edilmiş", alt: "İlgili ödeme kaydı yönetim tarafından iptal edildi. Güncel durum için yönetimle görüşün." }
      : { bg: "#D1FAE5", renk: "#065F46", ikon: "✅", baslik: "Geçerli makbuz", alt: "Bu makbuz yönetim kayıtlarında mevcut ve aşağıdaki bilgilerle eşleşiyor." }
    : null;

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#ECFDF5 0%,#F6F7F9 55%)", padding: "28px 16px" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <div style={{ fontSize: 36 }}>🏢</div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{APT_ADI}</div>
          <div style={{ fontSize: 12, color: "#6B7280" }}>Makbuz doğrulama</div>
        </div>
        {durum.yukleniyor && <Kutu>Makbuz kontrol ediliyor…</Kutu>}
        {durum.yok && <Kutu renk="#991B1B" bg="#FEE2E2">❌ <b>Makbuz bulunamadı.</b> Bağlantı hatalı olabilir ya da bu makbuz bu apartmana ait değil.</Kutu>}
        {durum.hata && <Kutu renk="#92400E" bg="#FEF3C7">Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip sayfayı yenileyin.</Kutu>}
        {serit && (
          <>
            <Kutu renk={serit.renk} bg={serit.bg}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{serit.ikon} {serit.baslik}</div>
              <div style={{ fontSize: 12, marginTop: 4, opacity: .9 }}>{serit.alt}</div>
            </Kutu>
            <div dangerouslySetInnerHTML={{ __html: makbuzKart({
              no: makbuz.no, daire: makbuz.daire, sakin: makbuz.sakinMaskeli, donemAd: makbuz.donemAd, tutar: makbuz.tutar,
              odemeTarihi: makbuz.odemeTarihi, duzenlenme: makbuz.duzenlenme, iptal: makbuz.iptal,
            }) }} />
          </>
        )}
      </div>
    </div>
  );
}

function Kutu({ children, renk = "#374151", bg = "#fff" }) {
  return <div style={{ background: bg, color: renk, border: "1px solid #EEF0F3", borderRadius: 14, padding: "14px 16px", marginBottom: 14, fontSize: 13, lineHeight: 1.5 }}>{children}</div>;
}
