/**
 * 阿里 HTTPDNS 用量查询（Surge Panel 脚本）
 *
 * 查询多个阿里云账号本月 HTTPDNS 解析量、免费额度与剩余量。
 * 数据来自阿里云 HTTPDNS OpenAPI 的 GetAccountInfo 接口（Version 2016-02-01），
 * 脚本在本机用 RAM AccessKey 签名请求，凭据只保存在 Surge 模块参数里。
 *
 * 参数（模块 argument，URL 查询串格式）：
 *   name1..name5      账号备注名（可空，空或 # 时显示「账号N」）
 *   id1..id5          RAM AccessKey ID
 *   secret1..secret5  RAM AccessKey Secret
 *   quota             免费额度兜底值（接口未返回 MonthFreeCount 时用），默认 1500000
 */

// ---------- 小工具 ----------

function parseArgs(str) {
  var out = {};
  if (!str) return out;
  str.split("&").forEach(function (pair) {
    if (!pair) return;
    var i = pair.indexOf("=");
    if (i < 0) return;
    var k = pair.slice(0, i);
    var v = pair.slice(i + 1);
    try { v = decodeURIComponent(v); } catch (e) {}
    out[k] = v;
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

// ---------- SHA-1 / HMAC-SHA1（纯 JS，Surge 无内置 crypto） ----------

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
  var withOne = ml + 1;
  var padLen = (56 - (withOne % 64) + 64) % 64;
  var total = withOne + padLen + 8;
  var msg = new Array(total);
  for (var i = 0; i < ml; i++) msg[i] = bytes[i];
  msg[ml] = 0x80;
  for (var i = ml + 1; i < total; i++) msg[i] = 0;
  var bitLen = ml * 8;
  // 64 位长度：高 32 位按 JS 数值范围足够（消息远小于 2^32 位）
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

function bytesToHex(bytes) {
  return bytes.map(function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("");
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
  var innerHash = sha1(inner);
  var outer = outerPad.concat(innerHash);
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

// ---------- 主逻辑 ----------

function queryAccount(acc, fallbackQuota, done) {
  // 每个账号只回报一次：回调里任何异常都转成一行失败信息，
  // 保证主逻辑的计数能走完、面板不会挂住
  var called = false;
  function safeDone(line) {
    if (called) return;
    called = true;
    done(line);
  }
  var url = buildSignedUrl(acc.id, acc.secret);
  $httpClient.get({ url: url, timeout: 15 }, function (error, response, data) {
    try {
      if (error) {
        safeDone(acc.label + "：查询失败（网络错误）");
        return;
      }
      var obj;
      try { obj = JSON.parse(data); } catch (e) {
        safeDone(acc.label + "：查询失败（返回解析错误）");
        return;
      }
      if (!obj || typeof obj !== "object") {
        safeDone(acc.label + "：查询失败（返回解析错误）");
        return;
      }
      if (obj.Code) {
        safeDone(acc.label + "：查询失败（" + obj.Code + "）");
        return;
      }
      var info = obj.AccountInfo || {};
      var used = Number(info.MonthResolveCount || 0);
      var httpsUsed = Number(info.MonthHttpsResolveCount || 0);
      var quota = Number(info.MonthFreeCount || 0);
      if (!isFinite(used)) used = 0;
      if (!isFinite(httpsUsed)) httpsUsed = 0;
      if (!isFinite(quota) || quota < 0) quota = 0;
      if (!quota) quota = fallbackQuota;
      var remain = quota - used;
      var pct = quota > 0 ? (used / quota * 100).toFixed(1) : "0.0";
      var line = acc.label + "：本月 " + fmt(used) + " / " + fmt(quota) +
        "，剩余 " + fmt(remain) + "（已用 " + pct + "%）";
      if (httpsUsed > 0) line += "\n　其中 HTTPS " + fmt(httpsUsed) + " 次";
      safeDone(line);
    } catch (e) {
      safeDone(acc.label + "：查询失败（脚本异常）");
    }
  });
}

function main() {
  var args = parseArgs(typeof $argument !== "undefined" ? $argument : "");
  var fallbackQuota = parseInt(args.quota, 10) || 1500000;
  var accounts = [];
  for (var i = 1; i <= 5; i++) {
    var id = (args["id" + i] || "").trim();
    var secret = (args["secret" + i] || "").trim();
    var name = (args["name" + i] || "").trim();
    if (!id || !secret || id.charAt(0) === "#" || secret.charAt(0) === "#") continue;
    if (!name || name.charAt(0) === "#") name = "账号" + i;
    accounts.push({ label: name, id: id, secret: secret });
  }
  if (accounts.length === 0) {
    $done({ title: "阿里 HTTPDNS 用量", content: "请先填写 RAM 只读凭据" });
    return;
  }
  var lines = new Array(accounts.length);
  var left = accounts.length;
  var finished = false;
  accounts.forEach(function (acc, idx) {
    queryAccount(acc, fallbackQuota, function (line) {
      lines[idx] = line;
      left -= 1;
      if (left === 0 && !finished) {
        finished = true;
        var now = new Date();
        var hh = ("0" + now.getHours()).slice(-2);
        var mm = ("0" + now.getMinutes()).slice(-2);
        $done({
          title: "阿里 HTTPDNS 用量",
          content: lines.join("\n") + "\n更新于 " + hh + ":" + mm
        });
      }
    });
  });
}

main();
