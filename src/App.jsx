import { useState, useEffect, useRef } from "react";
import { db, auth } from "./firebase.js";
import {
  collection, doc, setDoc, addDoc, deleteDoc, updateDoc,
  onSnapshot, query, orderBy, limit, serverTimestamp, getDoc, getDocs, where, increment,
  writeBatch, runTransaction
} from "firebase/firestore";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";
import { makbuzNo, maskele } from "../lib/makbuz.js";

const fmt = (n) => new Intl.NumberFormat("tr-TR").format(Math.round(n || 0));
const MONTH_NAMES  = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
const MONTHS_SHORT = ["Oca","Şub","Mar","Nis","May","Haz","Tem","Ağu","Eyl","Eki","Kas","Ara"];
// Her çağrıda güncel tarih: sekme ay sonunda açık kalsa da "bu ay" doğru kalır
const curYear      = () => new Date().getFullYear();
const curMonth     = () => new Date().getMonth();
// Yönetici e-postası istemcide tutulmaz; yetkiyi firestore.rules belirler.
// Daire hesabı olmayan (dN@105numara.com dışındaki) her hesap yönetici arayüzünü görür,
// kurallar izin vermezse hiçbir veri okuyamaz.
const DAIRE_EMAIL  = /^d(\d+)@105numara\.com$/;
const daireIdOf    = email => { const m = (email || "").toLowerCase().match(DAIRE_EMAIL); return m ? `D${m[1]}` : null; };
const START_YEAR   = 2026;
const START_MONTH  = 3;
const SESSION_TIMEOUT = 12 * 60 * 60 * 1000; // 12 saat hareketsizlik

function hataMesaji(e) {
  const kod = e?.code || "";
  if (kod.includes("permission-denied"))
    return "Veritabanı erişim izni reddedildi. Firebase Console → Firestore → Rules kurallarını kontrol edin.";
  if (kod.includes("failed-precondition"))
    return "Bu sorgu için Firestore indeksi gerekiyor: " + (e?.message || "");
  if (kod.includes("unavailable") || kod.includes("network"))
    return "Sunucuya ulaşılamıyor. İnternet bağlantınızı kontrol edin.";
  return e?.message || "Bilinmeyen hata";
}

const APT_ADI = "Mert Apartmanı No 105";
const curKey = () => `${curYear()}-${String(curMonth() + 1).padStart(2, "0")}`;
const bugun  = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const topla  = l => l.reduce((a, k) => a + (k.tutar || 0), 0);
const ayOf   = t => (t || "").slice(0, 7);
const ayAdi  = key => { if (!key) return "Tarihsiz"; const [y, m] = key.split("-"); return `${MONTH_NAMES[Number(m) - 1] || m} ${y}`; };
// Aidat geliri, ödemenin yapıldığı tarihe değil ait olduğu aya (dönem) bağlanır.
// Eski kayıtlarda dönem alanı yoksa nottaki "Mayıs 2026 aidatı" ifadesinden bulunur.
const AY_REGEX = new RegExp(`(${MONTH_NAMES.join("|")}) (\\d{4}) aidat`);
const gelirAy = g => {
  if (g.kaynak === "aidat") {
    if (g.donem) return g.donem;
    const m = (g.not || "").match(AY_REGEX);
    if (m) return `${m[2]}-${String(MONTH_NAMES.indexOf(m[1]) + 1).padStart(2, "0")}`;
  }
  return ayOf(g.tarih);
};
// Alacak (eksik ödeme): yalnızca açık olanlar kasadan düşülür; eski düzendekiler (model≠2) ayrı ele alınır
const kalanOf  = b => b.model === 2 ? (b.kapali ? 0 : (b.eksik || 0)) : Math.max(0, (b.eksik || 0) - (b.odenen || 0));
const acikTutar = b => b.model === 2 && !b.kapali ? (b.eksik || 0) : 0;
const DURUM_STIL = {
  odendi:  { background:"#D1FAE5", color:"#065F46" },
  bekliyor:{ background:"#FEF3C7", color:"#92400E" },
  gecikti: { background:"#FEE2E2", color:"#991B1B" },
};
// Aylık aidat: o aya özel tutar varsa o, yoksa genel tutar
const aidatOf = (ay, key) => { const v = ay?.aylikAidat?.[key]; return v != null ? Number(v) : Number(ay?.aidatTutar || 2500); };

// Sakin geçmişi: kayıtlar eski ismi korur, yeni isim sadece başlangıç ayından itibaren geçerli olur
function sakinlar(d, bas, son) {
  const g = [...(d.sakinGecmis || [])].sort((a, b) => a.baslangic.localeCompare(b.baslangic));
  if (!g.length) return d.sakinAd || d.ad;
  const r = g.filter((e, i) => e.baslangic <= son && (!g[i + 1] || g[i + 1].baslangic > bas)).map(e => e.ad || d.ad);
  return r.join(" → ") || d.sakinAd || d.ad;
}
const sakinAdi = (d, key) => sakinlar(d, key, key);

// Yeni ödeme kayıtlarının sabit kimliği: aynı daire/ay için tek belge (örn. D3_2026-05)
const odemeId = (daireId, key) => `${daireId}_${key}`;

// Eski kayıtlar için: bir dairenin belirli ayki aidat gelirini nottaki metinden bulur
async function aidatBul(daireId, key, adAy) {
  const gs = (await getDocs(query(collection(db, "gelirler"), where("daire", "==", daireId)))).docs.map(x => ({ id:x.id, ...x.data() }));
  return gs.find(g => g.kaynak === "aidat" && (g.donem === key || (g.not || "").includes(adAy + " aidat")));
}

// Bir ödemeye bağlı aidat gelirini bulur: önce sabit kimlik, sonra odemeId alanı, en son (eski kayıt) not metni
async function aidatGeliriBul(odeme, adAy) {
  const sabit = await getDoc(doc(db, "gelirler", `aidat_${odeme.id}`));
  if (sabit.exists()) return { id:sabit.id, ...sabit.data() };
  const bagli = await getDocs(query(collection(db, "gelirler"), where("odemeId", "==", odeme.id)));
  if (!bagli.empty) return { id:bagli.docs[0].id, ...bagli.docs[0].data() };
  return aidatBul(odeme.daire, odeme.donem, adAy);
}

function useCol(ad, alan, adet) {
  const [v, setV] = useState([]);
  useEffect(() => {
    const kisit = [...(alan ? [orderBy(alan, "desc")] : []), ...(adet ? [limit(adet)] : [])];
    return onSnapshot(kisit.length ? query(collection(db, ad), ...kisit) : collection(db, ad),
      sn => setV(sn.docs.map(x => ({ id:x.id, ...x.data() }))), e => console.error(ad, e));
  }, [ad, alan, adet]);
  return v;
}

// Başlangıçtan bu yılın sonrasına kadar (yıl sınırı yok)
function tumAylar() {
  const list = [];
  for (let y = START_YEAR; y <= Math.max(START_YEAR, curYear()) + 1; y++) {
    const mStart = y === START_YEAR ? START_MONTH : 0;
    for (let m = mStart; m < 12; m++) {
      list.push({ y, m, key:`${y}-${String(m + 1).padStart(2,"0")}` });
    }
  }
  return list;
}

function gecmisAylar() {
  const cur = curKey();
  return tumAylar().filter(a => a.key <= cur);
}

const DAIRES_SEED = Array.from({ length:10 }, (_,i) => ({
  id:`D${i+1}`, username:`d${i+1}`, ad:`Daire ${i+1}`,
  email:`d${i+1}@105numara.com`, sakinAd:"", tel:"", mail:"", aktif:true,
}));

const DURUM_LABEL = { odendi:"Ödendi", bekliyor:"Bekliyor", gecikti:"Gecikmiş" };
const KAT_COLORS  = {
  Bakım:{bg:"#FEF3C7",color:"#92400E"}, Aidat:{bg:"#DBEAFE",color:"#1E40AF"},
  Toplantı:{bg:"#D1FAE5",color:"#065F46"}, Acil:{bg:"#FEE2E2",color:"#991B1B"},
  Bilgi:{bg:"#F3F4F6",color:"#374151"},
};
const GID_KATS = ["Elektrik","Su","Personel","Bakım","Asansör","Temizlik","Sigorta","Vergi","Diğer"];

