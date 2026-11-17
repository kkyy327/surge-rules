/**
 * 阿里 HTTPDNS 用量 · Surge Panel（v2）
 *
 * 单账号设计：查本月解析量、免费额度与剩余，画进度条，
 * 按日均推算月底总量，超额提前预警。
 * 数据来自阿里云 HTTPDNS OpenAPI GetAccountInfo（Version 2016-02-01），
 * 请求在本机用 RAM AccessKey 做 HMAC-SHA1 签名，凭据不出 Surge。
 *
 * 模块参数（argument 查询串）：
 *   label   备注（面板上显示的名字）
 *   id      AccessKey ID（# 或空 = 未填）
 *   secret  AccessKey Secret（# 或空 = 未填）
 *   quota   免费额度兜底（接口未返回 MonthFreeCount 时用），默认 1500000
 */

// ---------- 参数与格式化 ----------

function parseArgs(str) {
  var out = {};
  if (!str) return out;
  str.split("&").forEach(function (pair) {
    if (!pair) return;
    var i = pair.indexOf("=");
    if (i < 0) return;
    var v = pair.slice(i + 1);
    try { v = decodeURIComponent(v); } catch (e) {}
    out[pair.slice(0, i)] = v;
  });
  return out;
}

function fmt(n) {
  n = Math.round(Number(n) || 0);
  var neg = n < 0;
  var s = String(Math.abs(n));
  var r = "";
  while (s.length > 3) {
    r = "," + s.slice(-3) + r;
    s = s.slice(0, -3);
  }
  return (neg ? "-" : "") + s + r;
}

function bar(pct) {
  var filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  var s = "";
  for (var i = 0; i < 10; i++) s += i < filled ? "█" : "░";
  return s;
}

function clock() {
  var d = new Date();
  function p(x) { return ("0" + x).slice(-2); }
  return p(d.getHours()) + ":" + p(d.getMinutes());
}

function done(content) {
  $done({ title: "阿里 HTTPDNS 用量", content: content });
}

// ---------- SHA-1 / HMAC-SHA1（纯 JS 实现，Surge 无内置 crypto） ----------

