// Firestore kural testleri — emulator gerektirir:
//   npm run test:rules
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where } from "firebase/firestore";

let env;
const ADMIN = { email: "mertaparmani@gmail.com" };
const ESKI_ADMIN = { email: "huseyinsrn@gmail.com" };
const D1 = { email: "d1@105numara.com" };
const D10 = { email: "d10@105numara.com" };

const db = (uid, token) => (token ? env.authenticatedContext(uid, token) : env.unauthenticatedContext()).firestore();
const admin = () => db("admin", ADMIN);
const d1 = () => db("d1", D1);

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "ays105-test",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
});
afterAll(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const f = ctx.firestore();
    await setDoc(doc(f, "ayarlar", "genel"), { aidatTutar: 2500 });
    await setDoc(doc(f, "daireler", "D1"), { ad: "Daire 1", tel: "555" });
    await setDoc(doc(f, "daireler", "D2"), { ad: "Daire 2", tel: "666" });
    await setDoc(doc(f, "daireler", "D10"), { ad: "Daire 10" });
    await setDoc(doc(f, "odemeler", "D1_2026-05"), { daire: "D1", donem: "2026-05", tutar: 2500 });
    await setDoc(doc(f, "odemeler", "D2_2026-05"), { daire: "D2", donem: "2026-05", tutar: 2500 });
    await setDoc(doc(f, "borclar", "b1"), { daire: "D1", donem: "2026-05", eksik: 100 });
    await setDoc(doc(f, "borclar", "b2"), { daire: "D2", donem: "2026-05", eksik: 100 });
    await setDoc(doc(f, "gelirler", "g1"), { tutar: 2500 });
    await setDoc(doc(f, "giderler", "x1"), { tutar: 300 });
    await setDoc(doc(f, "auditLog", "l1"), { detay: "test" });
  });
});

describe("sakin (d1)", () => {
  test("ayarları okur", () => assertSucceeds(getDoc(doc(d1(), "ayarlar", "genel"))));
  test("kendi dairesini okur", () => assertSucceeds(getDoc(doc(d1(), "daireler", "D1"))));
  test("başka daireyi okuyamaz", () => assertFails(getDoc(doc(d1(), "daireler", "D2"))));
  test("daireler koleksiyonunun tamamını okuyamaz", () => assertFails(getDocs(collection(d1(), "daireler"))));
  test("kendi ödemelerini sorgular", () => assertSucceeds(getDocs(query(collection(d1(), "odemeler"), where("daire", "==", "D1")))));
  test("başka dairenin ödemelerini sorgulayamaz", () => assertFails(getDocs(query(collection(d1(), "odemeler"), where("daire", "==", "D2")))));
  test("filtresiz ödeme sorgusu yapamaz", () => assertFails(getDocs(collection(d1(), "odemeler"))));
  test("kendi borçlarını sorgular", () => assertSucceeds(getDocs(query(collection(d1(), "borclar"), where("daire", "==", "D1")))));
  test("başka dairenin borcunu okuyamaz", () => assertFails(getDoc(doc(d1(), "borclar", "b2"))));
  test("gelirleri okuyamaz", () => assertFails(getDocs(collection(d1(), "gelirler"))));
  test("giderleri okuyamaz", () => assertFails(getDocs(collection(d1(), "giderler"))));
  test("denetim logunu okuyamaz", () => assertFails(getDocs(collection(d1(), "auditLog"))));
  test("ödeme yazamaz", () => assertFails(setDoc(doc(d1(), "odemeler", "D1_2026-06"), { daire: "D1", donem: "2026-06" })));
  test("ayarları değiştiremez", () => assertFails(updateDoc(doc(d1(), "ayarlar", "genel"), { aidatTutar: 1 })));
  test("log yazamaz", () => assertFails(addDoc(collection(d1(), "auditLog"), { detay: "sahte" })));
  test("iki haneli daire (d10) kendi dairesini okur", () => assertSucceeds(getDoc(doc(db("d10", D10), "daireler", "D10"))));
});

describe("yönetici", () => {
  test("tüm daireleri okur", () => assertSucceeds(getDocs(collection(admin(), "daireler"))));
  test("gelir yazar", () => assertSucceeds(addDoc(collection(admin(), "gelirler"), { tutar: 1 })));
  test("ödeme yazar ve siler", async () => {
    await assertSucceeds(setDoc(doc(admin(), "odemeler", "D1_2026-06"), { daire: "D1", donem: "2026-06" }));
    await assertSucceeds(deleteDoc(doc(admin(), "odemeler", "D1_2026-06")));
  });
  test("olmayan ödemeyi okuyabilir (transaction kontrolü)", () => assertSucceeds(getDoc(doc(admin(), "odemeler", "D3_2030-01"))));
  test("log okur ve ekler", async () => {
    await assertSucceeds(getDocs(collection(admin(), "auditLog")));
    await assertSucceeds(addDoc(collection(admin(), "auditLog"), { detay: "x" }));
  });
  test("logu değiştiremez", () => assertFails(updateDoc(doc(admin(), "auditLog", "l1"), { detay: "değişti" })));
  test("logu silemez", () => assertFails(deleteDoc(doc(admin(), "auditLog", "l1"))));
  test("tanımsız koleksiyon kapalı", () => assertFails(setDoc(doc(admin(), "baska", "x"), { a: 1 })));
});

describe("makbuzlar", () => {
  beforeEach(() => env.withSecurityRulesDisabled(ctx =>
    setDoc(doc(ctx.firestore(), "makbuzlar", "Ab12Cd34Ef56Gh78Ij90"), { no: "MRT-2026-00001", daire: "D1", tutar: 2500 })));
  test("giriş yapmadan kodla okunur (QR doğrulama)", () => assertSucceeds(getDoc(doc(db(), "makbuzlar", "Ab12Cd34Ef56Gh78Ij90"))));
  test("giriş yapmadan listelenemez", () => assertFails(getDocs(collection(db(), "makbuzlar"))));
  test("sakin listeleyemez", () => assertFails(getDocs(collection(d1(), "makbuzlar"))));
  test("sakin makbuz oluşturamaz", () => assertFails(setDoc(doc(d1(), "makbuzlar", "sahte"), { no: "X", tutar: 1 })));
  test("giriş yapmadan makbuz değiştirilemez", () => assertFails(updateDoc(doc(db(), "makbuzlar", "Ab12Cd34Ef56Gh78Ij90"), { tutar: 1 })));
  test("yönetici oluşturur ve iptal eder", async () => {
    await assertSucceeds(setDoc(doc(admin(), "makbuzlar", "yeni"), { no: "MRT-2026-00002" }));
    await assertSucceeds(updateDoc(doc(admin(), "makbuzlar", "yeni"), { iptal: true }));
  });
  test("yönetici silemez", () => assertFails(deleteDoc(doc(admin(), "makbuzlar", "Ab12Cd34Ef56Gh78Ij90"))));
});

describe("diğerleri", () => {
  test("eski yönetici hiçbir şey okuyamaz", () => assertFails(getDocs(collection(db("eski", ESKI_ADMIN), "gelirler"))));
  test("eski yönetici yazamaz", () => assertFails(setDoc(doc(db("eski", ESKI_ADMIN), "ayarlar", "genel"), { aidatTutar: 1 })));
  test("giriş yapmamış ayarları okuyamaz", () => assertFails(getDoc(doc(db(), "ayarlar", "genel"))));
  test("benzer ama yabancı alan adı sakin sayılmaz", () =>
    assertFails(getDoc(doc(db("x", { email: "d1@105numara.com.evil.io" }), "daireler", "D1"))));
});
