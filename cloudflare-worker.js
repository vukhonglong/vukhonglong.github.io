const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin"
};

const ADMIN_EMAIL = "haphamngu123@gmail.com";
const FIREBASE_API_KEY = "AIzaSyCSdvkb2q8TIDty0fCqOqkJ15KpmFy98sY";

function b64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function googleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = header + "." + claims;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const assertion = unsigned + "." + b64url(signature);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error("Không xác thực được tài khoản dịch vụ Firebase: " + (data.error_description || data.error || response.status));
  }
  return data.access_token;
}

async function verifyFirebaseUser(idToken) {
  const response = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );
  const data = await response.json();
  if (!response.ok || !data.users || !data.users[0]) {
    throw new Error("Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.");
  }
  const user = data.users[0];
  if (user.disabled) throw new Error("Tài khoản đã bị khóa.");
  return {
    uid: user.localId,
    email: String(user.email || "").toLowerCase(),
    emailVerified: user.emailVerified === true
  };
}

function vietnamDateKey() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function parsePrizes(raw) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 12) {
    throw new Error("Danh sách phần thưởng chưa hợp lệ (tối đa 12 ô).");
  }
  const prizes = raw.map(item => {
    const text = String(item);
    const cut = text.lastIndexOf("|");
    if (cut < 1) throw new Error("Một phần thưởng đang thiếu tỷ lệ.");
    const label = text.slice(0, cut).trim();
    const weight = Number(text.slice(cut + 1).trim());
    if (!label || !Number.isFinite(weight) || weight <= 0 || weight > 100) {
      throw new Error("Tên hoặc tỷ lệ phần thưởng không hợp lệ.");
    }
    const match = label.match(/^([0-9][0-9.,]*)\s*Xu$/i);
    const coins = match ? Number(match[1].replace(/[.,]/g, "")) : 0;
    if (!Number.isSafeInteger(coins)) throw new Error("Số Xu của phần thưởng không hợp lệ.");
    return { label, weight, coins };
  });
  const total = prizes.reduce((sum, prize) => sum + prize.weight, 0);
  if (Math.abs(total - 100) > 0.0001) throw new Error("Tổng tỷ lệ phần thưởng phải bằng 100%.");
  return prizes;
}

async function firestoreRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) {
    const message = data.error && data.error.message ? data.error.message : response.statusText;
    throw new Error("Firestore: " + message);
  }
  return data;
}

function firestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  return { doubleValue: value };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") return Response.json({ service: "vkl-lucky-wheel", version: "2026-11-24-daily-reset", mode: "one-spin-per-day-vietnam-time" }, { status: 200, headers: cors });
    if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });

    try {
      const origin = request.headers.get("Origin") || "";
      if (!["https://vukhonglong.github.io", "https://vukhonglong.vercel.app"].includes(origin)) {
        return Response.json({ error: "Origin không được phép." }, { status: 403, headers: cors });
      }
      const authorization = request.headers.get("Authorization") || "";
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (!match) return Response.json({ error: "Vui lòng đăng nhập lại." }, { status: 401, headers: cors });

      const body = await request.json();
      const action = body.action || "spin";
      const user = await verifyFirebaseUser(match[1]);
      const isAdmin = user.email === ADMIN_EMAIL && user.emailVerified;
      const date = vietnamDateKey();
      const token = await googleAccessToken(env);
      const documentRoot = "projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents";
      const base = "https://firestore.googleapis.com/v1/" + documentRoot;

            if (action === "status") {
        if (isAdmin) return Response.json({ isAdmin: true, dailyUsed: false, freeDailyEnabled: true, date }, { status: 200, headers: cors });
        const spinUrl = base + "/luckyWheelSpins/" + encodeURIComponent(user.uid + "_" + date);
        const settingsUrl = base + "/siteSettings/luckyWheel";
        const [spinResponse, settingsResponse] = await Promise.all([
          fetch(spinUrl, { headers: { Authorization: "Bearer " + token } }),
          fetch(settingsUrl, { headers: { Authorization: "Bearer " + token } })
        ]);
        if (!spinResponse.ok && spinResponse.status !== 404) throw new Error("Không kiểm tra được lượt quay hôm nay.");
        if (!settingsResponse.ok) throw new Error("Không tải được cấu hình vòng quay.");
        const settingsData = await settingsResponse.json();
        const freeDailyEnabled = !(settingsData.fields && settingsData.fields.freeDailyEnabled && settingsData.fields.freeDailyEnabled.booleanValue === false);
        return Response.json({ isAdmin: false, dailyUsed: spinResponse.ok, freeDailyEnabled, date }, { status: 200, headers: cors });
      }

      if (action !== "spin") return Response.json({ error: "Thao tác không hợp lệ." }, { status: 400, headers: cors });
      const requestId = String(body.requestId || "");
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
        return Response.json({ error: "Mã lượt quay không hợp lệ." }, { status: 400, headers: cors });
      }
      const spinId = isAdmin ? user.uid + "_admin_" + requestId : user.uid + "_" + date;
      const settings = await firestoreRequest(base + "/siteSettings/luckyWheel", token);
      const rawPrizes = settings.fields && settings.fields.prizes && settings.fields.prizes.arrayValue
        ? (settings.fields.prizes.arrayValue.values || []).map(v => v.stringValue || "")
        : [];
      const prizes = parsePrizes(rawPrizes);
      if (!isAdmin && settings.fields && settings.fields.freeDailyEnabled && settings.fields.freeDailyEnabled.booleanValue === false) {
        throw new Error("Lượt quay miễn phí hôm nay đang tạm khóa.");
      }

      const spinName = base + "/luckyWheelSpins/" + encodeURIComponent(spinId);
      const existing = await fetch(spinName, { headers: { Authorization: "Bearer " + token } });
      if (existing.ok) {
        return Response.json({ error: isAdmin ? "Lượt quay này đã được xử lý." : "Bạn đã quay hôm nay rồi." }, { status: 409, headers: cors });
      }
      if (existing.status !== 404) {
        const errText = await existing.text();
        throw new Error("Không kiểm tra được lượt quay: " + errText);
      }

      const walletDocumentName = documentRoot + "/wallets/" + encodeURIComponent(user.uid);
      const walletUrl = base + "/wallets/" + encodeURIComponent(user.uid);
      const wallet = await firestoreRequest(walletUrl, token);
      const fields = wallet.fields || {};
      const coinsField = fields.coins || {};
      const currentCoins = Number(coinsField.integerValue ?? coinsField.doubleValue ?? 0);
      if (!Number.isSafeInteger(currentCoins) || currentCoins < 0) throw new Error("Số dư ví hiện tại không hợp lệ.");

      let roll = Math.random() * 100;
      let prizeIndex = prizes.length - 1;
      for (let i = 0; i < prizes.length; i++) {
        roll -= prizes[i].weight;
        if (roll < 0) { prizeIndex = i; break; }
      }
      const selected = prizes[prizeIndex];
      const newBalance = currentCoins + selected.coins;
      if (!Number.isSafeInteger(newBalance)) throw new Error("Số dư sau khi cộng vượt giới hạn.");

      const spinDocName = documentRoot + "/luckyWheelSpins/" + encodeURIComponent(spinId);
      const spinFields = {
        uid: firestoreValue(user.uid),
        prize: firestoreValue(selected.label),
        prizeIndex: firestoreValue(prizeIndex),
        coinsAwarded: firestoreValue(selected.coins),
        balanceAfter: firestoreValue(newBalance),
        date: firestoreValue(date),
        createdAt: { timestampValue: new Date().toISOString() },
        source: firestoreValue("luckyWheel")
      };
      const walletFields = {
        coins: firestoreValue(newBalance),
        updatedAt: { timestampValue: new Date().toISOString() }
      };

      await firestoreRequest(base + ":commit", token, {
        method: "POST",
        body: JSON.stringify({
          writes: [
            {
              update: { name: walletDocumentName, fields: walletFields },
              updateMask: { fieldPaths: ["coins", "updatedAt"] },
              currentDocument: { updateTime: wallet.updateTime }
            },
            {
              update: { name: spinDocName, fields: spinFields },
              currentDocument: { exists: false }
            }
          ]
        })
      });

      return Response.json({
        prize: selected.label,
        prizeIndex,
        coinsAwarded: selected.coins,
        balance: newBalance,
        date
      }, { status: 200, headers: cors });
    } catch (error) {
      return Response.json({ error: error.message || "Lỗi máy chủ." }, { status: 400, headers: cors });
    }
  }
};