function utf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var cp = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function sha1(bytes) {
  var ml = bytes.length;
  var total = ml + 1 + ((56 - ((ml + 1) % 64) + 64) % 64) + 8;
  var msg = new Array(total);
  for (var i = 0; i < ml; i++) msg[i] = bytes[i];
  msg[ml] = 0x80;
  for (var i = ml + 1; i < total; i++) msg[i] = 0;
  var bitLen = ml * 8;
  var hi = Math.floor(bitLen / 4294967296);
  var lo = bitLen >>> 0;
  msg[total - 8] = (hi >>> 24) & 0xff;
  msg[total - 7] = (hi >>> 16) & 0xff;
  msg[total - 6] = (hi >>> 8) & 0xff;
  msg[total - 5] = hi & 0xff;
  msg[total - 4] = (lo >>> 24) & 0xff;
  msg[total - 3] = (lo >>> 16) & 0xff;
  msg[total - 2] = (lo >>> 8) & 0xff;
  msg[total - 1] = lo & 0xff;

  var h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  var w = new Array(80);
  function rol(x, n) { return (x << n) | (x >>> (32 - n)); }

  for (var chunk = 0; chunk < total; chunk += 64) {
    for (var t = 0; t < 16; t++) {
      w[t] = (msg[chunk + t * 4] << 24) | (msg[chunk + t * 4 + 1] << 16) |
             (msg[chunk + t * 4 + 2] << 8) | msg[chunk + t * 4 + 3];
    }
    for (var t = 16; t < 80; t++) {
      w[t] = rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    }
    var a = h0, b = h1, c = h2, d = h3, e = h4;
    for (var t = 0; t < 80; t++) {
      var f, k;
      if (t < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (t < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      var tmp = (rol(a, 5) + f + e + k + w[t]) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  var hs = [h0, h1, h2, h3, h4];
  var out = [];
  for (var i = 0; i < 5; i++) {
    out.push((hs[i] >>> 24) & 0xff, (hs[i] >>> 16) & 0xff, (hs[i] >>> 8) & 0xff, hs[i] & 0xff);
  }
  return out;
}

function bytesToBase64(bytes) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i];
    var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars.charAt(b0 >> 2);
    out += chars.charAt(((b0 & 3) << 4) | (b1 >> 4));
    out += i + 1 < bytes.length ? chars.charAt(((b1 & 15) << 2) | (b2 >> 6)) : "=";
    out += i + 2 < bytes.length ? chars.charAt(b2 & 63) : "=";
  }
  return out;
}

function hmacSha1Base64(keyStr, msgStr) {
  var key = utf8Bytes(keyStr);
  if (key.length > 64) key = sha1(key);
  while (key.length < 64) key.push(0);
  var msg = utf8Bytes(msgStr);
  var inner = new Array(64 + msg.length);
  var outerPad = new Array(64);
  for (var i = 0; i < 64; i++) {
    inner[i] = key[i] ^ 0x36;
    outerPad[i] = key[i] ^ 0x5c;
  }
  for (var i = 0; i < msg.length; i++) inner[64 + i] = msg[i];
  var outer = outerPad.concat(sha1(inner));
  return bytesToBase64(sha1(outer));
}

// ---------- 阿里云 RPC 签名 ----------

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

function buildSignedUrl(accessKeyId, accessKeySecret) {
  var params = {
    AccessKeyId: accessKeyId,
    Action: "GetAccountInfo",
    Format: "JSON",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: String(Date.now()) + Math.floor(Math.random() * 1000000),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2016-02-01"
  };
  var keys = Object.keys(params).sort();
  var canonical = keys.map(function (k) {
    return percentEncode(k) + "=" + percentEncode(params[k]);
  }).join("&");
  var stringToSign = "GET&" + percentEncode("/") + "&" + percentEncode(canonical);
  var signature = hmacSha1Base64(accessKeySecret + "&", stringToSign);
  return "https://httpdns-api.aliyuncs.com/?" + canonical + "&Signature=" + percentEncode(signature);
}

// ---------- 主流程 ----------

function explainError(code) {
  if (!code) return "返回看不懂";
  if (code.indexOf("InvalidAccessKeyId") === 0) return "AccessKey ID 不对或已被禁用";
  if (code === "SignatureDoesNotMatch") return "AccessKey Secret 不对";
  if (code === "InvalidAccessKeySecret") return "AccessKey Secret 不对";
  return code;
}

function main() {
  var args = parseArgs(typeof $argument !== "undefined" ? $argument : "");
  var id = (args.id || "").trim();
  var secret = (args.secret || "").trim();
  var label = (args.label || "").trim();
  if (!label || label.charAt(0) === "#") label = "阿里云";
  var fallbackQuota = parseInt(args.quota, 10) || 1500000;

  if (!id || !secret || id.charAt(0) === "#" || secret.charAt(0) === "#") {
    done("请先填写 AccessKey\n点模块的「编辑参数」，填 ID 和 Secret 两格");
    return;
  }

  var url = buildSignedUrl(id, secret);
  $httpClient.get({ url: url, timeout: 15 }, function (error, response, data) {
    if (error) {
      done(label + "：查询失败\n连不上阿里云接口（网络错误）\n更新于 " + clock());
      return;
    }
    var obj;
    try { obj = JSON.parse(data); } catch (e) {
      done(label + "：查询失败\n接口返回解析不了\n更新于 " + clock());
      return;
    }
    if (!obj || typeof obj !== "object") {
      done(label + "：查询失败\n接口返回解析不了\n更新于 " + clock());
      return;
    }
    if (obj.Code) {
      done(label + "：查询失败\n" + explainError(obj.Code) + "\n更新于 " + clock());
      return;
    }

    var info = obj.AccountInfo || {};
    var used = Number(info.MonthResolveCount || 0);
    var httpsUsed = Number(info.MonthHttpsResolveCount || 0);
    var quota = Number(info.MonthFreeCount || 0);
    if (!isFinite(used) || used < 0) used = 0;
    if (!isFinite(httpsUsed) || httpsUsed < 0) httpsUsed = 0;
    if (!isFinite(quota) || quota <= 0) quota = fallbackQuota;
    var remain = quota - used;
    var pct = quota > 0 ? used / quota * 100 : 0;

    var now = new Date();
    var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var elapsed = now.getDate();
    var forecast = elapsed > 0 ? Math.round(used / elapsed * daysInMonth) : used;

    var lines = [];
    lines.push(label + "：本月已用 " + fmt(used) + " 次");
    lines.push(bar(pct) + " " + pct.toFixed(1) + "%");
    lines.push("免费额度 " + fmt(quota) + " · 剩余 " + fmt(remain));
    if (httpsUsed > 0) lines.push("其中 HTTPS " + fmt(httpsUsed) + " 次");
    if (forecast > quota) {
      lines.push("⚠️ 日均 " + fmt(Math.round(used / elapsed)) + " 次，预计月底 " + fmt(forecast) + " 次，超免费额度");
    } else {
      lines.push("日均 " + fmt(Math.round(used / elapsed)) + " 次 · 预计月底 " + fmt(forecast) + " 次");
    }
    lines.push("更新于 " + clock());
    done(lines.join("\n"));
  });
}

main();
