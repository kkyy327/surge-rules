/**
 * 汇率面板（Surge Panel 脚本）
 *
 * 以人民币为基准显示常用货币汇率：单价不低于 1 元的外币显示「1 外币 = N 人民币」，
 * 其余显示「1 人民币 = N 外币」，两组之间用细线分隔。
 * 数据源：exchangerate-api（失败时自动切 open.er-api），每日更新，无需 Key。
 *
 * 参数（模块 argument）：currencies=USD,HKD,JPY,KRW,TRY,EUR,GBP
 */

var META = {
  USD: ["🇺🇸", "美元"], EUR: ["🇪🇺", "欧元"], GBP: ["🇬🇧", "英镑"],
  HKD: ["🇭🇰", "港币"], JPY: ["🇯🇵", "日元"], KRW: ["🇰🇷", "韩元"],
  TRY: ["🇹🇷", "里拉"], SGD: ["🇸🇬", "新加坡元"], AUD: ["🇦🇺", "澳元"],
  CAD: ["🇨🇦", "加元"], CHF: ["🇨🇭", "瑞郎"], THB: ["🇹🇭", "泰铢"],
  TWD: ["🇹🇼", "新台币"], MOP: ["🇲🇴", "澳门元"], MYR: ["🇲🇾", "林吉特"],
  NZD: ["🇳🇿", "新西兰元"], PHP: ["🇵🇭", "比索"], VND: ["🇻🇳", "越南盾"],
  INR: ["🇮🇳", "卢比"], RUB: ["🇷🇺", "卢布"], AED: ["🇦🇪", "迪拉姆"],
  SEK: ["🇸🇪", "瑞典克朗"], DKK: ["🇩🇰", "丹麦克朗"], NOK: ["🇳🇴", "挪威克朗"],
  ZAR: ["🇿🇦", "兰特"], BRL: ["🇧🇷", "雷亚尔"], MXN: ["🇲🇽", "墨西哥比索"]
};

function parseArgs(str) {
  var out = {};
  if (!str) return out;
  str.split("&").forEach(function (pair) {
    var i = pair.indexOf("=");
    if (i < 0) return;
    var v = pair.slice(i + 1);
    try { v = decodeURIComponent(v); } catch (e) {}
    out[pair.slice(0, i)] = v;
  });
  return out;
}

// 小数位自适应：越大给越少，观感整齐
function fmtRate(v) {
  if (!isFinite(v)) return "-";
  if (v >= 100) return v.toFixed(1);
  if (v >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

function nowHM() {
  var d = new Date();
  return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
}

function buildPanel(rates, dateStr, codes) {
  var groupA = []; // 1 外币 = N 人民币
  var groupB = []; // 1 人民币 = N 外币
  codes.forEach(function (code) {
    var r = Number(rates[code]);
    if (!isFinite(r) || r <= 0) return;
    var meta = META[code] || ["🏳️", code];
    if (r >= 1) {
      groupB.push(meta[0] + " " + meta[1] + " " + code + " ｜ 1 人民币 ＝ " + fmtRate(r) + " " + meta[1]);
    } else {
      groupA.push(meta[0] + " " + meta[1] + " " + code + " ｜ 1 " + meta[1] + " ＝ " + fmtRate(1 / r) + " 人民币");
    }
  });
  var lines = groupA;
  if (groupA.length && groupB.length) lines.push("┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈");
  lines = lines.concat(groupB);
  if (dateStr) lines.push("数据日期 " + dateStr);
  return {
    title: "💱 今日汇率 · " + nowHM(),
    content: lines.join("\n"),
    icon: "yensign.circle",
    "icon-color": "#D4AF37"
  };
}

function main() {
  var args = parseArgs(typeof $argument !== "undefined" ? $argument : "");
  var codes = (args.currencies || "USD,HKD,JPY,KRW,TRY,EUR,GBP")
    .split(",")
    .map(function (s) { return s.trim().toUpperCase(); })
    .filter(function (s) { return s && s !== "CNY"; });

  var sources = [
    "https://api.exchangerate-api.com/v4/latest/CNY",
    "https://open.er-api.com/v6/latest/CNY"
  ];

  // 只结束一次：任何异常路径都不让面板挂住或重复 $done
  var finished = false;
  function finish(panel) {
    if (finished) return;
    finished = true;
    $done(panel);
  }

  function trySource(idx) {
    if (idx >= sources.length) {
      finish({ title: "💱 今日汇率", content: "获取汇率失败，稍后再试", icon: "yensign.circle", "icon-color": "#D4AF37" });
      return;
    }
    $httpClient.get({ url: sources[idx], timeout: 15 }, function (error, response, data) {
      var obj = null;
      if (!error && data) {
        try { obj = JSON.parse(data); } catch (e) { obj = null; }
      }
      if (!obj || !obj.rates) {
        trySource(idx + 1);
        return;
      }
      try {
        finish(buildPanel(obj.rates, obj.date || "", codes));
      } catch (e) {
        trySource(idx + 1);
      }
    });
  }

  trySource(0);
}

main();
