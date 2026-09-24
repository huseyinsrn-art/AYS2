import { useState, useEffect, useRef } from "react";
import { db, auth } from "./firebase.js";
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import {
  collection, doc, setDoc, addDoc, deleteDoc, updateDoc,
  onSnapshot, query, orderBy, serverTimestamp, getDocs, where
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
        const v = { aidatTutar:2500, zamGecmisi:[] };
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
  const aidatTutar = ayarlar.aidatTutar || 2500;

  if (isAdmin) return <AdminPanel daireler={daireler} ayarlar={ayarlar} aidatTutar={aidatTutar} />;
  if (daire)   return <DairePanel daire={{ ...daire, aidat:aidatTutar }} />;
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
        <div style={{ fontSize:16,fontWeight:700,color:"#111" }}>105 Numara v3</div>
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
        <div style={{ textAlign:"center",marginBottom:28 }}>
          <div style={{ fontSize:52,marginBottom:10 }}>🏢</div>
          <h1 style={S.loginTitle}>105 Numara</h1>
          <p style={S.loginSub}>Apartman Yönetim Sistemi v3</p>
        </div>
        <div style={S.field}><label style={S.label}>Kullanıcı Adı</label>
          <input style={S.input} placeholder="admin veya d1, d2..." value={username}
            onChange={e=>setUsername(e.target.value)} onKeyDown={e=>e.key==="Enter"&&giris()}/></div>
        <div style={S.field}><label style={S.label}>Şifre</label>
          <input style={S.input} type="password" placeholder="••••••••" value={sifre}
            onChange={e=>setSifre(e.target.value)} onKeyDown={e=>e.key==="Enter"&&giris()}/></div>
        {hata&&<div style={S.hataBox}>{hata}</div>}
        <button style={{ ...S.addBtn,width:"100%",padding:12,fontSize:15,fontWeight:700,borderRadius:10,opacity:loading?0.7:1 }}
          onClick={giris} disabled={loading}>{loading?"Giriş yapılıyor...":"Giriş Yap"}</button>
        <div style={S.loginHint}><b>✨ v3 Mimarisi:</b><br/>📊 Ayrı Collections · 🔒 Veri Tutarlılığı · ⏰ 12 saat oturum</div>
      </div>
    </div>
  );
}

