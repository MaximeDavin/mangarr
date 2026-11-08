import { describe, expect, it } from "bun:test";
import { normalizeTitle, parseRelease, titleMatch } from "../src";

describe("normalizeTitle", () => {
  it.each([
    ["L'Attaque des Titans", "lattaque des titans"],
    ["Frieren: Beyond Journey’s End", "frieren beyond journeys end"],
    ["Pokémon", "pokemon"],
    ["  Re:Zero  ", "re zero"],
  ])("%s → %s", (input, want) => {
    expect(normalizeTitle(input)).toBe(want);
  });
});

describe("titleMatch on parsed releases", () => {
  it("matches an alternative title, ignoring case and punctuation", () => {
    const release = parseRelease("Kobayashi-san Chi no Maid Dragon | Miss Kobayashi's Dragon Maid v01-17 (Digital)");
    expect(titleMatch(release, { names: ["miss kobayashis dragon maid"] })).toBe("exact");
  });

  it("does not match a longer title that only starts with the name", () => {
    const release = parseRelease("Berserk of Gluttony v01-08 (Digital)");
    expect(titleMatch(release, { names: ["Berserk"] })).toBe(undefined);
  });
});

describe("titleMatch", () => {
  // Real names from the French tracker (fixtures/fr-tracker.json), except "Tokyo Ghoul Re".
  it.each<[string, string, string[], "exact" | "partial" | undefined]>([
    ["Spy.x.Family.Tome.13.2024.FRENCH.RETAiL.eBOOK-NoTag", "Spy x Family", ["Tatsuya Endo"], "exact"],
    [
      "Hunter.X.Hunter.T40.TOGASHI.2026.Digital-1350.Officiel.CBZ.FR-NoFace696",
      "HUNTER×HUNTER",
      ["Yoshihiro Togashi"],
      "exact",
    ],
    ["Sui.Ishida.Tokyo.Ghoul.T1-14.2011.FRENCH.SCAN.MANGA.CBR.eBOOK", "Tokyo Ghoul", ["Sui Ishida"], "partial"],
    [
      "Eiichiro.Oda.One.Piece.Tome.115.2026.FRENCH.SCAN.MANGA.CBZ.eBOOK-NoTag",
      "One Piece",
      ["Eiichirō Oda"],
      "partial",
    ],
    [
      "Kotoyama.Call.of.the.Night.Kurokawa.Vol.15.15.2025.FRENCH.SCAN.MANGA.CBZ.eBOOK",
      "Call of the Night",
      ["Kotoyama"],
      "partial",
    ],
    ["Nobuyuki.Anzai.Mar.Kana.Integrale.2005.FRENCH.SCAN.MANGA.CBZ.eBOOK", "MÄR", ["Nobuyuki Anzai"], "partial"],
    ["En.proie.au.silence.Akata.integrale.2013.FRENCH.RETAiL.MANGA.CBZ.eBOOK", "En proie au silence", [], "partial"],
    // Author in Japanese order.
    [
      "Yoshizaki.Mine.Sergent.Keroro.T01.a.T34.Kana.2007.EBook.Officiel.MANGA.eBOOK",
      "Sergent Keroro",
      ["Mine Yoshizaki"],
      "partial",
    ],
    [
      "Endo.Tatsuya.Spy.x.Family.T16.Tatsuya.Endo.FR.CBZ-Dogbanov.16.2026.FRENCH.RETAiL.MANGA.CBZ.eBOOK",
      "Spy x Family",
      ["Tatsuya Endo"],
      "partial",
    ],
    // Two authors, glued together or mixed up.
    [
      "Eiichiro.OdaBoichi.One.Piece.1.a.112.officiel.113&114.scan.NoFace696.Episode.A.1.et.2.officiel.Glenat.2000.HYBRiD.MANGA.eBOOK",
      "One Piece",
      ["Eiichiro Oda", "Boichi"],
      "partial",
    ],
    [
      "Gamon.SAKURAI.MIURA.Tsuina.Ajin.T17.2021.FRENCH.CBZ-Paprika+",
      "Ajin",
      ["Gamon Sakurai", "Tsuina Miura"],
      "partial",
    ],
    [
      "Akira.Toriyama.Toyotaro.Dragon.Ball.Super.tome.1-24.pdf.Glenat.2015.RETAiL.MANGA.eBOOK-Team.Chromatique",
      "Dragon Ball Super",
      ["Akira Toriyama", "Toyotaro"],
      "partial",
    ],
    // Author name after the title.
    [
      "Chica.Umino.March.Comes.in.Like.a.Lion.Umino.T01.a.T16.CBZ.Fr.Kana.2011.FRENCH.RETAiL.MANGA.eBOOK",
      "March Comes in Like a Lion",
      ["Chica Umino"],
      "partial",
    ],
    // A spin-off or sequel: extra words after the name.
    [
      "Blue.Lock.Episode.Nagi.T06.Sannomiya.Kaneshiro.2025.FRENCH.RETAiL.MANGA.CBZ.eBOOK-NeoRipClub",
      "Blue Lock",
      ["Muneyuki Kaneshiro", "Yusuke Nomura"],
      undefined,
    ],
    [
      "Kaiju.N.8.Relax.T01.Naoya.Matsumoto.2025.FRENCH.RETAiL.MANGA.CBZ.eBOOK-NeoRipClub",
      "Kaiju No. 8",
      ["Naoya Matsumoto"],
      undefined,
    ],
    ["Sui.Ishida.Tokyo.Ghoul.Re.T01.2016.FRENCH.SCAN.MANGA.CBZ.eBOOK", "Tokyo Ghoul", ["Sui Ishida"], undefined],
  ])("%s / %s → %s", (input, name, authors, want) => {
    expect(titleMatch(parseRelease(input), { names: [name], authors })).toBe(want);
  });

  it("rejects leading words that are not author names, when authors are known", () => {
    const release = parseRelease("Sui.Ishida.Tokyo.Ghoul.T1-14.2011.FRENCH.SCAN.MANGA.CBR.eBOOK");
    expect(titleMatch(release, { names: ["Tokyo Ghoul"], authors: ["Kentaro Miura"] })).toBe(undefined);
  });

  it("accepts any leading words when no authors are known", () => {
    const release = parseRelease("Sui.Ishida.Tokyo.Ghoul.T1-14.2011.FRENCH.SCAN.MANGA.CBR.eBOOK");
    expect(titleMatch(release, { names: ["Tokyo Ghoul"] })).toBe("partial");
  });

  it.each([
    ["Tales of Demons and Gods", "Tales of Demons & Gods", "exact"],
    ["Ghost in the Shell 2", "Ghost in the Shell II", "exact"],
    ["Onepunch Man", "One-Punch Man", "exact"],
    ["Les Carnets de lapothicaire Ki-oon", "Les Carnets de l'apothicaire", "partial"],
  ] as const)("%s / %s → %s", (title, name, want) => {
    expect(titleMatch({ titles: [title] }, { names: [name] })).toBe(want);
  });

  it("prefers an exact match on any title over a partial one", () => {
    expect(titleMatch({ titles: ["Someone Berserk", "Berserk"] }, { names: ["Berserk"] })).toBe("exact");
  });

  it("does not match a name that only appears in the middle of a word", () => {
    const release = parseRelease("Hiroshi.Shinagawa.DROP.PalaceMultiUnivers.2007.francais.scan.MANGA.cbz.eBOOK-PMU");
    expect(titleMatch(release, { names: ["op"] })).toBe(undefined);
  });
});
