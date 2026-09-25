import { describe, expect, test } from "vitest";
import { sayiYazi, tlYazi, maskele, makbuzNo, tarihYazi, esc, makbuzMail, makbuzKart } from "../lib/makbuz.js";

describe("sayiYazi", () => {
  test.each([
    [0, "sıfır"], [1, "bir"], [10, "on"], [15, "onbeş"], [100, "yüz"], [101, "yüzbir"], [250, "ikiyüzelli"],
    [1000, "bin"], [1001, "binbir"], [2500, "ikibinbeşyüz"], [3750, "üçbinyediyüzelli"],
    [11000, "onbirbin"], [100000, "yüzbin"], [1000000, "birmilyon"], [2345678, "ikimilyonüçyüzkırkbeşbinaltıyüzyetmişsekiz"],
  ])("%i → %s", (n, s) => expect(sayiYazi(n)).toBe(s));
});

test("tlYazi kuruşlu", () => {
  expect(tlYazi(2500)).toBe("Yalnız ikibinbeşyüz Türk lirası");
  expect(tlYazi(2500.5)).toBe("Yalnız ikibinbeşyüz Türk lirası elli kuruş");
});

test("maskele tam adı göstermez", () => {
  expect(maskele("Ali Çelik")).toBe("A** Ç****");
  expect(maskele("  ışıl  ")).toBe("I***");
  expect(maskele("")).toBe("");
});

test("makbuzNo ve tarih", () => {
  expect(makbuzNo(2026, 7)).toBe("MRT-2026-00007");
  expect(tarihYazi("2026-09-05")).toBe("5 Eylül 2026");
  expect(tarihYazi("")).toBe("—");
});

test("şablon HTML kaçışı yapar", () => {
  expect(esc(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&#39;");
  const html = makbuzMail({ no:"MRT-2026-00001", daire:"D1", sakin:"<b>X</b>", donemAd:"Eylül 2026", tutar:2500,
    odemeTarihi:"2026-09-25", duzenlenme:"2026-09-25", dogrulaUrl:"https://x/makbuz/abc", qrSrc:"cid:qr@makbuz" });
  expect(html).not.toContain("<b>X</b>");
  expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
  expect(html).toContain("cid:qr@makbuz");
  expect(html).toContain("ikibinbeşyüz");
});

test("iptal edilmiş makbuz damgası", () => {
  expect(makbuzKart({ no:"N", tutar:1, iptal:true })).toContain("İPTAL EDİLDİ");
  expect(makbuzKart({ no:"N", tutar:1 })).toContain("ÖDENDİ");
});