// ── ROOT ──────────────────────────────────────────────────────────────────
export default function App() {
  const [user,     setUser]     = useState(undefined);
  const [daireler, setDaireler] = useState([]);
  const [ayarlar,  setAyarlar]  = useState(null);
  const [dbReady,  setDbReady]  = useState(false);
  const [dbError,  setDbError]  = useState("");
  const [ayKey,    setAyKey]    = useState(curKey);
  const sessionTimeoutRef = useRef(null);

  // Ay değişince paneller yeniden kurulur (varsayılan ay/yıl seçimleri güncellenir)
  useEffect(() => {
    const t = setInterval(() => setAyKey(curKey()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Oturum durumu
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, u => {
      setUser(u || null);
      if (u) resetSessionTimeout();
      else clearTimeout(sessionTimeoutRef.current);
    });
    return () => { unsubscribe(); clearTimeout(sessionTimeoutRef.current); };
  }, []);

  function resetSessionTimeout() {
    clearTimeout(sessionTimeoutRef.current);
    sessionTimeoutRef.current = setTimeout(() => {
      signOut(auth).catch(e => console.error(e));
    }, SESSION_TIMEOUT);
  }

  // Hareketsizlik sayacı
  useEffect(() => {
    if (!user) return;
    const handler = () => resetSessionTimeout();
    const events = ["mousemove", "keypress", "click", "touchstart"];
    events.forEach(ev => window.addEventListener(ev, handler));
    return () => events.forEach(ev => window.removeEventListener(ev, handler));
  }, [user]);

  // Yakalanmayan yazma hataları (izin, ağ vb.) sessiz kalmasın
  useEffect(() => {
    const onReject = ev => {
      console.error(ev.reason);
      if (ev.reason?.code) alert("İşlem başarısız: " + hataMesaji(ev.reason));
    };
    window.addEventListener("unhandledrejection", onReject);
    return () => window.removeEventListener("unhandledrejection", onReject);
  }, []);

  // Veritabanı dinleyicileri — sadece giriş yapıldıktan sonra başlar.
  // (Giriş yapmadan Firestore'a bağlanmak, kurallar yüzünden sonsuz "Yükleniyor"a yol açıyordu.)
  useEffect(() => {
    if (!user) {
      setDaireler([]); setAyarlar(null); setDbReady(false); setDbError("");
      return;
    }
    const benimDaire = daireIdOf(user.email), admin = !benimDaire;
    setDbError("");

    const unsubAyar = onSnapshot(doc(db,"ayarlar","genel"), async snap => {
      try {
        if (snap.exists()) { setAyarlar(snap.data()); return; }
        const v = { aidatTutar:2500, aylikAidat:{} };
        if (admin) await setDoc(doc(db,"ayarlar","genel"), v);
        setAyarlar(v);
      } catch (e) { console.error(e); setDbError(hataMesaji(e)); }
    }, e => { console.error(e); setDbError(hataMesaji(e)); });

    const hata = e => { console.error(e); setDbError(hataMesaji(e)); };

    // Sakin yalnızca kendi daire belgesini okuyabilir (firestore.rules)
    if (!admin) {
      const unsubKendi = onSnapshot(doc(db,"daireler",benimDaire), snap => {
        setDaireler(snap.exists() ? [{ id:snap.id, ...snap.data() }] : []);
        setDbReady(true);
      }, hata);
      return () => { unsubAyar(); unsubKendi(); };
    }

    const unsubDaire = onSnapshot(collection(db,"daireler"), async snap => {
      try {
        if (snap.empty) {
          if (snap.metadata.fromCache) return; // sunucu yanıtını bekle
          const b = writeBatch(db);
          DAIRES_SEED.forEach(d => b.set(doc(db,"daireler",d.id), d));
          await b.commit();
          return; // seed sonrası snapshot tekrar tetiklenir
        } else {
          setDaireler(snap.docs.map(d => ({ id:d.id, ...d.data() })));
          setDbReady(true);
        }
      } catch (e) { console.error(e); setDbError(hataMesaji(e)); }
    }, e => { console.error(e); setDbError(hataMesaji(e)); });

    return () => { unsubAyar(); unsubDaire(); };
  }, [user?.uid]);

  if (user === undefined) return <Splash />;
  if (!user) return <Login />;
  if (dbError) return <HataEkrani mesaj={dbError} />;
  if (!dbReady || !ayarlar) return <Splash />;

  const benimDaire = daireIdOf(user.email);
  const daire      = benimDaire && daireler.find(d => d.id === benimDaire);

  if (!benimDaire) return <AdminPanel key={ayKey} daireler={daireler} ayarlar={ayarlar} />;
  if (daire)       return <DairePanel key={ayKey} daire={daire} ayarlar={ayarlar} />;
  return <HataEkrani mesaj="Hesap bir daireyle eşleşmiyor." />;
}

function HataEkrani({ mesaj }) {
  return (
    <div style={S.loginWrap}>
      <div style={S.loginCard}>
        <div style={{ fontSize:40,textAlign:"center",marginBottom:10 }}>⚠️</div>
        <p style={{ color:"#D85A30",textAlign:"center",marginBottom:16,fontSize:14,lineHeight:1.5 }}>{mesaj}</p>
        <button style={{ ...S.addBtn,width:"100%" }} onClick={()=>signOut(auth)}>Çıkış</button>
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div style={{ minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F9FAFB" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:52,marginBottom:12 }}>🏢</div>
        <div style={{ fontSize:16,fontWeight:700,color:"#111" }}>Mert Apartmanı No 105</div>
        <div style={{ fontSize:13,color:"#6B7280",marginTop:4 }}>Yükleniyor...</div>
        <div style={{ display:"flex",gap:6,justifyContent:"center",marginTop:20 }}>
          {[0,1,2].map(i=><div key={i} style={{ width:8,height:8,borderRadius:"50%",background:"#1D9E75",animation:"bounce 1s infinite",animationDelay:`${i*0.2}s` }}/>)}
        </div>
        <style>{`@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-10px)}}`}</style>
      </div>
    </div>
  );
}

function Login() {
  const [username,setUsername] = useState("");
  const [sifre,setSifre]       = useState("");
  const [hata,setHata]         = useState("");
  const [loading,setLoading]   = useState(false);

  async function giris() {
    if (!username||!sifre) { setHata("Kullanıcı adı ve şifre girin."); return; }
    setHata(""); setLoading(true);
    try {
      const u = username.trim().toLowerCase();
      // Daireler kısa ad (d3), yönetici tam e-posta ile girer
      const email = u.includes("@") ? u : `${u}@105numara.com`;
      await signInWithEmailAndPassword(auth, email, sifre);
    } catch (e) {
      console.error(e);
      const k = e?.code || "";
      if (k.includes("network")) setHata("Bağlantı hatası. İnternetinizi kontrol edin.");
      else if (k.includes("too-many-requests")) setHata("Çok fazla deneme yapıldı. Biraz bekleyip tekrar deneyin.");
      else if (k.includes("invalid-api-key") || k.includes("api-key")) setHata("Firebase API anahtarı geçersiz (" + k + ").");
      else if (k.includes("unauthorized-domain")) setHata("Bu alan adı Firebase'de yetkili değil (" + k + ").");
      else setHata("Kullanıcı adı veya şifre hatalı.");
    }
    setLoading(false);
  }

  return (
    <div style={S.loginWrap}>
      <div style={S.loginCard}>
        <div style={{ textAlign:"center",marginBottom:24 }}>
          <div style={{ fontSize:44,marginBottom:8 }}>🏢</div>
          <h1 style={S.loginTitle}>{APT_ADI}</h1>
        </div>
        <div style={S.field}><label style={S.label}>Kullanıcı Adı / E-posta</label>
          <input style={S.input} autoCapitalize="none" value={username}
            onChange={e=>setUsername(e.target.value)} onKeyDown={e=>e.key==="Enter"&&giris()}/></div>
        <div style={S.field}><label style={S.label}>Şifre</label>
          <input style={S.input} type="password" value={sifre}
            onChange={e=>setSifre(e.target.value)} onKeyDown={e=>e.key==="Enter"&&giris()}/></div>
        {hata&&<div style={S.hataBox}>{hata}</div>}
        <button style={{ ...S.addBtn,width:"100%",padding:12,fontSize:15,fontWeight:700,opacity:loading?0.7:1 }}
          onClick={giris} disabled={loading}>{loading?"Giriş yapılıyor...":"Giriş Yap"}</button>
      </div>
    </div>
  );
}

function Chips({ items, secili, onChange }) {
  return (
    <div className="chips no-print">
      {items.map(i => (
        <button key={String(i.v)} className={"chip" + (secili === i.v ? " on" : "")} onClick={()=>onChange(i.v)}>{i.l}</button>
      ))}
    </div>
  );
}

const Bos = ({ t }) => <p style={{ color:"#9CA3AF",padding:"16px 0",fontSize:13 }}>{t}</p>;

function AdminPanel({ daireler, ayarlar }) {
  const [tab,setTab] = useState("ozet");
  const tabs = [
    {id:"ozet",   icon:"📊",label:"Özet"},
    {id:"aidat",  icon:"💳",label:"Aidat"},
    {id:"gg",     icon:"💰",label:"Gelir-Gider"},
    {id:"borclar",icon:"🧾",label:"Borçlar"},
    {id:"rapor",  icon:"📑",label:"Rapor"},
    {id:"ayarlar",icon:"⚙️", label:"Ayarlar"},
  ];
  return (
    <div style={S.app}>
      <Topbar title={APT_ADI} sub="Yönetici Paneli" onCikis={()=>signOut(auth)} />
      <div className="desktop-nav" style={S.desktopNav}>
        {tabs.map(t=>(
          <button key={t.id} style={{ ...S.navBtn,...(tab===t.id?S.navActive:{}) }} onClick={()=>setTab(t.id)}>{t.icon} {t.label}</button>
        ))}
      </div>
      <div style={S.content}>
        {tab==="ozet"    && <TabOzet    daireler={daireler} ayarlar={ayarlar}/>}
        {tab==="aidat"   && <TabAidat   daireler={daireler} ayarlar={ayarlar}/>}
        {tab==="gg"      && <TabGelirGider/>}
        {tab==="borclar" && <TabBorclar daireler={daireler}/>}
        {tab==="rapor"   && <TabRapor   daireler={daireler}/>}
        {tab==="ayarlar" && <TabAyarlar daireler={daireler}/>}
      </div>
      <div className="mobile-nav" style={S.mobileNav}>
        {tabs.map(t=>(
          <button key={t.id} style={{ ...S.mobileNavBtn,...(tab===t.id?S.mobileNavActive:{}) }} onClick={()=>setTab(t.id)}>
            <span style={{ fontSize:17 }}>{t.icon}</span><span style={{ fontSize:10 }}>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── ÖZET ──────────────────────────────────────────────────────────────────
function TabOzet({ daireler, ayarlar }) {
  const odemeler = useCol("odemeler"), gelirler = useCol("gelirler","tarih"), giderler = useCol("giderler","tarih"), borclar = useCol("borclar");
  const cur = curKey(), aidat = aidatOf(ayarlar, cur);
  const odenenSet = new Set(odemeler.filter(o=>o.durum==="odendi").map(o=>`${o.daire}|${o.donem}`));
  const buAy = odemeler.filter(o=>o.donem===cur && o.durum==="odendi");
  const tahsilat = topla(buAy) - borclar.filter(b=>b.donem===cur).reduce((a,b)=>a+acikTutar(b),0), beklenen = daireler.length * aidat;
  const yuzde = beklenen ? Math.min(100, Math.round(tahsilat / beklenen * 100)) : 0;
  const gecmis = gecmisAylar().map(a=>a.key).filter(k=>k<cur);
  const geciken = daireler.map(d=>{
    const aylar = gecmis.filter(k=>!odenenSet.has(`${d.id}|${k}`));
    return { d, aylar, tutar:aylar.reduce((a,k)=>a+aidatOf(ayarlar,k),0) };
  }).filter(x=>x.aylar.length);
  const acikBorc = borclar.reduce((a,b)=>a+kalanOf(b),0);
  const kasa = topla(gelirler) - topla(giderler) - borclar.reduce((a,b)=>a+acikTutar(b),0);
  const son = [...gelirler.map(g=>({...g,t:"g"})), ...giderler.map(g=>({...g,t:"d"}))]
    .sort((a,b)=>(b.tarih||"").localeCompare(a.tarih||"")).slice(0,6);
  return (
    <div>
      <div className="metric-grid" style={S.metricGrid}>
        <MetricCard label="Bu Ay Tahsilat" val={`₺${fmt(tahsilat)}`} color="#1D9E75" sub={`%${yuzde} · ${buAy.length}/${daireler.length} daire`}/>
        <MetricCard label="Kalan Tahsilat" val={`₺${fmt(Math.max(0,beklenen-tahsilat))}`} color="#BA7517" sub={`Hedef ₺${fmt(beklenen)}`}/>
        <MetricCard label="Geciken" val={`${geciken.length} daire`} color={geciken.length?"#D85A30":"#1D9E75"} sub={`₺${fmt(geciken.reduce((a,x)=>a+x.tutar,0))}`}/>
        <MetricCard label="Kasa" val={`₺${fmt(kasa)}`} color={kasa>=0?"#1D9E75":"#D85A30"} sub={acikBorc?`Açık alacak ₺${fmt(acikBorc)} düşüldü`:"Açık alacak yok"}/>
      </div>
      <div style={S.card}>
        <div style={S.cardTitle}>{ayAdi(cur)} · Aidat ₺{fmt(aidat)}</div>
        <div style={{ ...S.barTrack,margin:"14px 0 6px" }}><div style={{ ...S.barFill,width:`${yuzde}%`,background:"#1D9E75" }}/></div>
        <div style={{ fontSize:12,color:"#6B7280" }}>{daireler.length-buAy.length} daire bekliyor</div>
      </div>
      <div className="two-col" style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
        <div style={S.card}>
          <div style={S.cardTitle}>⚠️ Geciken Ödemeler</div>
          {geciken.length===0 ? <Bos t="Geciken ödeme yok 🎉"/> : geciken.map(({d,aylar,tutar})=>(
            <div key={d.id} style={{ padding:"10px 0",borderBottom:"1px solid #F3F4F6" }}>
              <div style={{ display:"flex",justifyContent:"space-between",fontSize:13 }}>
                <b>{d.id} · {sakinAdi(d,cur)}</b><b style={{ color:"#D85A30" }}>₺{fmt(tutar)}</b>
              </div>
              <div style={{ fontSize:11,color:"#9CA3AF",marginTop:2 }}>{aylar.map(k=>MONTHS_SHORT[Number(k.slice(5))-1]).join(", ")} ({aylar.length} ay)</div>
            </div>
          ))}
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>🕒 Son Hareketler</div>
          {son.length===0 ? <Bos t="Kayıt yok"/> : son.map(g=>(
            <div key={g.t+g.id} style={{ padding:"10px 0",borderBottom:"1px solid #F3F4F6",display:"flex",justifyContent:"space-between",fontSize:13 }}>
              <div><div style={{ fontWeight:600 }}>{g.t==="g"?(g.kaynak||"").toUpperCase():g.kategori}</div><div style={{ fontSize:11,color:"#9CA3AF" }}>{g.tarih}</div></div>
              <b style={{ color:g.t==="g"?"#1D9E75":"#D85A30" }}>{g.t==="g"?"+":"-"}₺{fmt(g.tutar)}</b>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── AİDAT ─────────────────────────────────────────────────────────────────
function TabAidat({ daireler, ayarlar }) {
  const AYLAR = tumAylar(), cur = curKey();
  const [idx,setIdx] = useState(()=>Math.max(0, AYLAR.findIndex(a=>a.key===cur)));
  const [filtre,setFiltre] = useState("tumu");
  const [tutarStr,setTutarStr] = useState("");
  const [uygula,setUygula] = useState(false);
  const [busy,setBusy] = useState(false);
  const odemeler = useCol("odemeler"), borclar = useCol("borclar");
  const ay = AYLAR[idx], key = ay.key, ad = `${MONTH_NAMES[ay.m]} ${ay.y}`, gelecek = key > cur;
  const aidat = aidatOf(ayarlar, key);
  useEffect(()=>{ setTutarStr(String(aidat)); setUygula(false); }, [key, aidat]);

  const om = Object.fromEntries(odemeler.filter(o=>o.donem===key && o.durum==="odendi").map(o=>[o.daire,o]));
  const eksikOf = id => borclar.filter(b=>b.daire===id && b.donem===key).reduce((a,b)=>a+acikTutar(b),0);
  const durumOf = d => om[d.id] ? "odendi" : (key < cur ? "gecikti" : "bekliyor");
  const rows = daireler.map(d=>({ ...d, durum:durumOf(d) })).filter(d=>filtre==="tumu" || d.durum===filtre);
  const say = dr => daireler.filter(d=>durumOf(d)===dr).length;

  async function tutarKaydet() {
    const v = Number(tutarStr);
    if (tutarStr==="" || !(v>=0)) return alert("Geçerli bir tutar girin.");
    const hedef = (uygula ? AYLAR.slice(idx) : [ay]).map(a=>a.key);
    // Tahsil edilmiş aidat kayıtları bilerek değiştirilmez; yeni tutar yalnızca ödenmemiş aylara uygulanır
    const b = writeBatch(db);
    b.set(doc(db,"ayarlar","genel"), { aylikAidat:Object.fromEntries(hedef.map(k=>[k,v])) }, { merge:true });
    logEkle(b, `${ad} aidat tutarı: ₺${v}${uygula?" (sonraki aylar dahil)":""}`, "aidat_update");
    await b.commit();
    const eskiTutarli = odemeler.filter(o=>o.durum==="odendi" && hedef.includes(o.donem) && o.tutar!==v).length;
    alert("Kaydedildi." + (eskiTutarli ? `\n${eskiTutarli} ödenmiş kayıt tahsil edildiği tutarda kaldı.` : ""));
  }

  async function toggle(d) {
    if (gelecek || busy) return;
    setBusy(true);
    try {
      const mevcut = om[d.id];
      if (mevcut) {
        const gelir = await aidatGeliriBul(mevcut, ad);
        const b = writeBatch(db);
        b.delete(doc(db,"odemeler",mevcut.id));
        if (gelir) b.delete(doc(db,"gelirler",gelir.id));
        // Makbuz silinmez, iptal olarak işaretlenir: QR ile bakan "iptal edildi" görür
        if (mevcut.makbuzId) b.update(doc(db,"makbuzlar",mevcut.makbuzId), { iptal:true, iptalTarihi:bugun() });
        logEkle(b, `${d.id} ${ad} ödeme iptal${mevcut.makbuzNo?` (makbuz ${mevcut.makbuzNo} iptal)`:""}`, "odeme_cancel");
        await b.commit();
      } else {
        // Eski düzende rastgele kimlikle girilmiş kayıt var mı? (ekrana henüz yansımamış olabilir)
        const eski = await getDocs(query(collection(db,"odemeler"), where("daire","==",d.id), where("donem","==",key)));
        if (eski.docs.some(x=>x.data().durum==="odendi")) return alert(`${d.id} ${ad} zaten ödenmiş görünüyor.`);
        const tutar = aidat, sakin = sakinAdi(d, key);
        const odemeRef = doc(db,"odemeler",odemeId(d.id,key)), gelirRef = doc(db,"gelirler",`aidat_${odemeId(d.id,key)}`);
        // Sabit kimlik + transaction: aynı daire/ay iki kez ödenemez; ödeme, gelir ve log birlikte yazılır
        await runTransaction(db, async tx => {
          if ((await tx.get(odemeRef)).exists()) throw new Error(`${d.id} ${ad} zaten ödenmiş.`);
          tx.set(odemeRef, { daire:d.id, donem:key, donemAd:ad, tutar, durum:"odendi", tarih:bugun(), sakinAd:sakin, olusturuldu:serverTimestamp() });
          tx.set(gelirRef, { kaynak:"aidat", daire:d.id, donem:key, odemeId:odemeRef.id, tutar, tarih:bugun(), not:`${d.id} ${sakin} - ${ad} aidatı`, otomatik:true, olusturuldu:serverTimestamp() });
          logEkle(tx, `${d.id} ${ad} ödeme kaydı`, "odeme_record");
        });
      }
    } catch (e) {
      console.error(e);
      alert("İşlem başarısız: " + hataMesaji(e));
    } finally { setBusy(false); }
  }

  async function makbuzGonder(d) {
    const o = om[d.id];
    if (!o || busy) return;
    if (!MAIL_RE.test(d.mail || "")) return alert(`${d.id} için e-posta adresi girilmemiş.\nAyarlar → Daire Sakinleri → Düzelt ile ekleyin.`);
    if (!window.confirm(`${d.id} · ${sakinAdi(d,key)}\n${d.mail} adresine ${ad} makbuzu ${o.makbuzGonderim?"TEKRAR ":""}gönderilsin mi?`)) return;
    setBusy(true);
    try { alert(gonderimOzeti(await makbuzlariGonder([o]))); }
    catch (e) { console.error(e); alert("Makbuz gönderilemedi: " + hataMesaji(e)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div style={S.card}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",gap:8 }}>
          <button style={S.arrowBtn} onClick={()=>setIdx(i=>Math.max(0,i-1))}>‹</button>
          <span style={{ fontSize:17,fontWeight:700 }}>{ad}</span>
          <button style={S.arrowBtn} onClick={()=>setIdx(i=>Math.min(AYLAR.length-1,i+1))}>›</button>
        </div>
        <div style={{ marginTop:16,paddingTop:14,borderTop:"1px solid #F3F4F6" }}>
          <label style={S.label}>Bu ay toplanması gereken aidat (₺)</label>
          <div style={{ display:"flex",gap:8,marginTop:6 }}>
            <input style={{ ...S.input,flex:1,fontWeight:700,fontSize:18 }} type="number" inputMode="numeric" value={tutarStr} onChange={e=>setTutarStr(e.target.value)}/>
            <button style={S.addBtn} onClick={tutarKaydet}>Kaydet</button>
          </div>
          <label style={{ display:"flex",gap:8,alignItems:"center",fontSize:12,color:"#6B7280",marginTop:10 }}>
            <input type="checkbox" checked={uygula} onChange={e=>setUygula(e.target.checked)}/> Sonraki aylara da uygula
          </label>
          <div style={{ fontSize:11,color:"#9CA3AF",marginTop:6 }}>Yalnızca seçilen ay(lar)ı etkiler; ödenmiş kayıtlar tahsil edildiği tutarda kalır.</div>
        </div>
      </div>
      {gelecek ? (
        <div style={{ ...S.card,textAlign:"center",padding:"32px 20px" }}><div style={{ fontSize:32 }}>📅</div><div style={{ fontWeight:600,marginTop:6 }}>{ad} henüz gelmedi</div></div>
      ) : (
        <>
          <Chips secili={filtre} onChange={setFiltre} items={[{v:"tumu",l:"Tümü"},{v:"odendi",l:`Ödendi (${say("odendi")})`},{v:"bekliyor",l:`Bekliyor (${say("bekliyor")})`},{v:"gecikti",l:`Gecikmiş (${say("gecikti")})`}]}/>
          <div style={S.card}>
            <div style={{ overflowX:"auto" }}>
              <table style={S.table}>
                <thead><tr><th style={S.th}>Daire</th><th style={S.th}>Sakin</th><th style={S.th}>Tutar</th><th style={S.th}>Tarih</th><th style={S.th}>Durum</th><th style={S.th}></th></tr></thead>
                <tbody>{rows.map(d=>(
                  <tr key={d.id}>
                    <td style={S.td}><b>{d.id}</b></td>
                    <td style={S.td}>{sakinAdi(d,key)}</td>
                    <td style={S.td}>₺{fmt(om[d.id]?om[d.id].tutar:aidat)}{eksikOf(d.id)>0 && <div style={{ fontSize:10,color:"#D85A30" }}>alacak ₺{fmt(eksikOf(d.id))}</div>}</td>
                    <td style={S.td}>{om[d.id]?.tarih||"—"}</td>
                    <td style={S.td}><span style={{ ...S.badge,...DURUM_STIL[d.durum] }}>{DURUM_LABEL[d.durum]}</span>
                      {om[d.id]?.makbuzGonderim && <div style={{ fontSize:10,color:"#1E40AF",marginTop:3 }} title={`${om[d.id].makbuzNo} → ${om[d.id].makbuzGonderim.email}`}>📧 {om[d.id].makbuzGonderim.tarih.slice(8)}.{om[d.id].makbuzGonderim.tarih.slice(5,7)} gönderildi</div>}</td>
                    <td style={{ ...S.td,whiteSpace:"nowrap",textAlign:"right" }}>
                      {d.durum==="odendi" && (
                        <button style={{ ...S.smallBtn,fontSize:11,marginRight:6,borderColor:"#93C5FD",color:"#1E40AF" }} disabled={busy}
                          title={d.mail ? `Makbuzu ${d.mail} adresine gönder` : "E-posta adresi yok (Ayarlar)"} onClick={()=>makbuzGonder(d)}>
                          📧 {om[d.id]?.makbuzGonderim ? "Tekrar gönder" : "Makbuz gönder"}
                        </button>
                      )}
                      <button style={{ ...S.smallBtn,fontSize:11,borderColor:d.durum==="odendi"?"#fca5a5":"#6ee7b7",color:d.durum==="odendi"?"#991B1B":"#065F46" }} disabled={busy} onClick={()=>toggle(d)}>
                        {d.durum==="odendi"?"İptal":"✓ Ödendi"}
                      </button>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── GELİR–GİDER (tek sayfa) ───────────────────────────────────────────────
function Kolon({ baslik, koleksiyon, alan, secenekler, liste, renk, isaret, ay }) {
  const bos = () => ({ [alan]:secenekler[0], tutar:"", tarih:(ay==="tumu"||ay===curKey())?bugun():`${ay}-01`, not:"" });
  const [goster,setGoster] = useState(false);
  const [form,setForm] = useState(bos());
  const set = (k,v) => setForm(p=>({ ...p,[k]:v }));
  const btn = koleksiyon==="giderler" ? { background:"linear-gradient(135deg,#E5484D,#C7332F)", boxShadow:"0 2px 8px rgba(229,72,77,.3)" } : {};
  async function ekle() {
    if (!form.tutar) return;
    await addDoc(collection(db,koleksiyon), { ...form, tutar:Number(form.tutar), olusturuldu:serverTimestamp() });
    logAction(`${baslik}: ${form[alan]} ₺${form.tutar}`, koleksiyon+"_create");
    setGoster(false);
  }
  async function sil(g) {
    if (!window.confirm(g.otomatik ? "Bu kayıt aidat/borç ödemesiyle oluşmuş. Yine de silinsin mi?" : "Silinsin mi?")) return;
    await deleteDoc(doc(db,koleksiyon,g.id));
    logAction(`${baslik} kaydı silindi`, koleksiyon+"_delete");
  }
  return (
    <div style={S.card}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
        <div style={S.cardTitle}>{baslik}</div>
        <b style={{ color:renk,fontSize:16 }}>{isaret}₺{fmt(topla(liste))}</b>
      </div>
      <button style={{ ...S.addBtn,...btn,margin:"12px 0",width:"100%" }} onClick={()=>{ setForm(bos()); setGoster(g=>!g); }}>{goster?"Vazgeç":"+ Ekle"}</button>
      {goster && (
        <div style={{ display:"grid",gap:8,marginBottom:14,padding:12,background:"#F9FAFB",borderRadius:12 }}>
          <select style={S.select} value={form[alan]} onChange={e=>set(alan,e.target.value)}>{secenekler.map(k=><option key={k}>{k}</option>)}</select>
          <input style={S.input} type="number" inputMode="numeric" placeholder="Tutar (₺)" value={form.tutar} onChange={e=>set("tutar",e.target.value)}/>
          <input style={S.input} type="date" value={form.tarih} onChange={e=>set("tarih",e.target.value)}/>
          <input style={S.input} placeholder="Not (isteğe bağlı)" value={form.not} onChange={e=>set("not",e.target.value)}/>
          <button style={{ ...S.addBtn,...btn }} onClick={ekle}>Kaydet</button>
        </div>
      )}
      {liste.length===0 ? <Bos t="Kayıt yok"/> : liste.map(g=>(
        <div key={g.id} style={{ padding:"11px 0",borderBottom:"1px solid #F3F4F6",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8 }}>
          <div style={{ minWidth:0 }}>
            <div style={{ fontWeight:600,fontSize:13,textTransform:"capitalize" }}>{g[alan]}</div>
            <div style={{ fontSize:11,color:"#9CA3AF",overflow:"hidden",textOverflow:"ellipsis" }}>{g.tarih}{g.not?` · ${g.not}`:""}</div>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:6,flex:"none" }}>
            <b style={{ color:renk,fontSize:13 }}>{isaret}₺{fmt(g.tutar)}</b>
            <button style={{ ...S.delBtn,padding:"4px 8px" }} onClick={()=>sil(g)}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function TabGelirGider() {
  const gelirler = useCol("gelirler","tarih"), giderler = useCol("giderler","tarih");
  const [yil,setYil] = useState(curYear);
  const [ay,setAy] = useState(curMonth);
  const mKey = m => `${yil}-${String(m+1).padStart(2,"0")}`;
  const yillar = [...new Set([String(curYear()), ...gelirler.map(k=>gelirAy(k).slice(0,4)), ...giderler.map(k=>ayOf(k.tarih).slice(0,4))])].filter(Boolean).sort().reverse().map(Number);
  const dolu = new Set([...gelirler.map(gelirAy), ...giderler.map(k=>ayOf(k.tarih))]);
  const sec = ay==="tumu" ? "tumu" : mKey(ay);
  const uyar = key => sec==="tumu" ? key.startsWith(`${yil}-`) : key===sec;
  const gel = gelirler.filter(k=>uyar(gelirAy(k))), gid = giderler.filter(k=>uyar(ayOf(k.tarih)));
  const net = topla(gel) - topla(gid);
  return (
    <div>
      <Chips secili={yil} onChange={v=>{ setYil(v); setAy("tumu"); }} items={yillar.map(y=>({v:y,l:String(y)}))}/>
      <Chips secili={ay} onChange={setAy} items={[{v:"tumu",l:"Tüm yıl"}, ...MONTHS_SHORT.map((l,m)=>({v:m,l:dolu.has(mKey(m))?`${l} •`:l}))]}/>
      <div style={{ display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:12 }}>
        <b style={{ fontSize:16 }}>{sec==="tumu" ? `${yil} yılı` : ayAdi(sec)}</b>
        <span style={{ ...S.badge,background:net>=0?"#D1FAE5":"#FEE2E2",color:net>=0?"#065F46":"#991B1B",fontSize:13 }}>Net: {net<0?"-":""}₺{fmt(Math.abs(net))}</span>
      </div>
      <div className="two-col" style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,alignItems:"start" }}>
        <Kolon baslik="💰 Gelirler" koleksiyon="gelirler" alan="kaynak" secenekler={["aidat","kira","bağış","borç tahsilatı","diğer"]} liste={gel} renk="#1D9E75" isaret="+" ay={sec}/>
        <Kolon baslik="📉 Giderler" koleksiyon="giderler" alan="kategori" secenekler={GID_KATS} liste={gid} renk="#D85A30" isaret="-" ay={sec}/>
      </div>
    </div>
  );
}

// ── BORÇLAR (alacaklarımız: sadece not + açık/kapalı) ─────────────────────
function TabBorclar({ daireler }) {
  const borclar = useCol("borclar"), odemeler = useCol("odemeler");
  const AYLAR = gecmisAylar().reverse(), cur = curKey();
  const [f,setF] = useState("acik");
  const [goster,setGoster] = useState(false);
  const [form,setForm] = useState({ daire:"D1", donem:cur, eksik:"", not:"" });
  const dMap = Object.fromEntries(daireler.map(d=>[d.id,d]));
  const eski = borclar.filter(b=>b.model!==2);

  async function ekle() {
    const eksik = Number(form.eksik);
    if (!(eksik>0)) return alert("Eksik tutarı girin.");
    const a = AYLAR.find(x=>x.key===form.donem), adAy = `${MONTH_NAMES[a.m]} ${a.y}`;
    await addDoc(collection(db,"borclar"), { daire:form.daire, donem:form.donem, donemAd:adAy, eksik, kapali:false, model:2, not:form.not, tarih:bugun(), olusturuldu:serverTimestamp() });
    logAction(`${form.daire} ${adAy} eksik ödeme (alacak): ₺${eksik}`, "borc_create");
    setGoster(false); setForm(p=>({ ...p,eksik:"",not:"" }));
  }
  async function kapat(b, kapali) {
    await updateDoc(doc(db,"borclar",b.id), { kapali, kapanis:kapali?bugun():"" });
    logAction(`${b.daire} ${b.donemAd} alacak ${kapali?"kapatıldı":"yeniden açıldı"}`, "borc_update");
  }
  async function sil(b) {
    if (!window.confirm("Kayıt silinsin mi?")) return;
    await deleteDoc(doc(db,"borclar",b.id));
    logAction(`${b.daire} ${b.donemAd} alacak kaydı silindi`, "borc_delete");
  }
  // Eski düzen: eksik tutar aidat gelirinden düşülmüş, tahsilat ayrı gelir olarak eklenmişti → yeni düzene çevir
  async function donustur() {
    if (!window.confirm(`${eski.length} eski kayıt yeni düzene çevrilecek (aidat geliri tam tutara döner, tahsilat gelirleri silinir). Devam edilsin mi?`)) return;
    // Her borç kaydı kendi batch'inde: bir kayıt yarıda kalırsa kısmen değişmiş kayıt oluşmaz
    for (const b of eski) {
      const kalan = Math.max(0,(b.eksik||0)-(b.odenen||0));
      let eksik = b.eksik || 0;
      const w = writeBatch(db);
      const od = odemeler.find(o=>o.daire===b.daire && o.donem===b.donem && o.durum==="odendi");
      if (od) {
        w.update(doc(db,"odemeler",od.id), { tutar:increment(eksik) });
        const g = await aidatGeliriBul(od, b.donemAd || ayAdi(b.donem));
        if (g) w.update(doc(db,"gelirler",g.id), { tutar:increment(eksik) });
        const tahs = await getDocs(query(collection(db,"gelirler"), where("borcId","==",b.id)));
        tahs.docs.forEach(t => w.delete(t.ref));
        if (kalan>0) eksik = kalan;
      }
      w.update(doc(db,"borclar",b.id), { model:2, eksik, kapali:kalan===0, kapanis:kalan===0?bugun():"" });
      logEkle(w, `${b.daire} ${b.donemAd||b.donem} eski borç kaydı yeni düzene çevrildi`, "borc_migrate");
      await w.commit();
    }
  }

  const liste = borclar.filter(b=>f==="tumu" || (f==="acik"?kalanOf(b)>0:kalanOf(b)===0))
    .sort((a,b)=>String(b.donem).localeCompare(String(a.donem)));
  const acik = borclar.reduce((a,b)=>a+acikTutar(b),0);
  const kapanan = topla(borclar.filter(b=>b.model===2 && b.kapali).map(b=>({ tutar:b.eksik })));
  return (
    <div>
      {eski.length>0 && (
        <div style={{ ...S.card,borderLeft:"3px solid #BA7517" }}>
          <div style={{ fontWeight:700,marginBottom:6 }}>⚠️ {eski.length} kayıt eski düzende</div>
          <div style={{ fontSize:12,color:"#6B7280",marginBottom:10 }}>Kasa hesabının doğru çıkması için yeni düzene çevirin.</div>
          <button style={S.addBtn} onClick={donustur}>Yeni düzene çevir</button>
        </div>
      )}
      <div className="metric-grid" style={{ ...S.metricGrid,gridTemplateColumns:"repeat(2,1fr)" }}>
        <MetricCard label="Açık Alacak" val={`₺${fmt(acik)}`} color={acik?"#D85A30":"#1D9E75"} sub="Kasadan düşülüyor"/>
        <MetricCard label="Kapanan" val={`₺${fmt(kapanan)}`} color="#1D9E75" sub="Kasaya geri döndü"/>
      </div>
      <button style={{ ...S.addBtn,marginBottom:12 }} onClick={()=>setGoster(g=>!g)}>{goster?"Vazgeç":"+ Eksik Ödeme Ekle"}</button>
      {goster && (
        <div style={S.card}>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
            <div><label style={S.label}>Daire</label>
              <select style={S.select} value={form.daire} onChange={e=>setForm(p=>({...p,daire:e.target.value}))}>
                {daireler.map(d=><option key={d.id} value={d.id}>{d.id} · {sakinAdi(d,form.donem)}</option>)}</select></div>
            <div><label style={S.label}>Ay</label>
              <select style={S.select} value={form.donem} onChange={e=>setForm(p=>({...p,donem:e.target.value}))}>
                {AYLAR.map(a=><option key={a.key} value={a.key}>{MONTH_NAMES[a.m]} {a.y}</option>)}</select></div>
            <div><label style={S.label}>Alacağımız tutar (₺)</label>
              <input style={S.input} type="number" inputMode="numeric" value={form.eksik} onChange={e=>setForm(p=>({...p,eksik:e.target.value}))}/></div>
            <div><label style={S.label}>Not</label>
              <input style={S.input} placeholder="Örn: kalanı gelecek ay" value={form.not} onChange={e=>setForm(p=>({...p,not:e.target.value}))}/></div>
          </div>
          <div style={{ fontSize:11,color:"#9CA3AF",margin:"10px 0" }}>Aidat kaydı değişmez. Bu tutar, “Kapatıldı” diyene kadar kasadan düşülür.</div>
          <button style={S.addBtn} onClick={ekle}>Kaydet</button>
        </div>
      )}
      <Chips secili={f} onChange={setF} items={[{v:"acik",l:"Açık"},{v:"kapali",l:"Kapatıldı"},{v:"tumu",l:"Tümü"}]}/>
      <div style={S.card}>
        {liste.length===0 ? <Bos t="Kayıt yok"/> : liste.map(b=>(
          <div key={b.id} style={{ padding:"12px 0",borderBottom:"1px solid #F3F4F6" }}>
            <div style={{ display:"flex",justifyContent:"space-between",gap:8 }}>
              <div><b>{b.daire}</b> · {dMap[b.daire]?sakinAdi(dMap[b.daire],b.donem):""}
                <div style={{ fontSize:11,color:"#9CA3AF" }}>{b.donemAd}{b.not?` · ${b.not}`:""}</div></div>
              <div style={{ textAlign:"right" }}>
                <b style={{ color:kalanOf(b)?"#D85A30":"#1D9E75" }}>₺{fmt(b.eksik)}</b>
                <div><span style={{ ...S.badge,...(kalanOf(b)?DURUM_STIL.bekliyor:DURUM_STIL.odendi) }}>{kalanOf(b)?"Açık":"Kapatıldı"}</span></div>
              </div>
            </div>
            <div style={{ display:"flex",gap:8,marginTop:8 }}>
              {b.model===2 && (b.kapali
                ? <button style={{ ...S.smallBtn,fontSize:12 }} onClick={()=>kapat(b,false)}>Yeniden aç</button>
                : <button style={{ ...S.smallBtn,borderColor:"#6ee7b7",color:"#065F46",fontSize:12 }} onClick={()=>kapat(b,true)}>✓ Kapatıldı</button>)}
              <button style={{ ...S.delBtn,padding:"6px 10px" }} onClick={()=>sil(b)}>Sil</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── RAPOR (görsel + PDF çıktısı) ──────────────────────────────────────────
const PALET = ["#1D9E75","#0891B2","#6366F1","#BA7517","#D85A30","#8B5CF6","#EC4899","#64748B"];
const kisa = n => n >= 1000 ? `${Math.round(n/100)/10}b`.replace(".",",") : String(Math.round(n));

function AylikGrafik({ aylik, ay, onSec }) {
  const max = Math.max(1, ...aylik.flatMap(r=>[r.g,r.d]));
  const H = 150, T = 12, gw = 50, X0 = 34, W = X0 + gw*12;
  const y = v => T + H - v/max*H;
  return (
    <svg viewBox={`0 0 ${W} ${T+H+24}`} style={{ width:"100%",height:"auto",display:"block" }} role="img" aria-label="Aylık gelir gider grafiği">
      {[0,.5,1].map(f=>(
        <g key={f}>
          <line x1={X0} x2={W} y1={y(max*f)} y2={y(max*f)} stroke="#EEF0F3" strokeDasharray={f?"3 3":"0"}/>
          <text x={X0-6} y={y(max*f)+3} textAnchor="end" fontSize="9" fill="#9CA3AF">{kisa(max*f)}</text>
        </g>
      ))}
      {aylik.map(r=>{
        const x = X0 + r.m*gw;
        return (
          <g key={r.m} onClick={()=>onSec(r.m)} style={{ cursor:"pointer" }}>
            {ay===r.m && <rect x={x+2} y={T-6} width={gw-4} height={H+30} rx="8" fill="#ECFDF5"/>}
            <rect x={x+gw/2-14} y={y(r.g)} width="13" height={r.g/max*H} rx="3" fill="#1D9E75"/>
            <rect x={x+gw/2+1}  y={y(r.d)} width="13" height={r.d/max*H} rx="3" fill="#D85A30"/>
            <text x={x+gw/2} y={T+H+15} textAnchor="middle" fontSize="10" fontWeight={ay===r.m?700:500} fill={ay===r.m?"#065F46":"#6B7280"}>{MONTHS_SHORT[r.m]}</text>
            <rect x={x} y={T-6} width={gw} height={H+30} fill="transparent"/>
            <title>{`${MONTH_NAMES[r.m]}: gelir ₺${fmt(r.g)} · gider ₺${fmt(r.d)}`}</title>
          </g>
        );
      })}
    </svg>
  );
}

function Donut({ baslik, liste, toplam }) {
  const R = 42, C = 2*Math.PI*R;
  let off = 0;
  return (
    <div style={S.card}>
      <div style={S.cardTitle}>{baslik}</div>
      {liste.length===0 ? <Bos t="Veri yok"/> : (
        <div style={{ display:"flex",gap:14,alignItems:"center",flexWrap:"wrap",marginTop:8 }}>
          <svg viewBox="0 0 120 120" width="128" height="128" style={{ flex:"none" }}>
            <g transform="rotate(-90 60 60)">
              <circle cx="60" cy="60" r={R} fill="none" stroke="#F3F4F6" strokeWidth="16"/>
              {liste.map(([ad,t],i)=>{
                const len = toplam ? t/toplam*C : 0, el = (
                  <circle key={ad} cx="60" cy="60" r={R} fill="none" stroke={PALET[i%PALET.length]} strokeWidth="16"
                    strokeDasharray={`${len} ${C-len}`} strokeDashoffset={-off}/>);
                off += len; return el;
              })}
            </g>
            <text x="60" y="57" textAnchor="middle" fontSize="8" fill="#9CA3AF">Toplam</text>
            <text x="60" y="71" textAnchor="middle" fontSize="12" fontWeight="700" fill="#111827">₺{fmt(toplam)}</text>
          </svg>
          <div style={{ flex:1,minWidth:150 }}>
            {liste.map(([ad,t],i)=>(
              <div key={ad} style={{ display:"flex",alignItems:"center",gap:8,padding:"5px 0",fontSize:12 }}>
                <span style={{ width:10,height:10,borderRadius:3,background:PALET[i%PALET.length],flex:"none" }}/>
                <span style={{ flex:1,textTransform:"capitalize" }}>{ad}</span>
                <b>₺{fmt(t)}</b><span style={{ color:"#9CA3AF",width:34,textAlign:"right" }}>%{Math.round(t/toplam*100)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TabRapor({ daireler }) {
  const odemeler = useCol("odemeler"), gelirler = useCol("gelirler","tarih"), giderler = useCol("giderler","tarih"), borclar = useCol("borclar");
  const [yil,setYil] = useState(curYear);
  const [ay,setAy] = useState("tumu");
  const cur = curKey(), startKey = gecmisAylar()[0].key;
  const mKey = m => `${yil}-${String(m+1).padStart(2,"0")}`;
  const bas = ay==="tumu" ? mKey(0) : mKey(ay), son = ay==="tumu" ? mKey(11) : mKey(ay);
  const inP = key => key >= bas && key <= son;
  const yillar = [...new Set([String(curYear()), ...gelirler.map(gelirAy).map(k=>k.slice(0,4)), ...giderler.map(k=>ayOf(k.tarih).slice(0,4))])].filter(Boolean).sort().reverse().map(Number);
  const gel = gelirler.filter(k=>inP(gelirAy(k))), gid = giderler.filter(k=>inP(ayOf(k.tarih)));
  const tG = topla(gel), tD = topla(gid);
  const alacak = borclar.filter(b=>inP(b.donem)).reduce((a,b)=>a+acikTutar(b),0);
  const net = tG - tD - alacak;
  const donem = ay==="tumu" ? `${yil} yılı` : `${MONTH_NAMES[ay]} ${yil}`;
  const aylik = MONTH_NAMES.map((ad,m)=>({ m, ad,
    g:topla(gelirler.filter(k=>gelirAy(k)===mKey(m))), d:topla(giderler.filter(k=>ayOf(k.tarih)===mKey(m))) }));
  const dagilim = (l,alan) => {
    const o = {}; l.forEach(k=>{ const e = k[alan]||"Diğer"; o[e] = (o[e]||0)+(k.tutar||0); });
    return Object.entries(o).sort((a,b)=>b[1]-a[1]);
  };
  const odenenSet = new Set(odemeler.filter(o=>o.durum==="odendi").map(o=>`${o.daire}|${o.donem}`));
  const acikSet = new Set(borclar.filter(b=>acikTutar(b)>0).map(b=>`${b.daire}|${b.donem}`));
  // Tahsilat oranı: dönemdeki (başlangıç–bugün arası) beklenen aidat sayısına göre
  const donemAylari = Array.from({length:12},(_,m)=>mKey(m)).filter(k=>inP(k) && k>=startKey && k<=cur);
  const beklenenSayi = donemAylari.length * daireler.length;
  const odenenSayi = daireler.reduce((a,d)=>a+donemAylari.filter(k=>odenenSet.has(`${d.id}|${k}`)).length,0);
  const oran = beklenenSayi ? Math.round(odenenSayi/beklenenSayi*100) : 0;
  const daireRows = daireler.map(d=>{
    const aidatOd = odemeler.filter(o=>o.daire===d.id && o.durum==="odendi" && inP(o.donem));
    const acik = borclar.filter(b=>b.daire===d.id && inP(b.donem)).reduce((a,b)=>a+acikTutar(b),0);
    return { d, ay:aidatOd.length, toplam:topla(aidatOd)-acik, acik };
  });
  const maxD = Math.max(1, ...daireRows.map(r=>r.toplam));
  const th = { ...S.th,textAlign:"right" }, tdr = { ...S.td,textAlign:"right" };
  const hucre = (d,key) => {
    if (key < startKey) return { bg:"#F3F4F6", t:"Kayıt öncesi" };
    if (odenenSet.has(`${d.id}|${key}`)) return { bg:"#1D9E75", t:"Ödendi" };
    if (key > cur) return { bg:"#F3F4F6", t:"Henüz gelmedi" };
    return key === cur ? { bg:"#F5B942", t:"Bekliyor" } : { bg:"#E5484D", t:"Gecikmiş" };
  };
  // Seçili ayın makbuzları: ödeyenler, e-postası olanlar, henüz gönderilmemişler
  const dMap = Object.fromEntries(daireler.map(d=>[d.id,d]));
  const odeyenler = ay==="tumu" ? [] : odemeler.filter(o=>o.donem===mKey(ay) && o.durum==="odendi").sort((a,b)=>a.daire.localeCompare(b.daire,"tr",{numeric:true}));
  const mailli = odeyenler.filter(o=>MAIL_RE.test(dMap[o.daire]?.mail || ""));
  const gonderilmemis = mailli.filter(o=>!o.makbuzGonderim);
  const [gonderiyor,setGonderiyor] = useState(false);
  async function topluGonder() {
    const hedef = gonderilmemis.length ? gonderilmemis : mailli;
    const eksik = odeyenler.filter(o=>!mailli.includes(o)).map(o=>o.daire);
    const soru = [
      `${donem} makbuzları ${hedef.length} daireye ${gonderilmemis.length ? "" : "TEKRAR "}gönderilecek:`,
      hedef.map(o=>`${o.daire} → ${dMap[o.daire].mail}`).join("\n"),
      eksik.length ? `\nE-postası olmadığı için atlanacak: ${eksik.join(", ")}` : "",
      "\nDevam edilsin mi?",
    ].join("\n");
    if (!window.confirm(soru)) return;
    setGonderiyor(true);
    try { alert(gonderimOzeti(await makbuzlariGonder(hedef))); }
    catch (e) { console.error(e); alert("Makbuzlar gönderilemedi: " + hataMesaji(e)); }
    finally { setGonderiyor(false); }
  }

  const Liste = ({ baslik, liste, alan, renk }) => (
    <div style={S.card}>
      <div style={S.cardTitle}>{baslik}</div>
      {liste.length===0 ? <Bos t="Kayıt yok"/> : (
        <table style={S.table}><thead><tr><th style={S.th}>Tarih</th><th style={S.th}>Kalem</th><th style={S.th}>Açıklama</th><th style={th}>Tutar</th></tr></thead>
          <tbody>{liste.map(g=>(<tr key={g.id}><td style={S.td}>{g.tarih}</td><td style={{ ...S.td,textTransform:"capitalize" }}>{g[alan]}</td><td style={S.td}>{g.not||"—"}</td><td style={{ ...tdr,color:renk }}>₺{fmt(g.tutar)}</td></tr>))}
            <tr><td style={{ ...S.td,fontWeight:700,borderBottom:"none" }} colSpan={3}>Toplam</td><td style={{ ...tdr,fontWeight:700,borderBottom:"none" }}>₺{fmt(topla(liste))}</td></tr></tbody></table>
      )}
    </div>
  );
  return (
    <div className="rapor">
      <div className="print-only" style={{ marginBottom:14 }}>
        <div style={{ fontSize:20,fontWeight:700 }}>{APT_ADI}</div>
        <div style={{ fontSize:13 }}>Gelir–Gider Raporu · {donem} · Çıktı tarihi: {bugun()}</div>
      </div>
      <div className="no-print" style={{ display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap" }}>
        <div style={{ fontSize:18,fontWeight:700 }}>📑 Rapor · {donem}</div>
        <button style={S.addBtn} onClick={()=>window.print()}>📄 PDF / Yazdır</button>
      </div>
      <Chips secili={yil} onChange={v=>{ setYil(v); setAy("tumu"); }} items={yillar.map(y=>({v:y,l:String(y)}))}/>
      <Chips secili={ay} onChange={setAy} items={[{v:"tumu",l:"Tüm yıl"}, ...MONTHS_SHORT.map((l,m)=>({v:m,l}))]}/>

      <div className="no-print" style={{ ...S.card,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap",borderLeft:"3px solid #3B82F6" }}>
        <div>
          <div style={S.cardTitle}>📧 Dijital Makbuzlar · {ay==="tumu" ? "ay seçin" : donem}</div>
          <div style={{ fontSize:12,color:"#6B7280",marginTop:4 }}>
            {ay==="tumu" ? "Makbuz göndermek için yukarıdan bir ay seçin."
              : `Ödeyen ${odeyenler.length} · e-postası olan ${mailli.length} · gönderilmiş ${mailli.length-gonderilmemis.length}`}
          </div>
        </div>
        {ay!=="tumu" && (
          <button style={{ ...S.addBtn,background:"linear-gradient(135deg,#3B82F6,#1D4ED8)",boxShadow:"0 2px 8px rgba(59,130,246,.3)",opacity:(gonderiyor||!mailli.length)?.6:1 }}
            disabled={gonderiyor || !mailli.length} onClick={topluGonder}>
            {gonderiyor ? "Gönderiliyor..." : gonderilmemis.length ? `Makbuzları gönder (${gonderilmemis.length})` : mailli.length ? "Tümünü tekrar gönder" : "E-posta adresi yok"}
          </button>
        )}
      </div>

      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(135px,1fr))",gap:12,marginBottom:16 }}>
        <MetricCard label="Toplam Gelir" val={`₺${fmt(tG)}`} color="#1D9E75"/>
        <MetricCard label="Toplam Gider" val={`₺${fmt(tD)}`} color="#D85A30"/>
        <MetricCard label="Açık Alacak" val={`₺${fmt(alacak)}`} color="#BA7517"/>
        <MetricCard label="Net Kasa" val={`${net<0?"-":""}₺${fmt(Math.abs(net))}`} color={net>=0?"#1D9E75":"#D85A30"}/>
        <MetricCard label="Tahsilat Oranı" val={`%${oran}`} color="#6366F1" sub={`${odenenSayi}/${beklenenSayi} aidat`}/>
      </div>

      <div style={S.card}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6 }}>
          <div style={S.cardTitle}>📊 {yil} Aylık Gelir – Gider</div>
          <div style={{ display:"flex",gap:12,fontSize:11,color:"#6B7280" }}>
            <span><span style={{ color:"#1D9E75" }}>■</span> Gelir</span><span><span style={{ color:"#D85A30" }}>■</span> Gider</span>
          </div>
        </div>
        <AylikGrafik aylik={aylik} ay={ay} onSec={m=>setAy(ay===m?"tumu":m)}/>
        <div className="no-print" style={{ fontSize:11,color:"#9CA3AF",marginTop:4 }}>Bir aya dokunarak o ayı seçebilirsiniz.</div>
      </div>

      <div className="two-col" style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
        <Donut baslik={`💰 Gelir Kaynakları · ${donem}`} liste={dagilim(gel,"kaynak")} toplam={tG}/>
        <Donut baslik={`📉 Gider Kategorileri · ${donem}`} liste={dagilim(gid,"kategori")} toplam={tD}/>
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>🗓️ {yil} Ödeme Takvimi</div>
        <div style={{ display:"grid",gridTemplateColumns:"minmax(54px,auto) repeat(12,1fr)",gap:3,marginTop:10,alignItems:"center" }}>
          <span/>{MONTHS_SHORT.map((l,m)=>(<span key={l} style={{ fontSize:9,textAlign:"center",color:ay===m?"#065F46":"#9CA3AF",fontWeight:ay===m?700:500 }}>{l}</span>))}
          {daireler.map(d=>(
            <div key={d.id} style={{ display:"contents" }}>
              <span style={{ fontSize:11,fontWeight:600,paddingRight:6 }}>{d.id}</span>
              {Array.from({length:12},(_,m)=>{ const h = hucre(d,mKey(m)), acikVar = acikSet.has(`${d.id}|${mKey(m)}`); return (
                <span key={m} title={`${d.id} · ${MONTH_NAMES[m]}: ${h.t}${acikVar?" · açık alacak var":""}`}
                  style={{ background:h.bg,borderRadius:5,height:20,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:"#fff",outline:ay===m?"2px solid #A7F3D0":"none" }}>{acikVar?"!":""}</span>); })}
            </div>
          ))}
        </div>
        <div style={{ display:"flex",gap:12,flexWrap:"wrap",fontSize:11,color:"#6B7280",marginTop:12 }}>
          {[["#1D9E75","Ödendi"],["#F5B942","Bekliyor"],["#E5484D","Gecikmiş"],["#F3F4F6","Kayıt dışı / gelecek"]].map(([c,t])=>(
            <span key={t}><span style={{ display:"inline-block",width:10,height:10,borderRadius:3,background:c,marginRight:5,border:"1px solid #E5E7EB" }}/>{t}</span>))}
          <span><b style={{ color:"#D85A30" }}>!</b> açık alacak</span>
        </div>
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>🏠 Daire Bazlı Ödemeler · {donem}</div>
        <div style={{ overflowX:"auto" }}>
          <table style={S.table}><thead><tr><th style={S.th}>Daire</th><th style={S.th}>Sakin</th><th style={th}>Aidat (ay)</th><th style={{ ...th,minWidth:120 }}>Toplam Ödenen</th><th style={th}>Açık Borç</th></tr></thead>
            <tbody>{daireRows.map(r=>(<tr key={r.d.id}>
              <td style={S.td}><b>{r.d.id}</b></td><td style={S.td}>{sakinlar(r.d,bas,son)}</td><td style={tdr}>{r.ay}</td>
              <td style={tdr}><b style={{ color:"#1D9E75" }}>₺{fmt(r.toplam)}</b>
                <div style={{ height:5,background:"#F3F4F6",borderRadius:9,marginTop:4 }}><div style={{ height:5,borderRadius:9,background:"#1D9E75",width:`${Math.max(0,r.toplam)/maxD*100}%` }}/></div></td>
              <td style={{ ...tdr,color:r.acik?"#D85A30":"#9CA3AF" }}>{r.acik?`₺${fmt(r.acik)}`:"—"}</td></tr>))}
              <tr><td style={{ ...S.td,fontWeight:700,borderBottom:"none" }} colSpan={3}>Toplam</td>
                <td style={{ ...tdr,fontWeight:700,borderBottom:"none" }}>₺{fmt(daireRows.reduce((a,r)=>a+r.toplam,0))}</td>
                <td style={{ ...tdr,fontWeight:700,borderBottom:"none" }}>₺{fmt(daireRows.reduce((a,r)=>a+r.acik,0))}</td></tr></tbody></table>
        </div>
      </div>

      <Liste baslik={`💰 Gelir Kalemleri · ${donem}`} liste={gel} alan="kaynak" renk="#1D9E75"/>
      <Liste baslik={`📉 Gider Kalemleri · ${donem}`} liste={gid} alan="kategori" renk="#D85A30"/>
    </div>
  );
}

// ── AYARLAR: Daire sakinleri + denetim logu ───────────────────────────────
function TabAyarlar({ daireler }) {
  const [alt,setAlt] = useState("daireler");
  const logs = useCol("auditLog","olusturuldu",50);
  const [yedekDurum,setYedekDurum] = useState("");
  async function yedekAl() {
    setYedekDurum("Hazırlanıyor...");
    try {
      const ozet = await yedekIndir();
      setYedekDurum(`İndirildi (${ozet})`);
      logAction("Veri yedeği indirildi", "backup");
    } catch (e) { console.error(e); setYedekDurum("Yedek alınamadı: " + hataMesaji(e)); }
  }
  const [sec,setSec] = useState(null);
  const [mod,setMod] = useState("degistir");
  const [f,setF] = useState({ ad:"", tel:"", mail:"", bas:curKey() });
  const cur = curKey(), AYLAR = tumAylar();
  function ac(d, m) { const dz = m==="duzenle"; setSec(d); setMod(m); setF({ ad:dz?sakinAdi(d,cur):"", tel:dz?(d.tel||""):"", mail:dz?(d.mail||""):"", bas:cur }); }
  async function kaydet() {
    const ad = f.ad.trim(), mail = f.mail.trim().toLowerCase();
    if (!ad) return alert("Sakin adını girin.");
    if (mail && !MAIL_RE.test(mail)) return alert("E-posta adresi geçerli görünmüyor.");
    const g = sec.sakinGecmis?.length ? [...sec.sakinGecmis] : [{ ad:sec.sakinAd||sec.ad, baslangic:"0000-00" }];
    let yeni;
    if (mod==="duzenle") { // yazım düzeltmesi: şu an geçerli kaydın adını düzeltir
      const i = g.reduce((acc,e,ix)=>e.baslangic<=cur?ix:acc, 0);
      yeni = g.map((e,ix)=>ix===i?{ ...e, ad }:e);
    } else { // sakin değişimi: eski kayıtlar korunur, yeni ad seçilen aydan itibaren geçerli
      yeni = [...g.filter(e=>e.baslangic!==f.bas), { ad, baslangic:f.bas }].sort((a,b)=>a.baslangic.localeCompare(b.baslangic));
    }
    await updateDoc(doc(db,"daireler",sec.id), { sakinGecmis:yeni, sakinAd:sakinAdi({ ...sec, sakinGecmis:yeni }, cur), tel:f.tel, mail });
    logAction(`${sec.id} ${mod==="duzenle"?"düzeltme":"sakin değişimi"}: ${ad}${mod==="degistir"?` (${ayAdi(f.bas)}'den itibaren)`:""}`, "daire_update");
    setSec(null);
  }
  return (
    <div>
      <Chips secili={alt} onChange={setAlt} items={[{v:"daireler",l:"🏠 Daire Sakinleri"},{v:"audit",l:"📜 Denetim Logu"},{v:"yedek",l:"💾 Yedek"}]}/>
      {alt==="yedek" && (
        <div style={S.card}>
          <div style={S.cardTitle}>💾 Veri Yedeği</div>
          <div style={{ fontSize:12,color:"#6B7280",margin:"8px 0 12px",lineHeight:1.5 }}>
            Tüm kayıtları (daireler, ödemeler, gelir-gider, borçlar, ayarlar, denetim logu) tek bir JSON dosyası olarak indirir.
            Büyük değişikliklerden önce ve ayda bir alıp güvenli bir yerde saklayın.
          </div>
          <button style={S.addBtn} onClick={yedekAl} disabled={yedekDurum==="Hazırlanıyor..."}>Yedeği indir (JSON)</button>
          {yedekDurum && <div style={{ fontSize:12,color:"#6B7280",marginTop:10 }}>{yedekDurum}</div>}
        </div>
      )}
      {alt==="daireler" && (
        <>
          {sec && (
            <div style={{ ...S.card,borderLeft:"3px solid #1D9E75" }}>
              <div style={{ fontWeight:700,marginBottom:12 }}>{sec.id} · {mod==="duzenle"?"Bilgi düzelt":"Sakin değiştir"}</div>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
                <div><label style={S.label}>{mod==="duzenle"?"Ad Soyad":"Yeni sakin adı"}</label><input style={S.input} value={f.ad} onChange={e=>setF(p=>({...p,ad:e.target.value}))}/></div>
                <div><label style={S.label}>Telefon</label><input style={S.input} value={f.tel} onChange={e=>setF(p=>({...p,tel:e.target.value}))}/></div>
                <div><label style={S.label}>E-posta (makbuz için)</label><input style={S.input} type="email" inputMode="email" autoCapitalize="none" placeholder="ornek@mail.com" value={f.mail} onChange={e=>setF(p=>({...p,mail:e.target.value}))}/></div>
                {mod==="degistir" && <div><label style={S.label}>Geçerli olduğu ilk ay</label>
                  <select style={S.select} value={f.bas} onChange={e=>setF(p=>({...p,bas:e.target.value}))}>{AYLAR.map(a=><option key={a.key} value={a.key}>{MONTH_NAMES[a.m]} {a.y}</option>)}</select></div>}
              </div>
              <div style={{ fontSize:11,color:"#9CA3AF",margin:"10px 0" }}>
                {mod==="degistir" ? "Önceki aylardaki kayıtlar eski sakinin adıyla kalır. " : ""}
                Giriş şifresi için: Firebase Console → Authentication → Users’tan {sec.email} kullanıcısını silip yeni şifreyle yeniden ekleyin.
              </div>
              <div style={{ display:"flex",gap:8 }}><button style={S.addBtn} onClick={kaydet}>Kaydet</button><button style={S.filterBtn} onClick={()=>setSec(null)}>İptal</button></div>
            </div>
          )}
          <div style={S.card}>
            <div style={S.cardTitle}>🏠 Daire Sakinleri</div>
            <table style={S.table}>
              <thead><tr><th style={S.th}>Daire</th><th style={S.th}>Sakin</th><th style={S.th}>Telefon</th><th style={S.th}>E-posta</th><th style={S.th}></th></tr></thead>
              <tbody>{daireler.map(d=>(
                <tr key={d.id}>
                  <td style={S.td}><b>{d.id}</b></td>
                  <td style={S.td}>{sakinAdi(d,cur)}{(d.sakinGecmis||[]).length>1 && <div style={{ fontSize:10,color:"#9CA3AF" }}>Önceki: {d.sakinGecmis.filter(e=>e.baslangic<=cur).slice(0,-1).map(e=>e.ad).join(", ")||"—"}</div>}</td>
                  <td style={S.td}>{d.tel||"—"}</td>
                  <td style={{ ...S.td,fontSize:12,wordBreak:"break-all" }}>{d.mail || <span style={{ color:"#D85A30" }}>eklenmedi</span>}</td>
                  <td style={{ ...S.td,whiteSpace:"nowrap" }}>
                    <button style={{ ...S.smallBtn,fontSize:11,marginRight:6 }} onClick={()=>ac(d,"duzenle")}>Düzelt</button>
                    <button style={{ ...S.smallBtn,fontSize:11,borderColor:"#93C5FD",color:"#1E40AF" }} onClick={()=>ac(d,"degistir")}>Sakin Değiştir</button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
      {alt==="audit" && (
        <div style={S.card}>
          <div style={S.cardTitle}>📜 Denetim Logu (Son 50)</div>
          {logs.length===0 ? <Bos t="Kayıt yok"/> : (
            <table style={S.table}><thead><tr><th style={S.th}>Tarih</th><th style={S.th}>Saat</th><th style={S.th}>Detay</th></tr></thead>
              <tbody>{logs.map(l=>(<tr key={l.id}><td style={S.td}>{l.tarih}</td><td style={S.td}>{l.saat}</td><td style={S.td}>{l.detay}</td></tr>))}</tbody></table>
          )}
        </div>
      )}
    </div>
  );
}

// ── DAİRE PANELİ ──────────────────────────────────────────────────────────
function DairePanel({ daire, ayarlar }) {
  const cur = curKey();
  const [odemeler,setOdemeler] = useState([]);
  const [borclar,setBorclar] = useState([]);
  useEffect(()=>{
    const map = sn => sn.docs.map(x=>({ id:x.id, ...x.data() }));
    const u1 = onSnapshot(query(collection(db,"odemeler"),where("daire","==",daire.id)), sn=>setOdemeler(map(sn).sort((a,b)=>String(b.donem).localeCompare(String(a.donem)))), e=>console.error(e));
    const u2 = onSnapshot(query(collection(db,"borclar"),where("daire","==",daire.id)), sn=>setBorclar(map(sn).sort((a,b)=>String(b.donem).localeCompare(String(a.donem)))), e=>console.error(e));
    return ()=>{ u1(); u2(); };
  }, [daire.id]);
  const odendiMi = odemeler.some(o=>o.donem===cur && o.durum==="odendi");
  const durum = odendiMi ? "odendi" : "bekliyor";
  const kalan = kalanOf;
  const acikBorc = borclar.reduce((a,b)=>a+kalan(b),0);
  return (
    <div style={S.app}>
      <Topbar title={APT_ADI} sub={`${daire.id} · ${sakinAdi(daire,cur)}`} onCikis={()=>signOut(auth)} />
      <div style={S.content}>
        <div style={{ ...S.heroCard,borderLeft:`4px solid ${odendiMi?"#1D9E75":"#BA7517"}` }}>
          <div style={{ fontSize:12,color:"#9CA3AF",marginBottom:6,fontWeight:600 }}>{ayAdi(cur)} aidatı</div>
          <div style={{ fontSize:34,fontWeight:700,marginBottom:10 }}>₺{fmt(aidatOf(ayarlar,cur))}</div>
          <span style={{ ...S.badge,...DURUM_STIL[durum] }}>{DURUM_LABEL[durum]}</span>
          {acikBorc>0 && <span style={{ ...S.badge,...DURUM_STIL.gecikti,marginLeft:8 }}>Açık borç ₺{fmt(acikBorc)}</span>}
        </div>
        {borclar.length>0 && (
          <div style={S.card}>
            <div style={S.cardTitle}>🧾 Borç / Eksik Ödemeler</div>
            {borclar.map(b=>(
              <div key={b.id} style={{ padding:"10px 0",borderBottom:"1px solid #F3F4F6",display:"flex",justifyContent:"space-between",fontSize:13 }}>
                <div><b>{b.donemAd}</b><div style={{ fontSize:11,color:"#9CA3AF" }}>{b.not||"—"}</div></div>
                <b style={{ color:kalan(b)?"#D85A30":"#1D9E75" }}>{kalan(b)?`₺${fmt(kalan(b))} kalan`:"Kapandı"}</b>
              </div>
            ))}
          </div>
        )}
        <div style={S.card}>
          <div style={S.cardTitle}>📋 Ödeme Geçmişi</div>
          {odemeler.length===0 ? <Bos t="Kayıt yok"/> : (
            <table style={S.table}><thead><tr><th style={S.th}>Dönem</th><th style={S.th}>Tutar</th><th style={S.th}>Tarih</th></tr></thead>
              <tbody>{odemeler.map(o=>(<tr key={o.id}><td style={S.td}>{o.donemAd||o.donem}</td><td style={S.td}>₺{fmt(o.tutar)}</td><td style={S.td}>{o.tarih||"—"}</td></tr>))}</tbody></table>
          )}
        </div>
      </div>
    </div>
  );
}

function logKaydi(detay, tur) {
  const user = auth.currentUser;
  const kullanici = daireIdOf(user?.email) ? user.email.split("@")[0] : "admin";
  return { kullanici, detay, tur, tarih:bugun(), saat:new Date().toLocaleTimeString("tr-TR"), olusturuldu:serverTimestamp() };
}

// Log kaydını bir batch / transaction'a ekler: işlemle birlikte yazılır ya da hiç yazılmaz
function logEkle(yazici, detay, tur) {
  yazici.set(doc(collection(db,"auditLog")), logKaydi(detay, tur));
}

async function logAction(detay, tur) {
  try {
    if (!auth.currentUser) return;
    await addDoc(collection(db,"auditLog"), logKaydi(detay, tur));
  } catch (e) { console.error("auditLog yazılamadı:", e); }
}

// ── DİJİTAL MAKBUZ ────────────────────────────────────────────────────────
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Ödemenin makbuzunu bir kez düzenler (yıl içinde sıralı numara + tahmin edilemez doğrulama kodu).
// Makbuz zaten varsa aynı kodu döndürür: tekrar gönderimde numara değişmez.
async function makbuzHazirla(odeme) {
  return runTransaction(db, async tx => {
    const oRef = doc(db,"odemeler",odeme.id), sRef = doc(db,"ayarlar","makbuzSayac");
    const o = await tx.get(oRef), s = await tx.get(sRef);
    if (!o.exists() || o.data().durum !== "odendi") throw new Error("ödeme kaydı bulunamadı");
    const od = o.data();
    if (od.makbuzId) return od.makbuzId;
    const yil = curYear(), sira = (s.exists() ? Number(s.data()[yil] || 0) : 0) + 1, no = makbuzNo(yil, sira);
    const mRef = doc(collection(db,"makbuzlar"));  // 20 karakterlik rastgele kod = QR doğrulama anahtarı
    const donemAd = od.donemAd || ayAdi(od.donem);
    tx.set(sRef, { [yil]:sira }, { merge:true });
    // Herkese açık kayıt: tam ad, e-posta, telefon yok
    tx.set(mRef, { no, daire:od.daire, donem:od.donem, donemAd, tutar:od.tutar, odemeTarihi:od.tarih || "",
      duzenlenme:bugun(), sakinMaskeli:maskele(od.sakinAd), odemeId:o.id, iptal:false, olusturuldu:serverTimestamp() });
    tx.update(oRef, { makbuzId:mRef.id, makbuzNo:no });
    logEkle(tx, `${od.daire} ${donemAd} makbuz düzenlendi: ${no}`, "makbuz_create");
    return mRef.id;
  });
}

// Makbuzları hazırlar ve /api/makbuz-gonder ile e-postalar; başarılı gönderimleri kaydeder
async function makbuzlariGonder(odemeler) {
  const hatalar = [], hazir = [];
  for (const o of odemeler) {
    try { hazir.push({ o, kod:await makbuzHazirla(o) }); }
    catch (e) { hatalar.push(`${o.daire}: ${e.message}`); }
  }
  const token = await auth.currentUser.getIdToken();
  const sonuc = [];
  let onizleme = false;
  for (let i = 0; i < hazir.length; i += 10) {
    const parca = hazir.slice(i, i + 10);
    const r = await fetch("/api/makbuz-gonder", {
      method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${token}` },
      body:JSON.stringify({ makbuzlar:parca.map(x=>x.kod) }),
    });
    const j = await r.json().catch(() => ({ hata:`Sunucu yanıtı okunamadı (${r.status})` }));
    if (!r.ok) throw new Error(j.hata || `Gönderim başarısız (${r.status})`);
    onizleme = j.onizleme;
    sonuc.push(...j.sonuc.map(s => ({ ...s, o:parca.find(x=>x.kod===s.kod).o })));
  }
  const ok = sonuc.filter(s=>s.durum==="gonderildi");
  if (ok.length) {
    const b = writeBatch(db);
    ok.forEach(s => {
      b.update(doc(db,"odemeler",s.o.id), { makbuzGonderim:{ email:s.email, tarih:bugun(), saat:new Date().toLocaleTimeString("tr-TR"), onizleme } });
      b.update(doc(db,"makbuzlar",s.kod), { gonderimSayisi:increment(1), sonGonderim:bugun() });
    });
    logEkle(b, `${ok.length} makbuz e-postayla ${onizleme?"(önizleme) ":""}gönderildi: ${ok.map(s=>s.o.daire).join(", ")}`, "makbuz_send");
    await b.commit();
  }
  hatalar.push(...sonuc.filter(s=>s.durum==="hata").map(s=>`${s.o.daire}: ${s.mesaj}`));
  return { ok, hatalar, onizleme };
}

function gonderimOzeti({ ok, hatalar, onizleme }) {
  return [
    onizleme ? "ÖNİZLEME MODU: Gmail ayarı olmadığı için e-posta gönderilmedi, makbuzlar dosyaya kaydedildi." : "",
    ok.length ? `✓ ${ok.length} makbuz gönderildi: ${ok.map(s=>`${s.o.daire} → ${s.email}`).join(", ")}` : "",
    hatalar.length ? `✕ Gönderilemeyen:\n${hatalar.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

// Tüm koleksiyonları tek JSON dosyası olarak indirir (kurallar / taşıma öncesi yedek)
const YEDEK_KOLEKSIYONLAR = ["ayarlar","daireler","odemeler","gelirler","giderler","borclar","makbuzlar","auditLog"];
async function yedekIndir() {
  const duz = v => v && typeof v.toDate === "function" ? v.toDate().toISOString()
    : Array.isArray(v) ? v.map(duz)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, duz(x)])) : v;
  const veri = { proje:"ays105", alindi:new Date().toISOString() };
  for (const ad of YEDEK_KOLEKSIYONLAR) {
    veri[ad] = (await getDocs(collection(db, ad))).docs.map(x => ({ id:x.id, ...duz(x.data()) }));
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(veri, null, 2)], { type:"application/json" }));
  const a = Object.assign(document.createElement("a"), { href:url, download:`ays105-yedek-${bugun()}.json` });
  a.click();
  URL.revokeObjectURL(url);
  return YEDEK_KOLEKSIYONLAR.map(ad => `${ad}: ${veri[ad].length}`).join(", ");
}

function Topbar({title,sub,onCikis}) {
  return (
    <div className="no-print" style={S.topbar}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={S.logoBox}>🏢</div>
        <div><div style={S.topTitle}>{title}</div><div style={S.topSub}>{sub}</div></div>
      </div>
      <button style={S.cikisBtn} onClick={onCikis}>Çıkış</button>
    </div>
  );
}

function MetricCard({label,val,color,sub}) {
  return (
    <div style={S.metricCard}>
      <div style={S.metricLabel}>{label}</div>
      <div style={{...S.metricVal,color:color||"#111"}}>{val}</div>
      {sub&&<div style={S.metricSub}>{sub}</div>}
    </div>
  );
}

const S={
  app:{fontFamily:"'DM Sans',system-ui,sans-serif",minHeight:"100vh",background:"#F9FAFB",paddingBottom:72},
  topbar:{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 20px",background:"#fff",borderBottom:"1px solid #E5E7EB",position:"sticky",top:0,zIndex:10},
  logoBox:{width:38,height:38,background:"#1D9E75",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20},
  topTitle:{fontSize:15,fontWeight:700,color:"#111"},
  topSub:{fontSize:11,color:"#6B7280"},
  cikisBtn:{fontSize:12,padding:"6px 14px",border:"1px solid #E5E7EB",borderRadius:8,background:"transparent",cursor:"pointer",color:"#6B7280"},
  desktopNav:{display:"flex",gap:4,padding:"8px 20px",background:"#fff",borderBottom:"1px solid #E5E7EB",overflowX:"auto"},
  navBtn:{padding:"8px 14px",borderRadius:8,border:"none",background:"transparent",cursor:"pointer",fontSize:13,color:"#6B7280",whiteSpace:"nowrap",fontWeight:500},
  navActive:{background:"#ECFDF5",color:"#065F46",fontWeight:700},
  mobileNav:{display:"flex",position:"fixed",bottom:0,left:0,right:0,background:"#fff",borderTop:"1px solid #E5E7EB",zIndex:20},
  mobileNavBtn:{flex:1,padding:"8px 4px",border:"none",background:"transparent",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",fontSize:14,color:"#9CA3AF"},
  mobileNavActive:{color:"#1D9E75"},
  content:{padding:"16px 20px",maxWidth:960,margin:"0 auto"},
  metricGrid:{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:16},
  metricCard:{background:"#fff",borderRadius:12,padding:"14px 16px",border:"1px solid #E5E7EB"},
  metricLabel:{fontSize:11,color:"#9CA3AF",marginBottom:4,textTransform:"uppercase",letterSpacing:"0.05em",fontWeight:600},
  metricVal:{fontSize:22,fontWeight:700,color:"#111"},
  metricSub:{fontSize:11,color:"#9CA3AF",marginTop:3},
  card:{background:"#fff",border:"1px solid #E5E7EB",borderRadius:14,padding:"16px 20px",marginBottom:16},
  cardHeader:{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14},
  cardTitle:{fontSize:14,fontWeight:700,color:"#111"},
  heroCard:{background:"#fff",border:"1px solid #E5E7EB",borderRadius:14,padding:"20px",marginBottom:16},
  table:{width:"100%",borderCollapse:"collapse",fontSize:13},
  th:{textAlign:"left",fontWeight:600,fontSize:11,color:"#9CA3AF",padding:"0 0 10px",borderBottom:"1px solid #E5E7EB",textTransform:"uppercase"},
  td:{padding:"10px 0",borderBottom:"1px solid #F3F4F6",color:"#111"},
  badge:{display:"inline-flex",alignItems:"center",padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:600},
  barTrack:{height:10,background:"#F3F4F6",borderRadius:5,overflow:"hidden"},
  barFill:{height:"100%",borderRadius:5},
  field:{marginBottom:12},
  label:{display:"block",fontSize:12,fontWeight:600,color:"#6B7280",marginBottom:5},
  input:{width:"100%",padding:"9px 12px",border:"1px solid #E5E7EB",borderRadius:8,fontSize:14,background:"#fff",color:"#111"},
  select:{width:"100%",padding:"9px 12px",border:"1px solid #E5E7EB",borderRadius:8,fontSize:13,background:"#fff",color:"#111",cursor:"pointer"},
  addBtn:{padding:"9px 18px",background:"#1D9E75",color:"#fff",border:"none",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer"},
  smallBtn:{padding:"5px 12px",background:"transparent",border:"1px solid #E5E7EB",borderRadius:6,fontSize:12,cursor:"pointer"},
  delBtn:{padding:"4px 9px",background:"transparent",border:"1px solid #F3F4F6",borderRadius:6,fontSize:12,cursor:"pointer",color:"#D1D5DB"},
  filterBtn:{padding:"6px 14px",border:"1px solid #E5E7EB",borderRadius:20,fontSize:12,background:"transparent",cursor:"pointer",color:"#6B7280"},
  filterActive:{background:"#1D9E75",color:"#fff",borderColor:"#1D9E75"},
  arrowBtn:{width:36,height:36,border:"1px solid #E5E7EB",borderRadius:8,background:"#fff",cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",color:"#374151"},
  loginWrap:{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F9FAFB"},
  loginCard:{background:"#fff",border:"1px solid #E5E7EB",borderRadius:16,padding:"36px 32px",width:"100%",maxWidth:380},
  loginTitle:{fontSize:26,fontWeight:700,textAlign:"center",color:"#111"},
  loginSub:{fontSize:13,textAlign:"center",color:"#9CA3AF"},
  loginHint:{marginTop:20,padding:12,background:"#F9FAFB",borderRadius:8,fontSize:11,color:"#9CA3AF",lineHeight:"1.6"},
  hataBox:{background:"#FEE2E2",color:"#991B1B",borderRadius:8,padding:"8px 12px",fontSize:12,marginBottom:10},
};

// ── Modern tasarım katmanı ────────────────────────────────────────────────
const GOLGE = "0 1px 2px rgba(16,24,40,.04), 0 4px 16px rgba(16,24,40,.05)";
const TEMA = {
  app:{ background:"#F6F7F9" },
  topbar:{ background:"rgba(255,255,255,.85)", backdropFilter:"saturate(180%) blur(12px)", borderBottom:"1px solid #EEF0F3" },
  desktopNav:{ background:"#fff", borderBottom:"1px solid #EEF0F3", padding:"10px 20px", gap:6 },
  navBtn:{ borderRadius:999, padding:"9px 16px", transition:"all .15s" },
  navActive:{ background:"#E8F7F1", color:"#0B6B4D" },
  mobileNav:{ background:"rgba(255,255,255,.92)", backdropFilter:"blur(12px)", borderTop:"1px solid #EEF0F3", paddingBottom:"env(safe-area-inset-bottom)" },
  mobileNavBtn:{ minHeight:52, gap:2 },
  card:{ border:"1px solid #EEF0F3", borderRadius:18, padding:"18px 20px", boxShadow:GOLGE },
  heroCard:{ border:"1px solid #EEF0F3", borderRadius:18, boxShadow:GOLGE },
  metricCard:{ border:"1px solid #EEF0F3", borderRadius:16, padding:"16px 18px", boxShadow:GOLGE },
  metricVal:{ fontSize:24, letterSpacing:"-0.02em", fontVariantNumeric:"tabular-nums" },
  addBtn:{ background:"linear-gradient(135deg,#1D9E75,#15805F)", borderRadius:10, padding:"11px 18px", boxShadow:"0 2px 8px rgba(29,158,117,.28)", transition:"transform .1s" },
  filterBtn:{ borderRadius:999, padding:"8px 14px", background:"#fff" },
  smallBtn:{ borderRadius:8, padding:"7px 12px" },
  input:{ borderRadius:10, padding:"11px 12px", border:"1px solid #E1E4E8" },
  select:{ borderRadius:10, padding:"11px 12px", border:"1px solid #E1E4E8" },
  td:{ padding:"12px 0", fontVariantNumeric:"tabular-nums" },
  loginCard:{ borderRadius:22, boxShadow:"0 8px 40px rgba(16,24,40,.08)", border:"1px solid #EEF0F3" },
  loginWrap:{ background:"linear-gradient(160deg,#ECFDF5 0%,#F6F7F9 55%)", padding:16 },
};
Object.keys(TEMA).forEach(k => { S[k] = { ...S[k], ...TEMA[k] }; });
