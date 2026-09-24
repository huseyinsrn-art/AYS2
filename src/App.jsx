import { useState, useEffect, useRef } from "react";
import { db, auth } from "./firebase.js";
import {
  collection, doc, setDoc, addDoc, deleteDoc, updateDoc,
  onSnapshot, query, orderBy, serverTimestamp, getDocs, where, increment
} from "firebase/firestore";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";

const fmt = (n) => new Intl.NumberFormat("tr-TR").format(Math.round(n || 0));
const MONTH_NAMES  = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
const MONTHS_SHORT = ["Oca","Şub","Mar","Nis","May","Haz","Tem","Ağu","Eyl","Eki","Kas","Ara"];
const NOW          = new Date();
const CUR_YEAR     = NOW.getFullYear();
const CUR_MONTH    = NOW.getMonth();
const ADMIN_EMAIL  = "huseyinsrn@gmail.com";
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
const curKey = () => `${CUR_YEAR}-${String(CUR_MONTH + 1).padStart(2, "0")}`;
const bugun  = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const topla  = l => l.reduce((a, k) => a + (k.tutar || 0), 0);
const ayOf   = t => (t || "").slice(0, 7);
const ayAdi  = key => { if (!key) return "Tarihsiz"; const [y, m] = key.split("-"); return `${MONTH_NAMES[Number(m) - 1] || m} ${y}`; };
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

// Bir dairenin belirli ayki aidat gelir kaydını bulur (iptal / düzeltme için)
async function aidatBul(daireId, key, adAy) {
  const gs = (await getDocs(query(collection(db, "gelirler"), where("daire", "==", daireId)))).docs.map(x => ({ id:x.id, ...x.data() }));
  return gs.find(g => g.kaynak === "aidat" && (g.donem === key || (g.not || "").includes(adAy + " aidat")));
}

function useCol(ad, alan) {
  const [v, setV] = useState([]);
  useEffect(() => onSnapshot(alan ? query(collection(db, ad), orderBy(alan, "desc")) : collection(db, ad),
    sn => setV(sn.docs.map(x => ({ id:x.id, ...x.data() }))), e => console.error(ad, e)), [ad, alan]);
  return v;
}

function tumAylar() {
  const list = [];
  for (let y = START_YEAR; y <= START_YEAR + 3; y++) {
    const mStart = y === START_YEAR ? START_MONTH : 0;
    for (let m = mStart; m < 12; m++) {
      list.push({ y, m, key:`${y}-${String(m + 1).padStart(2,"0")}` });
    }
  }
  return list;
}

function gecmisAylar() {
  return tumAylar().filter(a => a.y < CUR_YEAR || (a.y === CUR_YEAR && a.m <= CUR_MONTH));
}