function AdminPanel({ daireler, ayarlar, aidatTutar }) {
  const [tab,setTab] = useState("ozet");
  const tabs = [
    {id:"ozet",   icon:"📊",label:"Özet"},
    {id:"aidat",  icon:"💳",label:"Aidat"},
    {id:"gelirler",icon:"💰",label:"Gelirler"},
    {id:"giderler",icon:"📉",label:"Giderler"},
    {id:"duyuru", icon:"📢",label:"Duyuru"},
    {id:"mesaj",  icon:"💬",label:"Mesaj"},
    {id:"ayarlar",icon:"⚙️", label:"Ayarlar"},
  ];
  return (
    <div style={S.app}>
      <Topbar title="105 Numara v3" sub="Yönetici Paneli" onCikis={()=>signOut(auth)} />
      <div className="desktop-nav" style={S.desktopNav}>
        {tabs.map(t=>(
          <button key={t.id} style={{ ...S.navBtn,...(tab===t.id?S.navActive:{}) }} onClick={()=>setTab(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <div style={S.content}>
        {tab==="ozet"      && <TabOzet       daireler={daireler} aidatTutar={aidatTutar}/>}
        {tab==="aidat"     && <TabAidat      daireler={daireler} aidatTutar={aidatTutar}/>}
        {tab==="gelirler"  && <TabGelirler   />}
        {tab==="giderler"  && <TabGiderler   />}
        {tab==="duyuru"    && <TabDuyuru     />}
        {tab==="mesaj"     && <TabMesaj      daireler={daireler}/>}
        {tab==="ayarlar"   && <TabAyarlar    ayarlar={ayarlar} daireler={daireler}/>}
      </div>
      <div className="mobile-nav" style={S.mobileNav}>
        {tabs.map(t=>(
          <button key={t.id} style={{ ...S.mobileNavBtn,...(tab===t.id?S.mobileNavActive:{}) }} onClick={()=>setTab(t.id)}>
            <span style={{ fontSize:16 }}>{t.icon}</span>
            <span style={{ fontSize:9 }}>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── TAB: ÖZET ─────────────────────────────────────────────────────────────
function TabOzet({ daireler, aidatTutar }) {
  const [odemeler,setOdemeler]   = useState([]);
  const [gelirler,setGelirler]   = useState([]);
  const [giderler,setGiderler]   = useState([]);
  const [duyurular,setDuyurular] = useState([]);

  useEffect(()=>{
    const u1=onSnapshot(query(collection(db,"odemeler"),orderBy("tarih","desc")),
      snap=>setOdemeler(snap.docs.map(x=>({id:x.id,...x.data()}))));
    const u2=onSnapshot(query(collection(db,"gelirler"),orderBy("tarih","desc")),
      snap=>setGelirler(snap.docs.map(x=>({id:x.id,...x.data()}))));
    const u3=onSnapshot(query(collection(db,"giderler"),orderBy("tarih","desc")),
      snap=>setGiderler(snap.docs.map(x=>({id:x.id,...x.data()}))));
    const u4=onSnapshot(query(collection(db,"duyurular"),orderBy("tarih","desc")),
      snap=>setDuyurular(snap.docs.map(x=>({id:x.id,...x.data()})).slice(0,3)));
    return()=>{u1();u2();u3();u4();};
  },[daireler.length]);

  const buAyKey = `${CUR_YEAR}-${String(CUR_MONTH + 1).padStart(2,"0")}`;
  const buAyOdemeler = odemeler.filter(o=>o.donem===buAyKey);
  const odendi = buAyOdemeler.filter(o=>o.durum==="odendi").length;
  const gecikti = buAyOdemeler.filter(o=>o.durum==="gecikti").length;
  const bekliyor = daireler.length - odendi - gecikti;
  const tahsilat = odendi * aidatTutar;
  const beklenen = daireler.length * aidatTutar;
  const yuzde = daireler.length ? Math.round((odendi/daireler.length)*100) : 0;
  const tumGelir = gelirler.reduce((a,k)=>a+(k.tutar||0),0);
  const tumGider = giderler.reduce((a,k)=>a+(k.tutar||0),0);
  const ayGelir = gelirler.filter(k=>k.tarih?.startsWith(buAyKey)).reduce((a,k)=>a+(k.tutar||0),0);
  const ayGider = giderler.filter(k=>k.tarih?.startsWith(buAyKey)).reduce((a,k)=>a+(k.tutar||0),0);

  // Grafikler için veri hazırla
  const odemeData = [
    {name:"Ödendi",value:odendi,color:"#1D9E75"},
    {name:"Bekliyor",value:bekliyor,color:"#BA7517"},
    {name:"Gecikmiş",value:gecikti,color:"#D85A30"},
  ];

  const aylıData = gecmisAylar().map(ay=>{
    const k = `${ay.y}-${String(ay.m+1).padStart(2,"0")}`;
    const gel = gelirler.filter(g=>g.tarih?.startsWith(k)).reduce((a,x)=>a+(x.tutar||0),0);
    const gid = giderler.filter(g=>g.tarih?.startsWith(k)).reduce((a,x)=>a+(x.tutar||0),0);
    return {ay:`${MONTHS_SHORT[ay.m]} ${ay.y}`,Gelir:gel,Gider:gid};
  });

  const giderKatData = Object.entries(
    giderler.reduce((acc,g)=>{acc[g.kategori]=(acc[g.kategori]||0)+(g.tutar||0);return acc;},{})
  ).map(([k,v])=>({name:k,value:v})).sort((a,b)=>b.value-a.value).slice(0,6);

  const gelirKaynakData = Object.entries(
    gelirler.reduce((acc,g)=>{acc[g.kaynak]=(acc[g.kaynak]||0)+(g.tutar||0);return acc;},{})
  ).map(([k,v])=>({name:k,value:v}));

  return (
    <div>
      <div className="metric-grid" style={S.metricGrid}>
        <MetricCard label="Bu Ay Tahsilat" val={`₺${fmt(tahsilat)}`} color="#1D9E75" sub={`%${yuzde} tamamlandı`}/>
        <MetricCard label="Geciken" val={`${gecikti} daire`} color="#D85A30" sub={`₺${fmt(gecikti*aidatTutar)}`}/>
        <MetricCard label="Bu Ay Gelir" val={`₺${fmt(ayGelir)}`} color="#1D9E75" sub={MONTH_NAMES[CUR_MONTH]}/>
        <MetricCard label="Genel Bakiye" val={`₺${fmt(tumGelir-tumGider)}`} color={tumGelir>=tumGider?"#1D9E75":"#D85A30"}/>
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>{MONTH_NAMES[CUR_MONTH]} {CUR_YEAR} · Aidat Tahsilatı</div>
        <div style={{marginBottom:14,marginTop:12}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#6B7280",marginBottom:6}}>
            <span style={{fontWeight:700,color:"#1D9E75",fontSize:15}}>₺{fmt(tahsilat)}</span>
            <span>Hedef: ₺{fmt(beklenen)}</span>
          </div>
          <div style={S.barTrack}><div style={{...S.barFill,width:`${yuzde}%`,background:"linear-gradient(90deg,#1D9E75,#34d399)"}}/></div>
          <div style={{fontSize:12,color:"#1D9E75",marginTop:6,fontWeight:600}}>%{yuzde} tahsil edildi</div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:12}}>
          <div style={{background:"#D1FAE5",borderRadius:10,padding:10,textAlign:"center"}}>
            <div style={{fontSize:20,fontWeight:700,color:"#065F46"}}>{odendi}</div>
            <div style={{fontSize:11,color:"#059669"}}>Ödendi</div>
          </div>
          <div style={{background:"#FEF3C7",borderRadius:10,padding:10,textAlign:"center"}}>
            <div style={{fontSize:20,fontWeight:700,color:"#92400E"}}>{bekliyor}</div>
            <div style={{fontSize:11,color:"#b45309"}}>Bekliyor</div>
          </div>
          <div style={{background:"#FEE2E2",borderRadius:10,padding:10,textAlign:"center"}}>
            <div style={{fontSize:20,fontWeight:700,color:"#991B1B"}}>{gecikti}</div>
            <div style={{fontSize:11,color:"#dc2626"}}>Gecikmiş</div>
          </div>
        </div>
      </div>

      <div className="two-col" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <div style={S.card}>
          <div style={S.cardTitle}>🥧 Ödeme Durumu Dağılımı</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart><Pie data={odemeData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} 
              dataKey="value" label={({name,value})=>`${name} ${value}`}>
              {odemeData.map((e,i)=><Cell key={i} fill={e.color}/>)}
            </Pie>
            <Tooltip formatter={v=>`${v} daire`}/></PieChart>
          </ResponsiveContainer>
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>💰 Gelir Kaynakları</div>
          {gelirKaynakData.length===0?<p style={{color:"#9CA3AF",padding:"40px 0",textAlign:"center"}}>Veri yok</p>:
            <div>
              {gelirKaynakData.map((g,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #F3F4F6"}}>
                  <span style={{fontSize:12,color:"#6B7280",fontWeight:500}}>{g.name}</span>
                  <span style={{fontSize:13,fontWeight:700,color:"#1D9E75"}}>₺{fmt(g.value)}</span>
                </div>
              ))}
            </div>
          }
        </div>
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>📈 Aylık Gelir & Gider Trendi</div>
        {aylıData.length===0?<p style={{color:"#9CA3AF",padding:"40px 0",textAlign:"center"}}>Veri yok</p>:
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={aylıData}><CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6"/><XAxis dataKey="ay" fontSize={12}/>
              <YAxis fontSize={12}/><Tooltip formatter={v=>`₺${fmt(v)}`}/>
              <Legend/><Line type="monotone" dataKey="Gelir" stroke="#1D9E75" strokeWidth={2} dot={{fill:"#1D9E75"}}/>
              <Line type="monotone" dataKey="Gider" stroke="#D85A30" strokeWidth={2} dot={{fill:"#D85A30"}}/>
            </LineChart>
          </ResponsiveContainer>
        }
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>📊 Giderlerin Kategori Dağılımı (Top 6)</div>
        {giderKatData.length===0?<p style={{color:"#9CA3AF",padding:"40px 0",textAlign:"center"}}>Gider yok</p>:
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={giderKatData}><CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6"/><XAxis dataKey="name" fontSize={11}/>
              <YAxis fontSize={12}/><Tooltip formatter={v=>`₺${fmt(v)}`}/>
              <Bar dataKey="value" fill="#D85A30" name="Tutar" radius={[8,8,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        }
      </div>

      <div className="two-col" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <div style={S.card}>
          <div style={S.cardTitle}>💳 Son İşlemler</div>
          {gelirler.length===0?<p style={{color:"#9CA3AF",fontSize:12}}>İşlem yok</p>:
            gelirler.slice(0,5).map(g=>(
              <div key={g.id} style={{padding:"8px 0",borderBottom:"1px solid #F3F4F6",display:"flex",justifyContent:"space-between"}}>
                <div style={{fontSize:12}}>
                  <div style={{color:"#374151",fontWeight:500}}>{(g.kaynak||"").toUpperCase()}</div>
                  <div style={{color:"#9CA3AF",fontSize:10}}>{g.tarih}</div>
                </div>
                <span style={{fontSize:13,fontWeight:700,color:"#1D9E75"}}>+₺{fmt(g.tutar)}</span>
              </div>
            ))
          }
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>📢 Son Duyurular</div>
          {duyurular.length===0?<p style={{color:"#9CA3AF",fontSize:12}}>Duyuru yok</p>:
            duyurular.map(du=>(
              <div key={du.id} style={{fontSize:11,paddingBottom:8,borderBottom:"1px solid #F3F4F6",marginBottom:8}}>
                <div style={{fontWeight:600,color:"#374151"}}>{du.baslik}</div>
                <div style={{color:"#9CA3AF",fontSize:10,marginTop:2}}>{du.tarih}</div>
              </div>
            ))
          }
        </div>
      </div>
    </div>
  );
}

// ── TAB: AİDAT ────────────────────────────────────────────────────────────
function TabAidat({ daireler, aidatTutar }) {
  const TUM_AYLAR = tumAylar();
  const [seciliIdx,setSeciliIdx] = useState(() => {
    const idx = TUM_AYLAR.findIndex(a=>a.y===CUR_YEAR&&a.m===CUR_MONTH);
    return idx>=0?idx:0;
  });
  const [filtre,setFiltre] = useState("tumu");
  const [odemeler,setOdemeler] = useState([]);

  const secilenAy = TUM_AYLAR[seciliIdx];
  const donemKey = secilenAy?.key;
  const donemAd = secilenAy?`${MONTH_NAMES[secilenAy.m]} ${secilenAy.y}`:"";
  const gelecek = secilenAy && (secilenAy.y>CUR_YEAR||(secilenAy.y===CUR_YEAR&&secilenAy.m>CUR_MONTH));

  useEffect(()=>onSnapshot(query(collection(db,"odemeler"),where("donem","==",donemKey)),
    snap=>setOdemeler(snap.docs.map(x=>({id:x.id,...x.data()})))), [donemKey]);

  async function odemeToggle(daire, mevcut) {
    if (gelecek) return;
    if (mevcut?.durum==="odendi") {
      // İptal
      await deleteDoc(doc(db,"odemeler",mevcut.id));
      logAction(`${daire.id} ödeme iptal`, "odeme_cancel");
    } else {
      // Yeni ödeme
      const bugun = new Date().toISOString().slice(0,10);
      await addDoc(collection(db,"odemeler"),{
        daire:daire.id, donem:donemKey, donemAd, tutar:aidatTutar,
        durum:"odendi", tarih:bugun, olusturuldu:serverTimestamp()
      });
      await addDoc(collection(db,"gelirler"),{
        kaynak:"aidat", daire:daire.id, tutar:aidatTutar, tarih:bugun,
        not:`${daire.ad} - ${donemAd} aidatı`, otomatik:true, olusturuldu:serverTimestamp()
      });
      logAction(`${daire.id} ödeme kaydı`, "odeme_record");
    }
  }

  const odeniMap = Object.fromEntries(odemeler.map(o=>[o.daire,o]));
  const rows = daireler.map(d=>({...d,odeme:odeniMap[d.id]||{durum:"bekliyor"}}))
    .filter(d=>filtre==="tumu"||(gelecek?false:d.odeme.durum===filtre));

  const odendi = gelecek?0:daireler.filter(d=>odeniMap[d.id]?.durum==="odendi").length;
  const gecikti = gelecek?0:daireler.filter(d=>odeniMap[d.id]?.durum==="gecikti").length;

  return (
    <div>
      <div style={S.card}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,justifyContent:"space-between",flexWrap:"wrap"}}>
          <button style={S.arrowBtn} onClick={()=>setSeciliIdx(i=>Math.max(0,i-1))}>‹</button>
          <span style={{fontSize:17,fontWeight:700,color:"#111"}}>{donemAd}</span>
          <button style={S.arrowBtn} onClick={()=>setSeciliIdx(i=>Math.min(TUM_AYLAR.length-1,i+1))}>›</button>
        </div>
        {!gelecek && (
          <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
            {["tumu","odendi","bekliyor","gecikti"].map(f=>(
              <button key={f} style={{...S.filterBtn,...(filtre===f?S.filterActive:{})}}
                onClick={()=>setFiltre(f)}>{f==="tumu"?"Tümü":DURUM_LABEL[f]}</button>
            ))}
          </div>
        )}
        {!gelecek && (
          <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
            <span style={{...S.badge,background:"#D1FAE5",color:"#065F46"}}>✓ {odendi} ödedi · ₺{fmt(odendi*aidatTutar)}</span>
            <span style={{...S.badge,background:"#FEE2E2",color:"#991B1B"}}>✗ {gecikti} gecikti · ₺{fmt(gecikti*aidatTutar)}</span>
            <span style={{...S.badge,background:"#FEF3C7",color:"#92400E"}}>⌛ {daireler.length-odendi-gecikti} bekliyor</span>
          </div>
        )}
      </div>

      {gelecek?(
        <div style={{...S.card,textAlign:"center",padding:"32px 20px"}}>
          <div style={{fontSize:32,marginBottom:8}}>📅</div>
          <div style={{fontSize:14,fontWeight:600,color:"#374151"}}>{donemAd} henüz gelmedi</div>
        </div>
      ):(
        <div style={S.card}>
          <div style={{overflowX:"auto"}}>
            <table style={S.table}>
              <thead><tr>
                <th style={S.th}>Daire</th><th style={S.th}>Sakin Adı</th><th style={S.th}>Tutar</th>
                <th style={S.th}>Tarih</th><th style={S.th}>Durum</th><th style={S.th}>İşlem</th>
              </tr></thead>
              <tbody>{rows.map(d=>(
                <tr key={d.id}>
                  <td style={S.td}><b>{d.id}</b></td>
                  <td style={S.td}>{d.sakinAd||d.ad}</td>
                  <td style={S.td}>₺{fmt(d.odeme.tutar||aidatTutar)}</td>
                  <td style={S.td}>{d.odeme.tarih||"—"}</td>
                  <td style={S.td}>
                    <span style={{...S.badge,...(d.odeme.durum==="odendi"
                      ?{background:"#D1FAE5",color:"#065F46"}:{background:"#FEF3C7",color:"#92400E"})}}>
                      {DURUM_LABEL[d.odeme.durum]}
                    </span>
                  </td>
                  <td style={S.td}>
                    <button style={{...S.smallBtn,fontSize:11,borderColor:d.odeme.durum==="odendi"?"#fca5a5":"#6ee7b7",color:d.odeme.durum==="odendi"?"#991B1B":"#065F46"}}
                      onClick={()=>odemeToggle(d,d.odeme)}>
                      {d.odeme.durum==="odendi"?"İptal":"✓ Ödendi"}
                    </button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TAB: GELİRLER ──────────────────────────────────────────────────────────
function TabGelirler() {
  const [gelirler,setGelirler] = useState([]);
  const [form,setForm] = useState({kaynak:"aidat",tutar:"",tarih:new Date().toISOString().slice(0,10),not:""});
  const [goster,setGoster] = useState(false);

  useEffect(()=>onSnapshot(query(collection(db,"gelirler"),orderBy("tarih","desc")),
    snap=>setGelirler(snap.docs.map(x=>({id:x.id,...x.data()})))) ,[]);

  async function ekle() {
    if(!form.tutar) return;
    await addDoc(collection(db,"gelirler"),{...form,tutar:Number(form.tutar),olusturuldu:serverTimestamp()});
    logAction(`Gelir eklendi: ${form.kaynak} ₺${form.tutar}`, "gelir_create");
    setGoster(false);
    setForm({kaynak:"aidat",tutar:"",tarih:new Date().toISOString().slice(0,10),not:""});
  }

  async function sil(id) {
    if(window.confirm("Silinsin mi?")) {
      await deleteDoc(doc(db,"gelirler",id));
      logAction(`Gelir silindi`, "gelir_delete");
    }
  }

  const topGelir = gelirler.reduce((a,k)=>a+(k.tutar||0),0);

  return (
    <div>
      <div style={{...S.metricGrid,gridTemplateColumns:"repeat(2,1fr)",marginBottom:16}}>
        <MetricCard label="Toplam Gelir" val={`₺${fmt(topGelir)}`} color="#1D9E75"/>
        <MetricCard label="Kaynak Sayısı" val={gelirler.length.toString()} color="#0891B2"/>
      </div>
      <button style={{...S.addBtn,marginBottom:12}} onClick={()=>setGoster(true)}>+ Gelir Ekle</button>
      {goster&&(
        <div style={{...S.card,marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>➕ Gelir Ekle</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
            <div><label style={S.label}>Kaynak</label>
              <select style={S.select} value={form.kaynak} onChange={e=>setForm(p=>({...p,kaynak:e.target.value}))}>
                {["aidat","kira","bağış","diğer"].map(k=><option key={k}>{k}</option>)}
              </select></div>
            <div><label style={S.label}>Tutar (₺)</label>
              <input style={S.input} type="number" placeholder="0" value={form.tutar}
                onChange={e=>setForm(p=>({...p,tutar:e.target.value}))}/></div>
            <div><label style={S.label}>Tarih</label>
              <input style={S.input} type="date" value={form.tarih}
                onChange={e=>setForm(p=>({...p,tarih:e.target.value}))}/></div>
            <div><label style={S.label}>Not</label>
              <input style={S.input} placeholder="Açıklama..." value={form.not}
                onChange={e=>setForm(p=>({...p,not:e.target.value}))}/></div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button style={S.addBtn} onClick={ekle}>Ekle</button>
            <button style={S.filterBtn} onClick={()=>setGoster(false)}>İptal</button>
          </div>
        </div>
      )}
      <div style={S.card}>
        <div style={S.cardTitle}>💰 Gelir Listesi</div>
        {gelirler.length===0?<p style={{color:"#9CA3AF",padding:"20px 0"}}>Gelir yok</p>:
          gelirler.map(g=>(
            <div key={g.id} style={{padding:"12px 0",borderBottom:"1px solid #F3F4F6",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontWeight:600,color:"#111"}}>{(g.kaynak||"").toUpperCase()}</div>
                <div style={{fontSize:12,color:"#9CA3AF"}}>{g.tarih}{g.not?` · ${g.not}`:""}</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:14,fontWeight:700,color:"#1D9E75"}}>+₺{fmt(g.tutar)}</span>
                {!g.otomatik&&<button style={{...S.delBtn,padding:"4px 8px"}} onClick={()=>sil(g.id)}>✕</button>}
              </div>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ── TAB: GİDERLER ──────────────────────────────────────────────────────────
function TabGiderler() {
  const [giderler,setGiderler] = useState([]);
  const [form,setForm] = useState({kategori:"Elektrik",tutar:"",tarih:new Date().toISOString().slice(0,10),not:""});
  const [goster,setGoster] = useState(false);

  useEffect(()=>onSnapshot(query(collection(db,"giderler"),orderBy("tarih","desc")),
    snap=>setGiderler(snap.docs.map(x=>({id:x.id,...x.data()})))) ,[]);

  async function ekle() {
    if(!form.tutar) return;
    await addDoc(collection(db,"giderler"),{...form,tutar:Number(form.tutar),olusturuldu:serverTimestamp()});
    logAction(`Gider eklendi: ${form.kategori} ₺${form.tutar}`, "gider_create");
    setGoster(false);
    setForm({kategori:"Elektrik",tutar:"",tarih:new Date().toISOString().slice(0,10),not:""});
  }

  async function sil(id) {
    if(window.confirm("Silinsin mi?")) {
      await deleteDoc(doc(db,"giderler",id));
      logAction(`Gider silindi`, "gider_delete");
    }
  }

  const topGider = giderler.reduce((a,k)=>a+(k.tutar||0),0);

  return (
    <div>
      <div style={{...S.metricGrid,gridTemplateColumns:"repeat(2,1fr)",marginBottom:16}}>
        <MetricCard label="Toplam Gider" val={`₺${fmt(topGider)}`} color="#D85A30"/>
        <MetricCard label="Kategori Sayısı" val={giderler.length.toString()} color="#6366F1"/>
      </div>
      <button style={{...S.addBtn,marginBottom:12}} onClick={()=>setGoster(true)}>- Gider Ekle</button>
      {goster&&(
        <div style={{...S.card,marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>➖ Gider Ekle</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
            <div><label style={S.label}>Kategori</label>
              <select style={S.select} value={form.kategori} onChange={e=>setForm(p=>({...p,kategori:e.target.value}))}>
                {GID_KATS.map(k=><option key={k}>{k}</option>)}
              </select></div>
            <div><label style={S.label}>Tutar (₺)</label>
              <input style={S.input} type="number" placeholder="0" value={form.tutar}
                onChange={e=>setForm(p=>({...p,tutar:e.target.value}))}/></div>
            <div><label style={S.label}>Tarih</label>
              <input style={S.input} type="date" value={form.tarih}
                onChange={e=>setForm(p=>({...p,tarih:e.target.value}))}/></div>
            <div><label style={S.label}>Not</label>
              <input style={S.input} placeholder="Açıklama..." value={form.not}
                onChange={e=>setForm(p=>({...p,not:e.target.value}))}/></div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button style={S.addBtn} onClick={ekle}>Ekle</button>
            <button style={S.filterBtn} onClick={()=>setGoster(false)}>İptal</button>
          </div>
        </div>
      )}
      <div style={S.card}>
        <div style={S.cardTitle}>📉 Gider Listesi</div>
        {giderler.length===0?<p style={{color:"#9CA3AF",padding:"20px 0"}}>Gider yok</p>:
          giderler.map(g=>(
            <div key={g.id} style={{padding:"12px 0",borderBottom:"1px solid #F3F4F6",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontWeight:600,color:"#111"}}>{g.kategori}</div>
                <div style={{fontSize:12,color:"#9CA3AF"}}>{g.tarih}{g.not?` · ${g.not}`:""}</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:14,fontWeight:700,color:"#D85A30"}}>-₺{fmt(g.tutar)}</span>
                <button style={{...S.delBtn,padding:"4px 8px"}} onClick={()=>sil(g.id)}>✕</button>
              </div>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ── TAB: DUYURU ───────────────────────────────────────────────────────────
function TabDuyuru() {
  const [duyurular,setDuyurular] = useState([]);
  const [form,setForm] = useState({baslik:"",icerik:"",kategori:"Bilgi"});
  const [goster,setGoster] = useState(false);

  useEffect(()=>onSnapshot(query(collection(db,"duyurular"),orderBy("tarih","desc")),
    snap=>setDuyurular(snap.docs.map(x=>({id:x.id,...x.data()})))) ,[]);

  async function ekle() {
    if(!form.baslik||!form.icerik) return;
    await addDoc(collection(db,"duyurular"),{...form,tarih:new Date().toISOString().slice(0,10),olusturuldu:serverTimestamp()});
    logAction(`Duyuru eklendi: ${form.baslik}`, "duyuru_create");
    setGoster(false);
    setForm({baslik:"",icerik:"",kategori:"Bilgi"});
  }

  async function sil(id) {
    if(window.confirm("Silinsin mi?")) {
      await deleteDoc(doc(db,"duyurular",id));
      logAction(`Duyuru silindi`, "duyuru_delete");
    }
  }

  return (
    <div>
      <button style={{...S.addBtn,marginBottom:12}} onClick={()=>setGoster(true)}>+ Duyuru Ekle</button>
      {goster&&(
        <div style={{...S.card,marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>📢 Duyuru Ekle</div>
          <div style={S.field}><label style={S.label}>Başlık</label>
            <input style={S.input} value={form.baslik} onChange={e=>setForm(p=>({...p,baslik:e.target.value}))} placeholder="Başlık"/></div>
          <div style={S.field}><label style={S.label}>İçerik</label>
            <textarea style={{...S.input,height:80}} value={form.icerik}
              onChange={e=>setForm(p=>({...p,icerik:e.target.value}))} placeholder="İçerik..."/></div>
          <div style={S.field}><label style={S.label}>Kategori</label>
            <select style={S.select} value={form.kategori} onChange={e=>setForm(p=>({...p,kategori:e.target.value}))}>
              {["Bilgi","Bakım","Aidat","Toplantı","Acil"].map(k=><option key={k}>{k}</option>)}
            </select></div>
          <div style={{display:"flex",gap:8}}>
            <button style={S.addBtn} onClick={ekle}>Yayınla</button>
            <button style={S.filterBtn} onClick={()=>setGoster(false)}>İptal</button>
          </div>
        </div>
      )}
      <div style={S.card}>
        {duyurular.length===0?<p style={{color:"#9CA3AF"}}>Duyuru yok</p>:
          duyurular.map(du=>(
            <div key={du.id} style={{padding:"12px 0",borderBottom:"1px solid #F3F4F6"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"start",gap:8}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:600,color:"#111"}}>{du.baslik}</div>
                  <div style={{fontSize:12,color:"#6B7280",marginTop:4}}>{du.icerik}</div>
                  <div style={{fontSize:10,color:"#9CA3AF",marginTop:4}}>{du.tarih}</div>
                </div>
                <button style={{...S.delBtn}} onClick={()=>sil(du.id)}>✕</button>
              </div>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ── TAB: MESAJ ────────────────────────────────────────────────────────────
function TabMesaj({ daireler }) {
  const [mesajlar,setMesajlar] = useState([]);
  const [form,setForm] = useState({alici:"Tüm sakinler",baslik:"",icerik:""});
  const [goster,setGoster] = useState(false);

  useEffect(()=>onSnapshot(query(collection(db,"messages"),orderBy("olusturuldu","desc")),
    snap=>setMesajlar(snap.docs.map(x=>({id:x.id,...x.data()})))) ,[]);

  async function gonder() {
    if(!form.baslik||!form.icerik) return;
    await addDoc(collection(db,"messages"),{...form,tarih:new Date().toISOString().slice(0,10),olusturuldu:serverTimestamp()});
    logAction(`${form.alici}'ye mesaj: ${form.baslik}`, "mesaj_send");
    setGoster(false);
    setForm({alici:"Tüm sakinler",baslik:"",icerik:""});
  }

  return (
    <div>
      <button style={{...S.addBtn,marginBottom:12}} onClick={()=>setGoster(true)}>+ Mesaj Gönder</button>
      {goster&&(
        <div style={{...S.card,marginBottom:16}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>💬 Mesaj Gönder</div>
          <div style={S.field}><label style={S.label}>Alıcı</label>
            <select style={S.select} value={form.alici} onChange={e=>setForm(p=>({...p,alici:e.target.value}))}>
              {["Tüm sakinler",...daireler.map(d=>`${d.id} · ${d.sakinAd||d.ad}`)].map(o=><option key={o}>{o}</option>)}
            </select></div>
          <div style={S.field}><label style={S.label}>Başlık</label>
            <input style={S.input} value={form.baslik} onChange={e=>setForm(p=>({...p,baslik:e.target.value}))} placeholder="Başlık"/></div>
          <div style={S.field}><label style={S.label}>İçerik</label>
            <textarea style={{...S.input,height:100}} value={form.icerik}
              onChange={e=>setForm(p=>({...p,icerik:e.target.value}))} placeholder="İçerik..."/></div>
          <div style={{display:"flex",gap:8}}>
            <button style={S.addBtn} onClick={gonder}>Gönder</button>
            <button style={S.filterBtn} onClick={()=>setGoster(false)}>İptal</button>
          </div>
        </div>
      )}
      <div style={S.card}>
        {mesajlar.length===0?<p style={{color:"#9CA3AF"}}>Mesaj yok</p>:
          mesajlar.map(m=>(
            <div key={m.id} style={{padding:"12px 0",borderBottom:"1px solid #F3F4F6"}}>
              <div style={{fontWeight:600,color:"#111"}}>{m.baslik}</div>
              <div style={{fontSize:12,color:"#9CA3AF",marginTop:2}}>→ {m.alici}</div>
              <div style={{fontSize:12,color:"#6B7280",marginTop:4}}>{m.icerik}</div>
              <div style={{fontSize:10,color:"#D1D5DB",marginTop:4}}>{m.tarih}</div>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ── TAB: AYARLAR ──────────────────────────────────────────────────────────
function TabAyarlar({ ayarlar, daireler }) {
  const [altTab,setAltTab] = useState("aidat");
  const [aidatTutar,setAidatTutar] = useState(ayarlar?.aidatTutar||2500);
  const [auditLogs,setAuditLogs] = useState([]);
  const [seciliDaire,setSeciliDaire] = useState(null);
  const [daireForm,setDaireForm] = useState({});

  useEffect(()=>onSnapshot(query(collection(db,"auditLog"),orderBy("olusturuldu","desc")),
    snap=>setAuditLogs(snap.docs.map(x=>({id:x.id,...x.data()})))), []);

  async function aidatKaydet() {
    await setDoc(doc(db,"ayarlar","genel"),{...ayarlar,aidatTutar:Number(aidatTutar)});
    logAction(`Aidat: ₺${aidatTutar}`, "aidat_update");
    alert("Kaydedildi!");
  }

  function daireSecDuzenle(d) {
    setSeciliDaire(d);
    setDaireForm({sakinAd:d.sakinAd||"",tel:d.tel||""});
  }

  async function daireKaydet() {
    if(!seciliDaire) return;
    await updateDoc(doc(db,"daireler",seciliDaire.id),daireForm);
    logAction(`${seciliDaire.id} güncellendi: ${daireForm.sakinAd}`, "daire_update");
    setSeciliDaire(null);
    alert("Kaydedildi!");
  }

  return (
    <div>
      <div style={{display:"flex",gap:6,marginBottom:16}}>
        {[{id:"aidat",label:"💰 Aidat Tutarı"},{id:"daireler",label:"🏠 Daire Kullanıcıları"},{id:"audit",label:"📜 Denetim Logu"}].map(t=>(
          <button key={t.id} style={{...S.filterBtn,...(altTab===t.id?S.filterActive:{})}}
            onClick={()=>setAltTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {altTab==="aidat"&&(
        <div style={S.card}>
          <div style={S.cardTitle}>💰 Aidat Tutarı</div>
          <div style={{display:"flex",gap:8,alignItems:"flex-end",marginTop:12}}>
            <input style={{...S.input,fontSize:22,fontWeight:700,flex:1}} type="number"
              value={aidatTutar} onChange={e=>setAidatTutar(e.target.value)}/>
            <button style={S.addBtn} onClick={aidatKaydet}>Kaydet</button>
          </div>
        </div>
      )}

      {altTab==="daireler"&&(
        <>
          {seciliDaire&&(
            <div style={{...S.card,marginBottom:16,borderLeft:"3px solid #1D9E75"}}>
              <div style={{fontSize:13,fontWeight:700,marginBottom:12}}>✏️ {seciliDaire.id} · {seciliDaire.ad}</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <div><label style={S.label}>Sakin Adı Soyadı</label>
                  <input style={S.input} placeholder="Ad Soyad" value={daireForm.sakinAd}
                    onChange={e=>setDaireForm(p=>({...p,sakinAd:e.target.value}))}/></div>
                <div><label style={S.label}>Telefon</label>
                  <input style={S.input} placeholder="05xx xxx xx xx" value={daireForm.tel}
                    onChange={e=>setDaireForm(p=>({...p,tel:e.target.value}))}/></div>
              </div>
              <div style={{display:"flex",gap:8,marginTop:12}}>
                <button style={S.addBtn} onClick={daireKaydet}>Kaydet</button>
                <button style={S.filterBtn} onClick={()=>setSeciliDaire(null)}>İptal</button>
              </div>
            </div>
          )}
          <div style={S.card}>
            <div style={S.cardTitle}>🏠 Daire Kullanıcıları</div>
            <table style={S.table}>
              <thead><tr>
                <th style={S.th}>Daire</th><th style={S.th}>Sakin Adı</th>
                <th style={S.th}>Telefon</th><th style={S.th}>İşlem</th>
              </tr></thead>
              <tbody>{daireler.map(d=>(
                <tr key={d.id}>
                  <td style={S.td}><b>{d.id}</b></td>
                  <td style={S.td}>{d.sakinAd||<span style={{color:"#9CA3AF"}}>—</span>}</td>
                  <td style={S.td}>{d.tel||<span style={{color:"#9CA3AF"}}>—</span>}</td>
                  <td style={S.td}>
                    <button style={{...S.smallBtn,borderColor:"#93C5FD",color:"#1E40AF",fontSize:11}}
                      onClick={()=>daireSecDuzenle(d)}>Düzenle</button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}

      {altTab==="audit"&&(
        <div style={S.card}>
          <div style={S.cardTitle}>📜 Denetim Logu (Son 20)</div>
          {auditLogs.length===0?<p style={{color:"#9CA3AF",padding:"20px 0"}}>Kayıt yok</p>:
            <table style={S.table}>
              <thead><tr>
                <th style={S.th}>Tarih</th><th style={S.th}>Saat</th><th style={S.th}>Detay</th>
              </tr></thead>
              <tbody>{auditLogs.slice(0,20).map(log=>(
                <tr key={log.id}>
                  <td style={S.td}>{log.tarih}</td>
                  <td style={S.td}>{log.saat}</td>
                  <td style={S.td}>{log.detay}</td>
                </tr>
              ))}</tbody>
            </table>
          }
        </div>
      )}
    </div>
  );
}

// ── DAİRE PANELİ ──────────────────────────────────────────────────────────
function DairePanel({ daire }) {
  const [tab,setTab] = useState("aidat");
  const [odemeler,setOdemeler] = useState([]);
  const [duyurular,setDuyurular] = useState([]);

  useEffect(()=>{
    const u1=onSnapshot(query(collection(db,"odemeler"),where("daire","==",daire.id)),
      snap=>setOdemeler(snap.docs.map(x=>({id:x.id,...x.data()}))
        .sort((a,b)=>String(b.donem||"").localeCompare(String(a.donem||"")))));
    const u2=onSnapshot(query(collection(db,"duyurular"),orderBy("tarih","desc")),
      snap=>setDuyurular(snap.docs.map(x=>({id:x.id,...x.data()}))));
    return()=>{u1();u2();};
  },[daire.id]);

  const buAyKey = `${CUR_YEAR}-${String(CUR_MONTH + 1).padStart(2,"0")}`;
  const buAy = odemeler.find(o=>o.donem===buAyKey);
  const durum = buAy?.durum||"bekliyor";

  return (
    <div style={S.app}>
      <Topbar title="105 Numara" sub={daire.sakinAd||daire.ad} onCikis={()=>signOut(auth)} />
      <div style={S.desktopNav}>
        {[{id:"aidat",icon:"💳",label:"Aidat"},{id:"duyuru",icon:"📢",label:"Duyuru"}].map(t=>(
          <button key={t.id} style={{...S.navBtn,...(tab===t.id?S.navActive:{})}} onClick={()=>setTab(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <div style={S.content}>
        <div style={{...S.heroCard,borderLeft:`4px solid ${durum==="odendi"?"#1D9E75":durum==="gecikti"?"#D85A30":"#BA7517"}`}}>
          <div style={{fontSize:11,color:"#9CA3AF",marginBottom:6,fontWeight:600}}>{MONTH_NAMES[CUR_MONTH]} {CUR_YEAR}</div>
          <div style={{fontSize:34,fontWeight:700,color:"#111",marginBottom:10}}>₺{fmt(daire.aidat)}</div>
          <span style={{...S.badge,...(durum==="odendi"?{background:"#D1FAE5",color:"#065F46"}:durum==="gecikti"?{background:"#FEE2E2",color:"#991B1B"}:{background:"#FEF3C7",color:"#92400E"})}}>
            {DURUM_LABEL[durum]}
          </span>
        </div>

        {tab==="aidat" && (
          <div style={S.card}>
            <div style={S.cardTitle}>📋 Ödeme Geçmişi</div>
            {odemeler.length===0?<p style={{color:"#9CA3AF",padding:"20px 0"}}>Kayıt yok</p>:
              <table style={S.table}>
                <thead><tr><th style={S.th}>Dönem</th><th style={S.th}>Tutar</th><th style={S.th}>Tarih</th><th style={S.th}>Durum</th></tr></thead>
                <tbody>{odemeler.map(o=>(
                  <tr key={o.id}>
                    <td style={S.td}>{o.donemAd||o.donem}</td>
                    <td style={S.td}>₺{fmt(o.tutar)}</td>
                    <td style={S.td}>{o.tarih||"—"}</td>
                    <td style={S.td}><span style={{...S.badge,...(o.durum==="odendi"?{background:"#D1FAE5",color:"#065F46"}:{background:"#FEF3C7",color:"#92400E"})}}>{DURUM_LABEL[o.durum]}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            }
          </div>
        )}

        {tab==="duyuru" && (
          <div style={S.card}>
            <div style={S.cardTitle}>📢 Duyurular</div>
            {duyurular.length===0?<p style={{color:"#9CA3AF",padding:"20px 0"}}>Duyuru yok</p>:
              duyurular.map(du=>(
                <div key={du.id} style={{padding:"12px 0",borderBottom:"1px solid #F3F4F6"}}>
                  <div style={{fontWeight:600,color:"#111"}}>{du.baslik}</div>
                  <div style={{fontSize:12,color:"#6B7280",marginTop:4}}>{du.icerik}</div>
                  <div style={{fontSize:10,color:"#9CA3AF",marginTop:4}}>{du.tarih}</div>
                </div>
              ))
            }
          </div>
        )}
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
    <div style={S.topbar}>
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