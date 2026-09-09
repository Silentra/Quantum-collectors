/**
 * Fact font tier assignments for physical-front cards.
 * Derived from scripts/fact-fit-report.json (collection ~172px, 8% height safety).
 * Thresholds: large if maxFit>=7.75; medium if maxFit>=6.75; else small.
 * Regenerate from the fit report when facts/geometry change.
 */

/** @typedef {'small'|'medium'|'large'} FactFontTier */

/** @type {Readonly<Record<string, FactFontTier>>} */
export const CARD_FACT_FONT_TIERS = Object.freeze({
  "card_moza32gh3g93": "medium",
  "card_moza32gjulrs": "medium",
  "card_moza32gjvdwj": "large",
  "card_moza32gkcro8": "small",
  "card_moza32gldyqh": "medium",
  "card_moza32gmda3a": "small",
  "card_moza32gntucz": "small",
  "card_moza32gp7umy": "small",
  "card_moza32gq1i3w": "medium",
  "card_moza32gquazh": "small",
  "card_moza32gr25rg": "medium",
  "card_moza32grubhh": "small",
  "card_moza32grv00k": "large",
  "card_moza32gs2ocf": "medium",
  "card_moza32gsgrvi": "medium",
  "card_moza32gsv6vl": "small",
  "card_moza32gtgio7": "large",
  "card_moza32gtu80f": "large",
  "card_moza32gulh56": "medium",
  "card_moza32gvusy4": "medium",
  "card_moza32gvv2ch": "small",
  "card_moza32gvxppt": "large",
  "card_moza32gwvahy": "large",
  "card_moza32h1irje": "small",
  "card_moza32h1pfxd": "small",
  "card_moza32h4h32i": "large",
  "card_moza32h51fsv": "medium",
  "card_mp8m72f7h910": "medium",
  "card_mpb9dc1iw18d": "large",
  "card_mpb9eeqlx6n5": "large",
  "card_mpb9gmc9pg5u": "large",
  "card_mpbcc3zixp0h": "small",
  "card_mpbcd0737jks": "medium",
  "card_mpbcgnxa76g9": "small",
  "card_mpbd0dzcpgq4": "small",
  "card_mpbdcxu4clxg": "small",
  "card_mpbe4zq7k0ad": "medium",
  "card_mpbe5bvrb5sy": "medium",
  "card_mpbe5s7dwnjh": "medium",
  "card_mpbe65vypsuk": "medium",
  "card_mpbe6r7hznuq": "small",
  "card_mpef1j2h1e2u": "large",
  "card_mpef2vjd3yky": "medium",
  "card_mpefxlsv8gps": "medium",
  "card_mpeg195m5224": "medium",
  "card_mpeg2ekbctcf": "medium",
  "card_mpeg3n315hkh": "medium",
  "card_mpehphsgwfd1": "small",
  "card_mpo6aw4mtq16": "medium",
  "card_mpo9l7zo2e22": "large",
  "card_mpobudhvhswl": "medium",
  "card_mpod05vj8jqe": "large",
  "card_mpod82ug6l7v": "medium",
  "card_mpodh7liq5lb": "large",
  "card_mpodqzvq07cl": "large",
  "card_mpoe7nb7o0q5": "large",
  "card_mpoewx1idenw": "medium",
  "card_mpof6zdkybgg": "large",
  "card_mpohx0mpaktg": "large",
  "card_mpoi5kaitr3q": "large",
  "card_mporlxgprf47": "small",
  "card_mporn44hdrsx": "medium",
  "card_mporo37da423": "small",
  "card_mporp0rdyfqy": "medium",
  "card_mporq0vnhanv": "medium",
  "card_mporr329m11m": "small",
  "card_mpors6veae5u": "small",
  "card_mporxmvuvvct": "large",
  "card_mporyzqp6p8r": "medium",
  "card_mpos1b0zv5z6": "medium",
  "card_mpos2oai7kb2": "large",
  "card_mpos4r9eyw0z": "small",
  "card_mpos6kkpvuou": "medium",
  "card_mpos7weazsk3": "small",
  "card_mpos989m20si": "large",
  "card_mposcebuu07a": "small",
  "card_mposqedmggu9": "medium",
  "card_mposrwvm6roy": "medium",
  "card_mpouka18pbhk": "large",
  "card_mpoulhbv0u52": "large",
  "card_mpoumlqjla8g": "large",
  "card_mpov7ef1eh9f": "small",
  "card_mpov8du3wd6x": "medium",
  "card_mpov9ecjf1tn": "medium",
  "card_mpovaeszfrlg": "medium",
  "card_mpovctvg779f": "large",
  "card_mpovdtybdkjx": "large",
  "card_mpovf190l2k0": "small",
  "card_mpovgt3vl0xg": "small",
  "card_mpoviftwq199": "medium",
  "card_mpovjh448q6s": "large",
  "card_mpovl7gk8iam": "small",
  "card_mpovmq30yyii": "large",
  "card_mpovoibwydpg": "large",
  "card_mpovpn1wd4an": "large",
  "card_mpovqk2scp6a": "large",
  "card_mpovrtg4yejx": "small",
  "card_mpovt5qsjt31": "small",
  "card_mpovucf0ohjn": "large",
  "card_mpovvfno77kf": "large",
  "card_mpovwlo4137l": "medium",
  "card_mpovxnxge5sk": "large",
  "card_mpoxk4gdjkhi": "medium",
  "card_mpoxm32l7r5t": "medium",
  "card_mpoxv4rxen3d": "medium",
  "card_mpoy175hkpdl": "medium",
  "card_mpoy7a7hcfdo": "large",
  "card_mpoyhyfhytv7": "large",
  "card_mpoypc05h630": "large",
  "card_mpoystudkhz6": "small",
  "card_mppigzvl8c8b": "small",
  "card_mppjfje067gn": "small",
  "card_mppjr8iqmh1o": "medium",
  "card_mppjzlkd35sx": "large",
  "card_mppkhhbwswn4": "medium",
  "card_mppkkxnev2kf": "medium",
  "card_mppkup1d0ikb": "medium",
  "card_mpplcjr130vb": "small",
  "card_mppn6im4n4ae": "small",
  "card_mppnbip912i8": "medium",
  "card_mppnl11mbn6z": "small",
  "card_mppod2d63ymo": "medium",
  "card_mppox8u4yty5": "medium",
  "card_mppp36ey2rs7": "medium",
  "card_mpppbrbuh2qk": "large"
});

/** @type {Readonly<Record<FactFontTier, number>>} */
export const CARD_FACT_FONT_TIER_COUNTS = Object.freeze({
  "small": 35,
  "medium": 50,
  "large": 40
});

/**
 * @param {string|null|undefined} cardId
 * @returns {FactFontTier}
 */
export function getCardFactFontTier(cardId) {
  if (cardId && CARD_FACT_FONT_TIERS[cardId]) return CARD_FACT_FONT_TIERS[cardId];
  // Unknown / future cards: prefer small so complete facts fit without overflow.
  return 'small';
}

/**
 * @param {string|null|undefined} cardId
 * @returns {string} CSS modifier class for .card-detail-keyfact
 */
export function getCardFactFontTierClass(cardId) {
  return `card-detail-keyfact--tier-${getCardFactFontTier(cardId)}`;
}