const DAIRES_SEED = Array.from({ length:10 }, (_,i) => ({
  id:`D${i+1}`, username:`d${i+1}`, ad:`Daire ${i+1}`,
  email:`d${i+1}@105numara.com`, sakinAd:"", tel:"", aktif:true,
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
  const sessionTimeoutRef = useRef(null);

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
    const admin = user.email === ADMIN_EMAIL;
    setDbError("");

    const unsubAyar = onSnapshot(doc(db,"ayarlar","genel"), async snap => {
      try {
        if (snap.exists()) { setAyarlar(snap.data()); return; }
        const v = { aidatTutar:2500, aylikAidat:{} };
        if (admin) await setDoc(doc(db,"ayarlar","genel"), v);
        setAyarlar(v);
      } catch (e) { console.error(e); setDbError(hataMesaji(e)); }
    }, e => { console.error(e); setDbError(hataMesaji(e)); });

    const unsubDaire = onSnapshot(collection(db,"daireler"), async snap => {
      try {
        if (snap.empty) {
          if (snap.metadata.fromCache) return; // sunucu yanıtını bekle
          if (admin) {
            for (const d of DAIRES_SEED) await setDoc(doc(db,"daireler",d.id), d);
            return; // seed sonrası snapshot tekrar tetiklenir
          }
          setDaireler([]); setDbReady(true);
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

  const isAdmin    = user.email === ADMIN_EMAIL;
  const daire      = daireler.find(d => d.email === user.email);
  
  if (isAdmin) return <AdminPanel daireler={daireler} ayarlar={ayarlar} />;
  if (daire)   return <DairePanel daire={daire} ayarlar={ayarlar} />;
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
      const email = (u==="admin"||u===ADMIN_EMAIL.toLowerCase()) ? ADMIN_EMAIL
        : u.includes("@") ? u : `${u}@105numara.com`;
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
        <div style={S.field}><label style={S.label}>Kullanıcı Adı</label>
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
  const tahsilat = topla(buAy), beklenen = daireler.length * aidat;
  const yuzde = beklenen ? Math.min(100, Math.round(tahsilat / beklenen * 100)) : 0;
  const gecmis = gecmisAylar().map(a=>a.key).filter(k=>k<cur);
  const geciken = daireler.map(d=>{
    const aylar = gecmis.filter(k=>!odenenSet.has(`${d.id}|${k}`));
    return { d, aylar, tutar:aylar.reduce((a,k)=>a+aidatOf(ayarlar,k),0) };
  }).filter(x=>x.aylar.length);
  const acikBorc = borclar.reduce((a,b)=>a+Math.max(0,(b.eksik||0)-(b.odenen||0)),0);
  const kasa = topla(gelirler) - topla(giderler);
  const son = [...gelirler.map(g=>({...g,t:"g"})), ...giderler.map(g=>({...g,t:"d"}))]
    .sort((a,b)=>(b.tarih||"").localeCompare(a.tarih||"")).slice(0,6);
  return (
    <div>
      <div className="metric-grid" style={S.metricGrid}>
        <MetricCard label="Bu Ay Tahsilat" val={`₺${fmt(tahsilat)}`} color="#1D9E75" sub={`%${yuzde} · ${buAy.length}/${daireler.length} daire`}/>
        <MetricCard label="Kalan Tahsilat" val={`₺${fmt(Math.max(0,beklenen-tahsilat))}`} color="#BA7517" sub={`Hedef ₺${fmt(beklenen)}`}/>
        <MetricCard label="Geciken" val={`${geciken.length} daire`} color={geciken.length?"#D85A30":"#1D9E75"} sub={`₺${fmt(geciken.reduce((a,x)=>a+x.tutar,0))}`}/>
        <MetricCard label="Kasa" val={`₺${fmt(kasa)}`} color={kasa>=0?"#1D9E75":"#D85A30"} sub={acikBorc?`Açık borç ₺${fmt(acikBorc)}`:"Açık borç yok"}/>
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
  const eksikOf = id => borclar.filter(b=>b.daire===id && b.donem===key).reduce((a,b)=>a+(b.eksik||0),0);
  const durumOf = d => om[d.id] ? "odendi" : (key < cur ? "gecikti" : "bekliyor");
  const rows = daireler.map(d=>({ ...d, durum:durumOf(d) })).filter(d=>filtre==="tumu" || d.durum===filtre);
  const say = dr => daireler.filter(d=>durumOf(d)===dr).length;

  async function tutarKaydet() {
    const v = Number(tutarStr);
    if (tutarStr==="" || !(v>=0)) return alert("Geçerli bir tutar girin.");
    const hedef = (uygula ? AYLAR.slice(idx) : [ay]).map(a=>a.key);
    await setDoc(doc(db,"ayarlar","genel"), { aylikAidat:Object.fromEntries(hedef.map(k=>[k,v])) }, { merge:true });
    logAction(`${ad} aidat tutarı: ₺${v}${uygula?" (sonraki aylar dahil)":""}`, "aidat_update");
    alert("Kaydedildi.");
  }

  async function toggle(d) {
    if (gelecek || busy) return;
    setBusy(true);
    try {
      const mevcut = om[d.id];
      if (mevcut) {
        const gelir = await aidatBul(d.id, key, ad);
        await deleteDoc(doc(db,"odemeler",mevcut.id));
        if (gelir) await deleteDoc(doc(db,"gelirler",gelir.id));
        logAction(`${d.id} ${ad} ödeme iptal`, "odeme_cancel");
      } else {
        const tutar = Math.max(0, aidat - eksikOf(d.id)), sakin = sakinAdi(d, key);
        const ref = await addDoc(collection(db,"odemeler"), { daire:d.id, donem:key, donemAd:ad, tutar, durum:"odendi", tarih:bugun(), sakinAd:sakin, olusturuldu:serverTimestamp() });
        await addDoc(collection(db,"gelirler"), { kaynak:"aidat", daire:d.id, donem:key, odemeId:ref.id, tutar, tarih:bugun(), not:`${d.id} ${sakin} - ${ad} aidatı`, otomatik:true, olusturuldu:serverTimestamp() });
        logAction(`${d.id} ${ad} ödeme kaydı`, "odeme_record");
      }
    } finally { setBusy(false); }
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
          <div style={{ fontSize:11,color:"#9CA3AF",marginTop:6 }}>Yalnızca bu ayı etkiler; ödenmiş kayıtlar ve önceki aylar değişmez.</div>
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
                    <td style={S.td}>₺{fmt(om[d.id]?om[d.id].tutar:aidat)}{eksikOf(d.id)>0 && <div style={{ fontSize:10,color:"#D85A30" }}>eksik ₺{fmt(eksikOf(d.id))}</div>}</td>
                    <td style={S.td}>{om[d.id]?.tarih||"—"}</td>
                    <td style={S.td}><span style={{ ...S.badge,...DURUM_STIL[d.durum] }}>{DURUM_LABEL[d.durum]}</span></td>
                    <td style={S.td}>
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
      <button style={{ ...S.addBtn,margin:"12px 0",width:"100%" }} onClick={()=>{ setForm(bos()); setGoster(g=>!g); }}>{goster?"Vazgeç":"+ Ekle"}</button>
      {goster && (
        <div style={{ display:"grid",gap:8,marginBottom:14,padding:12,background:"#F9FAFB",borderRadius:12 }}>
          <select style={S.select} value={form[alan]} onChange={e=>set(alan,e.target.value)}>{secenekler.map(k=><option key={k}>{k}</option>)}</select>
          <input style={S.input} type="number" inputMode="numeric" placeholder="Tutar (₺)" value={form.tutar} onChange={e=>set("tutar",e.target.value)}/>
          <input style={S.input} type="date" value={form.tarih} onChange={e=>set("tarih",e.target.value)}/>
          <input style={S.input} placeholder="Not (isteğe bağlı)" value={form.not} onChange={e=>set("not",e.target.value)}/>
          <button style={S.addBtn} onClick={ekle}>Kaydet</button>
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
  const cur = curKey();
  const [ay,setAy] = useState(cur);
  const keys = [...new Set([cur, ...gelirler.map(k=>ayOf(k.tarih)), ...giderler.map(k=>ayOf(k.tarih))])].filter(Boolean).sort().reverse();
  const sec = ay==="tumu" || keys.includes(ay) ? ay : "tumu";
  const f = l => sec==="tumu" ? l : l.filter(k=>ayOf(k.tarih)===sec);
  const gel = f(gelirler), gid = f(giderler), net = topla(gel) - topla(gid);
  return (
    <div>
      <div style={{ display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:14 }}>
        <select style={{ ...S.select,width:"auto",minWidth:190,fontWeight:700 }} value={sec} onChange={e=>setAy(e.target.value)}>
          <option value="tumu">Tüm aylar</option>
          {keys.map(k=><option key={k} value={k}>{ayAdi(k)}</option>)}
        </select>
        <span style={{ ...S.badge,background:net>=0?"#D1FAE5":"#FEE2E2",color:net>=0?"#065F46":"#991B1B",fontSize:13 }}>Net: {net<0?"-":""}₺{fmt(Math.abs(net))}</span>
      </div>
      <div className="two-col" style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,alignItems:"start" }}>
        <Kolon baslik="💰 Gelirler" koleksiyon="gelirler" alan="kaynak" secenekler={["aidat","kira","bağış","borç tahsilatı","diğer"]} liste={gel} renk="#1D9E75" isaret="+" ay={sec}/>
        <Kolon baslik="📉 Giderler" koleksiyon="giderler" alan="kategori" secenekler={GID_KATS} liste={gid} renk="#D85A30" isaret="-" ay={sec}/>
      </div>
    </div>
  );
}

// ── BORÇLAR ───────────────────────────────────────────────────────────────
function TabBorclar({ daireler }) {
  const borclar = useCol("borclar"), odemeler = useCol("odemeler");
  const AYLAR = gecmisAylar().reverse(), cur = curKey();
  const [f,setF] = useState("acik");
  const [goster,setGoster] = useState(false);
  const [form,setForm] = useState({ daire:"D1", donem:cur, eksik:"", not:"" });
  const kalanOf = b => Math.max(0,(b.eksik||0)-(b.odenen||0));
  const dMap = Object.fromEntries(daireler.map(d=>[d.id,d]));
  const odemeBul = (daire,donem) => odemeler.find(o=>o.daire===daire && o.donem===donem && o.durum==="odendi");
  async function duzelt(daire, donem, adAy, fark) { // ödenmiş aidat ve gelir kaydını eksik tutar kadar düzeltir
    const od = odemeBul(daire, donem); if (!od) return;
    await updateDoc(doc(db,"odemeler",od.id), { tutar:increment(fark) });
    const g = await aidatBul(daire, donem, adAy);
    if (g) await updateDoc(doc(db,"gelirler",g.id), { tutar:increment(fark) });
  }
  async function ekle() {
    const eksik = Number(form.eksik);
    if (!(eksik>0)) return alert("Eksik tutarı girin.");
    const a = AYLAR.find(x=>x.key===form.donem), adAy = `${MONTH_NAMES[a.m]} ${a.y}`;
    await addDoc(collection(db,"borclar"), { daire:form.daire, donem:form.donem, donemAd:adAy, eksik, odenen:0, not:form.not, tarih:bugun(), olusturuldu:serverTimestamp() });
    await duzelt(form.daire, form.donem, adAy, -eksik);
    logAction(`${form.daire} ${adAy} eksik ödeme: ₺${eksik}`, "borc_create");
    setGoster(false); setForm(p=>({ ...p,eksik:"",not:"" }));
  }
  async function tahsilat(b) {
    const k = kalanOf(b), v = Number(window.prompt(`Tahsil edilen tutar (kalan ₺${fmt(k)}):`, k));
    if (!(v>0)) return;
    await updateDoc(doc(db,"borclar",b.id), { odenen:increment(v) });
    await addDoc(collection(db,"gelirler"), { kaynak:"borç tahsilatı", daire:b.daire, borcId:b.id, tutar:v, tarih:bugun(), not:`${b.daire} - ${b.donemAd} eksik aidat tahsilatı`, otomatik:true, olusturuldu:serverTimestamp() });
    logAction(`${b.daire} ${b.donemAd} borç tahsilatı ₺${v}`, "borc_tahsilat");
  }
  async function sil(b) {
    if (!window.confirm("Borç kaydı silinsin mi? (Yapılmış tahsilatlar gelirde kalır)")) return;
    if (kalanOf(b)>0) await duzelt(b.daire, b.donem, b.donemAd, kalanOf(b));
    await deleteDoc(doc(db,"borclar",b.id));
    logAction(`${b.daire} ${b.donemAd} borç kaydı silindi`, "borc_delete");
  }
  const liste = borclar.filter(b=>f==="tumu" || (f==="acik"?kalanOf(b)>0:kalanOf(b)===0))
    .sort((a,b)=>String(b.donem).localeCompare(String(a.donem)));
  const acik = borclar.reduce((a,b)=>a+kalanOf(b),0);
  return (
    <div>
      <div className="metric-grid" style={{ ...S.metricGrid,gridTemplateColumns:"repeat(2,1fr)" }}>
        <MetricCard label="Açık Borç" val={`₺${fmt(acik)}`} color={acik?"#D85A30":"#1D9E75"} sub={`${borclar.filter(b=>kalanOf(b)>0).length} kayıt`}/>
        <MetricCard label="Tahsil Edilen" val={`₺${fmt(topla(borclar.map(b=>({tutar:b.odenen}))))}`} color="#1D9E75"/>
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
            <div><label style={S.label}>Eksik alınan tutar (₺)</label>
              <input style={S.input} type="number" inputMode="numeric" value={form.eksik} onChange={e=>setForm(p=>({...p,eksik:e.target.value}))}/></div>
            <div><label style={S.label}>Not</label>
              <input style={S.input} placeholder="Örn: kalanı gelecek ay" value={form.not} onChange={e=>setForm(p=>({...p,not:e.target.value}))}/></div>
          </div>
          <div style={{ fontSize:11,color:"#9CA3AF",margin:"10px 0" }}>O ay aidatı “Ödendi” işaretliyse gelir, eksik tutar kadar otomatik düşülür; tahsil edilince gelire eklenir.</div>
          <button style={S.addBtn} onClick={ekle}>Kaydet</button>
        </div>
      )}
      <Chips secili={f} onChange={setF} items={[{v:"acik",l:"Açık"},{v:"kapali",l:"Kapanan"},{v:"tumu",l:"Tümü"}]}/>
      <div style={S.card}>
        {liste.length===0 ? <Bos t="Kayıt yok"/> : liste.map(b=>(
          <div key={b.id} style={{ padding:"12px 0",borderBottom:"1px solid #F3F4F6" }}>
            <div style={{ display:"flex",justifyContent:"space-between",gap:8 }}>
              <div><b>{b.daire}</b> · {dMap[b.daire]?sakinAdi(dMap[b.daire],b.donem):""}<div style={{ fontSize:11,color:"#9CA3AF" }}>{b.donemAd}{b.not?` · ${b.not}`:""}</div></div>
              <div style={{ textAlign:"right" }}>
                <b style={{ color:kalanOf(b)?"#D85A30":"#1D9E75" }}>{kalanOf(b)?`₺${fmt(kalanOf(b))} kalan`:"Kapandı"}</b>
                <div style={{ fontSize:11,color:"#9CA3AF" }}>Eksik ₺{fmt(b.eksik)} · Alınan ₺{fmt(b.odenen)}</div>
              </div>
            </div>
            <div style={{ display:"flex",gap:8,marginTop:8 }}>
              {kalanOf(b)>0 && <button style={{ ...S.smallBtn,borderColor:"#6ee7b7",color:"#065F46",fontSize:12 }} onClick={()=>tahsilat(b)}>+ Tahsilat</button>}
              <button style={{ ...S.delBtn,padding:"6px 10px" }} onClick={()=>sil(b)}>Sil</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── RAPOR (PDF çıktısı) ───────────────────────────────────────────────────
function TabRapor({ daireler }) {
  const odemeler = useCol("odemeler"), gelirler = useCol("gelirler","tarih"), giderler = useCol("giderler","tarih"), borclar = useCol("borclar");
  const [yil,setYil] = useState(CUR_YEAR);
  const [ay,setAy] = useState("tumu");
  const mKey = m => `${yil}-${String(m+1).padStart(2,"0")}`;
  const bas = ay==="tumu" ? mKey(0) : mKey(ay), son = ay==="tumu" ? mKey(11) : mKey(ay);
  const inP = key => key >= bas && key <= son;
  const yillar = [...new Set([CUR_YEAR, ...[...gelirler,...giderler].map(k=>Number(ayOf(k.tarih).slice(0,4))).filter(Boolean)])].sort((a,b)=>b-a);
  const gel = gelirler.filter(k=>inP(ayOf(k.tarih))), gid = giderler.filter(k=>inP(ayOf(k.tarih)));
  const tG = topla(gel), tD = topla(gid), net = tG - tD;
  const donem = ay==="tumu" ? `${yil} yılı` : `${MONTH_NAMES[ay]} ${yil}`;
  const aylik = MONTH_NAMES.map((ad,m)=>({ m, ad,
    g:topla(gelirler.filter(k=>ayOf(k.tarih)===mKey(m))), d:topla(giderler.filter(k=>ayOf(k.tarih)===mKey(m))) })).filter(r=>r.g||r.d);
  const daireRows = daireler.map(d=>{
    const aidatOd = odemeler.filter(o=>o.daire===d.id && o.durum==="odendi" && inP(o.donem));
    const tahs = gelirler.filter(g=>g.daire===d.id && g.kaynak==="borç tahsilatı" && inP(ayOf(g.tarih)));
    const acik = borclar.filter(b=>b.daire===d.id && inP(b.donem)).reduce((a,b)=>a+Math.max(0,(b.eksik||0)-(b.odenen||0)),0);
    return { d, ay:aidatOd.length, toplam:topla(aidatOd)+topla(tahs), acik };
  });
  const th = { ...S.th,textAlign:"right" }, tdr = { ...S.td,textAlign:"right" };
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
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:16 }}>
        <MetricCard label="Toplam Gelir" val={`₺${fmt(tG)}`} color="#1D9E75"/>
        <MetricCard label="Toplam Gider" val={`₺${fmt(tD)}`} color="#D85A30"/>
        <MetricCard label="Net" val={`${net<0?"-":""}₺${fmt(Math.abs(net))}`} color={net>=0?"#1D9E75":"#D85A30"}/>
      </div>
      <div style={S.card}>
        <div style={S.cardTitle}>🗓️ {yil} Aylık Özet</div>
        {aylik.length===0 ? <Bos t="Kayıt yok"/> : (
          <table style={S.table}><thead><tr><th style={S.th}>Ay</th><th style={th}>Gelir</th><th style={th}>Gider</th><th style={th}>Net</th></tr></thead>
            <tbody>{aylik.map(r=>(<tr key={r.m} onClick={()=>setAy(r.m)} style={{ cursor:"pointer",background:ay===r.m?"#ECFDF5":"transparent" }}>
              <td style={S.td}><b>{r.ad}</b></td><td style={{ ...tdr,color:"#1D9E75" }}>₺{fmt(r.g)}</td><td style={{ ...tdr,color:"#D85A30" }}>₺{fmt(r.d)}</td>
              <td style={{ ...tdr,fontWeight:700 }}>{r.g-r.d<0?"-":""}₺{fmt(Math.abs(r.g-r.d))}</td></tr>))}</tbody></table>
        )}
      </div>
      <div style={S.card}>
        <div style={S.cardTitle}>🏠 Daire Bazlı Ödemeler · {donem}</div>
        <table style={S.table}><thead><tr><th style={S.th}>Daire</th><th style={S.th}>Sakin</th><th style={th}>Aidat (ay)</th><th style={th}>Toplam Ödenen</th><th style={th}>Açık Borç</th></tr></thead>
          <tbody>{daireRows.map(r=>(<tr key={r.d.id}>
            <td style={S.td}><b>{r.d.id}</b></td><td style={S.td}>{sakinlar(r.d,bas,son)}</td><td style={tdr}>{r.ay}</td>
            <td style={{ ...tdr,fontWeight:700,color:"#1D9E75" }}>₺{fmt(r.toplam)}</td><td style={{ ...tdr,color:r.acik?"#D85A30":"#9CA3AF" }}>{r.acik?`₺${fmt(r.acik)}`:"—"}</td></tr>))}
            <tr><td style={{ ...S.td,fontWeight:700,borderBottom:"none" }} colSpan={3}>Toplam</td>
              <td style={{ ...tdr,fontWeight:700,borderBottom:"none" }}>₺{fmt(daireRows.reduce((a,r)=>a+r.toplam,0))}</td>
              <td style={{ ...tdr,fontWeight:700,borderBottom:"none" }}>₺{fmt(daireRows.reduce((a,r)=>a+r.acik,0))}</td></tr></tbody></table>
      </div>
      <Liste baslik={`💰 Gelir Kalemleri · ${donem}`} liste={gel} alan="kaynak" renk="#1D9E75"/>
      <Liste baslik={`📉 Gider Kalemleri · ${donem}`} liste={gid} alan="kategori" renk="#D85A30"/>
    </div>
  );
}

// ── AYARLAR: Daire sakinleri + denetim logu ───────────────────────────────
function TabAyarlar({ daireler }) {
  const [alt,setAlt] = useState("daireler");
  const logs = useCol("auditLog","olusturuldu");
  const [sec,setSec] = useState(null);
  const [mod,setMod] = useState("degistir");
  const [f,setF] = useState({ ad:"", tel:"", bas:curKey() });
  const cur = curKey(), AYLAR = tumAylar();
  function ac(d, m) { setSec(d); setMod(m); setF({ ad:m==="duzenle"?sakinAdi(d,cur):"", tel:m==="duzenle"?(d.tel||""):"", bas:cur }); }
  async function kaydet() {
    const ad = f.ad.trim();
    if (!ad) return alert("Sakin adını girin.");
    const g = sec.sakinGecmis?.length ? [...sec.sakinGecmis] : [{ ad:sec.sakinAd||sec.ad, baslangic:"0000-00" }];
    let yeni;
    if (mod==="duzenle") { // yazım düzeltmesi: şu an geçerli kaydın adını düzeltir
      const i = g.reduce((acc,e,ix)=>e.baslangic<=cur?ix:acc, 0);
      yeni = g.map((e,ix)=>ix===i?{ ...e, ad }:e);
    } else { // sakin değişimi: eski kayıtlar korunur, yeni ad seçilen aydan itibaren geçerli
      yeni = [...g.filter(e=>e.baslangic!==f.bas), { ad, baslangic:f.bas }].sort((a,b)=>a.baslangic.localeCompare(b.baslangic));
    }
    await updateDoc(doc(db,"daireler",sec.id), { sakinGecmis:yeni, sakinAd:sakinAdi({ ...sec, sakinGecmis:yeni }, cur), tel:f.tel });
    logAction(`${sec.id} ${mod==="duzenle"?"düzeltme":"sakin değişimi"}: ${ad}${mod==="degistir"?` (${ayAdi(f.bas)}'den itibaren)`:""}`, "daire_update");
    setSec(null);
  }
  return (
    <div>
      <Chips secili={alt} onChange={setAlt} items={[{v:"daireler",l:"🏠 Daire Sakinleri"},{v:"audit",l:"📜 Denetim Logu"}]}/>
      {alt==="daireler" && (
        <>
          {sec && (
            <div style={{ ...S.card,borderLeft:"3px solid #1D9E75" }}>
              <div style={{ fontWeight:700,marginBottom:12 }}>{sec.id} · {mod==="duzenle"?"Bilgi düzelt":"Sakin değiştir"}</div>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
                <div><label style={S.label}>{mod==="duzenle"?"Ad Soyad":"Yeni sakin adı"}</label><input style={S.input} value={f.ad} onChange={e=>setF(p=>({...p,ad:e.target.value}))}/></div>
                <div><label style={S.label}>Telefon</label><input style={S.input} value={f.tel} onChange={e=>setF(p=>({...p,tel:e.target.value}))}/></div>
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
              <thead><tr><th style={S.th}>Daire</th><th style={S.th}>Sakin</th><th style={S.th}>Telefon</th><th style={S.th}></th></tr></thead>
              <tbody>{daireler.map(d=>(
                <tr key={d.id}>
                  <td style={S.td}><b>{d.id}</b></td>
                  <td style={S.td}>{sakinAdi(d,cur)}{(d.sakinGecmis||[]).length>1 && <div style={{ fontSize:10,color:"#9CA3AF" }}>Önceki: {d.sakinGecmis.filter(e=>e.baslangic<=cur).slice(0,-1).map(e=>e.ad).join(", ")||"—"}</div>}</td>
                  <td style={S.td}>{d.tel||"—"}</td>
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
          <div style={S.cardTitle}>📜 Denetim Logu (Son 30)</div>
          {logs.length===0 ? <Bos t="Kayıt yok"/> : (
            <table style={S.table}><thead><tr><th style={S.th}>Tarih</th><th style={S.th}>Saat</th><th style={S.th}>Detay</th></tr></thead>
              <tbody>{logs.slice(0,30).map(l=>(<tr key={l.id}><td style={S.td}>{l.tarih}</td><td style={S.td}>{l.saat}</td><td style={S.td}>{l.detay}</td></tr>))}</tbody></table>
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
  const kalan = b => Math.max(0,(b.eksik||0)-(b.odenen||0));
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

async function logAction(detay, tur) {
  try {
    const user = auth.currentUser;
    if (!user) return;
    const kullanici = user.email === ADMIN_EMAIL ? "admin" : user.email.split("@")[0];
    await addDoc(collection(db,"auditLog"),{
      kullanici, detay, tur, tarih:new Date().toISOString().slice(0,10),
      saat:new Date().toLocaleTimeString("tr-TR"), olusturuldu:serverTimestamp()
    });
  } catch (e) { console.error("auditLog yazılamadı:", e); }
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
