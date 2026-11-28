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

let accStockMemoryCache = null;
let cachedGoogleToken = "";
let cachedGoogleTokenExpiresAt = 0;

async function googleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleToken && cachedGoogleTokenExpiresAt > now + 120) return cachedGoogleToken;
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
  cachedGoogleToken = data.access_token;
  cachedGoogleTokenExpiresAt = now + Number(data.expires_in || 3600);
  return cachedGoogleToken;
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
    throw new Error("Firestore HTTP " + response.status + ": " + message);
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
    if (request.method === "GET") return Response.json({ service: "vkl-lucky-wheel", version: "2026-11-28-stock-stats-1", mode: "one-spin-per-day-vietnam-time" }, { status: 200, headers: cors });
    if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });

    try {
      // CORS đã bật; quyền quay được kiểm soát bằng Firebase ID token và xác thực admin phía máy chủ.
      const authorization = request.headers.get("Authorization") || "";
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (!match) return Response.json({ error: "Vui lòng đăng nhập lại." }, { status: 401, headers: cors });

      const body = await request.json();
      const action = body.action || "spin";
      const user = await verifyFirebaseUser(match[1]);
      const isAdmin = user.email === ADMIN_EMAIL;
      const date = vietnamDateKey();
      const token = await googleAccessToken(env);
      const documentRoot = "projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents";
      const base = "https://firestore.googleapis.com/v1/" + documentRoot;

      if (action === "savePrizes") {
        if (!isAdmin) return Response.json({ error: "Bạn không có quyền quản lý." }, { status: 403, headers: cors });
        const prizes = parsePrizes(body.prizes);
        const values = prizes.map(prize => ({ stringValue: prize.label + " | " + prize.weight }));
        const settingsUrl = base + "/siteSettings/luckyWheel?updateMask.fieldPaths=prizes&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=updatedBy";
        await firestoreRequest(settingsUrl, token, {
          method: "PATCH",
          body: JSON.stringify({
            fields: {
              prizes: { arrayValue: { values } },
              updatedAt: { timestampValue: new Date().toISOString() },
              updatedBy: { stringValue: user.uid }
            }
          })
        });
        return Response.json({ success: true, count: prizes.length, total: 100 }, { status: 200, headers: cors });
      }

            if (action === "history") {
        let documents = [];
        let nextPageToken = "";
        for (let page = 0; page < 5; page++) {
          const pageUrl = base + "/luckyWheelSpins?pageSize=300" + (nextPageToken ? "&pageToken=" + encodeURIComponent(nextPageToken) : "");
          const historyResponse = await firestoreRequest(pageUrl, token);
          documents = documents.concat(Array.isArray(historyResponse.documents) ? historyResponse.documents : []);
          nextPageToken = historyResponse.nextPageToken || "";
          if (!nextPageToken) break;
        }
        const entries = documents
          .filter(document => document.fields && document.fields.uid && document.fields.uid.stringValue === user.uid)
          .map(document => {
            const fields = document.fields;
            return {
              prize: fields.prize?.stringValue || "—",
              date: fields.date?.stringValue || "",
              createdAt: fields.createdAt?.timestampValue || ""
            };
          })
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return Response.json({ entries: entries.slice(0, 100) }, { status: 200, headers: cors });
      }

      if (action === "getAccStockCount") {
        // Chỉ đọc tài liệu thống kê do trang quản lý kho cập nhật, không truy vấn accInventory.
        // Cache số lượng kho để tránh mỗi lượt tải trang đều gọi Firestore.
        const nowMs = Date.now();
        if (accStockMemoryCache && nowMs - accStockMemoryCache.savedAt < 60000) {
          return Response.json({ success: true, counts: accStockMemoryCache.counts, cached: true }, { status: 200, headers: cors });
        }
        const statsUrl = base + "/siteStats/accInventory";
        const statsResponse = await fetch(statsUrl, { headers: { Authorization: "Bearer " + token } });
        if (statsResponse.status === 404) {
          const emptyCounts = { LV0: 0, LV12: 0 };
          accStockMemoryCache = { counts: emptyCounts, savedAt: nowMs };
          return Response.json({ success: true, counts: emptyCounts }, { status: 200, headers: cors });
        }
        if (!statsResponse.ok) {
          // Nếu Firestore tạm hết quota, dùng số liệu thành công gần nhất trong tối đa 15 phút.
          if (accStockMemoryCache && nowMs - accStockMemoryCache.savedAt < 900000) {
            return Response.json({ success: true, counts: accStockMemoryCache.counts, cached: true, stale: true }, { status: 200, headers: cors });
          }
          const errorText = await statsResponse.text();
          let errorMessage = "";
          try {
            const errorData = errorText ? JSON.parse(errorText) : {};
            errorMessage = errorData.error?.message || "";
          } catch {}
          throw new Error("Không đọc được số lượng kho (Firestore HTTP " + statsResponse.status + ")" +
            (errorMessage ? ": " + errorMessage : ""));
        }
        const stats = await statsResponse.json();
        const fields = stats.fields || {};
        const numberField = field => Number(fields[field]?.integerValue ?? fields[field]?.doubleValue ?? 0);
        const counts = { LV0: numberField("lv0"), LV12: numberField("lv12") };
        accStockMemoryCache = { counts, savedAt: nowMs };
        return Response.json({ success: true, counts }, { status: 200, headers: cors });
      }

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

      if (action === "deliverCloneAccounts") {
        const service = String(body.service || "");
        const level = service === "ACC CLONE LV0" ? "LV0" :
          service === "ACC CLONE LV12" ? "LV12" : "";
        const count = Number(body.count);
        const orderId = String(body.orderId || "");
        const dateText = String(body.date || "").slice(0, 80);
        if (!level) return Response.json({ error: "Loại tài khoản không hợp lệ." }, { status: 400, headers: cors });
        if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
          return Response.json({ error: "Số lượng tài khoản phải từ 1 đến 100." }, { status: 400, headers: cors });
        }
        if (!/^VKL-[A-F0-9]{32}$/.test(orderId)) {
          return Response.json({ error: "Mã đơn hàng không hợp lệ." }, { status: 400, headers: cors });
        }

        const orderName = documentRoot + "/orders/" + orderId;
        const orderCheck = await fetch(base + "/orders/" + orderId, {
          headers: { Authorization: "Bearer " + token }
        });
        if (orderCheck.ok) {
          const existing = await orderCheck.json();
          const fields = existing.fields || {};
          if (fields.userId?.stringValue !== user.uid) {
            return Response.json({ error: "Mã đơn hàng không thuộc tài khoản của bạn." }, { status: 403, headers: cors });
          }
          if (fields.deliveryStatus?.stringValue === "Đã giao tài khoản") {
            return Response.json({ orderId, delivered: Number(fields.deliveredAccountCount?.integerValue || count), alreadyProcessed: true }, { status: 200, headers: cors });
          }
          return Response.json({ error: "Mã đơn hàng đã được sử dụng." }, { status: 409, headers: cors });
        }
        if (orderCheck.status !== 404) throw new Error("Không kiểm tra được mã đơn hàng. Mã lỗi " + orderCheck.status + ": " + (await orderCheck.text()).slice(0, 200));

        const begin = await firestoreRequest(base + ":beginTransaction", token, {
          method: "POST",
          body: JSON.stringify({ options: { readWrite: {} } })
        });
        const transaction = begin.transaction;
        if (!transaction) throw new Error("Không khởi tạo được giao dịch kho.");

        try {
          const walletName = documentRoot + "/wallets/" + encodeURIComponent(user.uid);
          const walletResults = await firestoreRequest(base + ":batchGet", token, {
            method: "POST",
            body: JSON.stringify({ documents: [walletName, documentRoot + "/siteStats/accInventory"], transaction })
          });
          const walletResult = Array.isArray(walletResults)
            ? walletResults.find(item => item.found && item.found.name === walletName)
            : null;
          const walletDoc = walletResult && walletResult.found;
          if (!walletDoc) throw new Error("Không tìm thấy ví Xu của bạn.");
          const statsName = documentRoot + "/siteStats/accInventory";
          const statsResult = Array.isArray(walletResults) ? walletResults.find(item => item.found && item.found.name === statsName) : null;
          const statsDoc = statsResult && statsResult.found;
          const walletFields = walletDoc.fields || {};
          const oldBalance = Number(
            walletFields.coins?.integerValue ??
            walletFields.coins?.doubleValue ??
            0
          );
          if (!Number.isSafeInteger(oldBalance) || oldBalance < 0) {
            throw new Error("Số dư ví hiện tại không hợp lệ.");
          }
          const unitPrice = service === "ACC CLONE LV0" ? 50 : 1500;
          const totalPrice = unitPrice * count;
          if (!Number.isSafeInteger(totalPrice)) throw new Error("Tổng tiền đơn hàng không hợp lệ.");
          if (oldBalance < totalPrice) {
            await fetch(base + ":rollback", {
              method: "POST",
              headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
              body: JSON.stringify({ transaction })
            });
            return Response.json({
              error: "Số dư không đủ! Bạn cần " + totalPrice.toLocaleString("vi-VN") +
                " Xu, hiện có " + oldBalance.toLocaleString("vi-VN") + " Xu."
            }, { status: 409, headers: cors });
          }
          const newBalance = oldBalance - totalPrice;

          const queryResult = await firestoreRequest(base + ":runQuery", token, {
            method: "POST",
            body: JSON.stringify({
              structuredQuery: {
                from: [{ collectionId: "accInventory" }],
                where: {
                  fieldFilter: {
                    field: { fieldPath: "level" },
                    op: "EQUAL",
                    value: { stringValue: level }
                  }
                },
                limit: count
              },
              transaction
            })
          });
          const stockDocs = (Array.isArray(queryResult) ? queryResult : [])
            .map(item => item.document).filter(Boolean);
          if (stockDocs.length < count) {
            await fetch(base + ":rollback", {
              method: "POST",
              headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
              body: JSON.stringify({ transaction })
            });
            return Response.json({
              error: "Kho " + level + " hiện chỉ còn " + stockDocs.length + " tài khoản. Vui lòng giảm số lượng."
            }, { status: 409, headers: cors });
          }

          const accounts = stockDocs.map(doc => {
            const fields = doc.fields || {};
            const account = fields.account?.stringValue || "";
            const password = fields.password?.stringValue || "";
            if (!account.trim() || !password.trim() || fields.level?.stringValue !== level) {
              throw new Error("Có tài khoản trong kho bị thiếu thông tin. Vui lòng kiểm tra kho.");
            }
            return { account, password };
          });

          const timestamp = new Date().toISOString();
          const stringField = value => ({ stringValue: String(value) });
          const intField = value => ({ integerValue: String(value) });
          const writes = stockDocs.map(doc => ({ delete: doc.name }));
          if (statsDoc && statsDoc.fields) {
            const statsFields = statsDoc.fields;
            const current = field => Number(statsFields[field]?.integerValue ?? statsFields[field]?.doubleValue ?? 0);
            writes.push({
              update: {
                name: statsName,
                fields: {
                  lv0: intField(Math.max(0, current("lv0") - (level === "LV0" ? count : 0))),
                  lv12: intField(Math.max(0, current("lv12") - (level === "LV12" ? count : 0))),
                  updatedAt: { timestampValue: timestamp }
                },
                updateMask: { fieldPaths: ["lv0", "lv12", "updatedAt"] }
              }
            });
          }
          writes.push({
            update: {
              name: walletName,
              fields: {
                coins: intField(newBalance),
                lastOrderId: stringField(orderId),
                updatedAt: { timestampValue: timestamp }
              }
            },
            updateMask: { fieldPaths: ["coins", "lastOrderId", "updatedAt"] }
          });
          writes.push({
            update: {
              name: documentRoot + "/coinTransactions/" + orderId,
              fields: {
                uid: stringField(user.uid),
                userId: stringField(user.uid),
                type: stringField("subtract"),
                amount: intField(totalPrice),
                balanceAfter: intField(newBalance),
                note: stringField("Thanh toán đơn hàng " + orderId),
                createdAt: { timestampValue: timestamp }
              }
            },
            currentDocument: { exists: false }
          });

          for (let offset = 0, index = 0; offset < accounts.length; offset += 20, index++) {
            const chunk = accounts.slice(offset, offset + 20);
            const values = chunk.map(item => ({
              mapValue: { fields: {
                account: stringField(item.account),
                password: stringField(item.password)
              }}
            }));
            writes.push({
              update: {
                name: orderName + "/deliveredAccounts/" + String(index).padStart(3, "0"),
                fields: {
                  index: intField(index),
                  accounts: { arrayValue: { values } },
                  createdAt: { timestampValue: timestamp }
                }
              },
              currentDocument: { exists: false }
            });
          }

          const username = user.email ? user.email.split("@")[0] : "Khách hàng";
          writes.push({
            update: {
              name: orderName,
              fields: {
                userId: stringField(user.uid),
                username: stringField(username),
                service: stringField(service),
                count: intField(count),
                quantity: intField(count),
                total: intField(totalPrice),
                codes: stringField(""),
                date: stringField(dateText),
                label: stringField("Số lượng tài khoản"),
                deliveryStatus: stringField("Đã giao tài khoản"),
                deliveredAccountCount: intField(accounts.length),
                createdAt: { timestampValue: timestamp },
                deliveredAt: { timestampValue: timestamp },
                source: stringField("automaticInventory")
              }
            },
            currentDocument: { exists: false }
          });
          writes.push({
            update: {
              name: documentRoot + "/orderTracking/" + orderId,
              fields: {
                userId: stringField(user.uid),
                service: stringField(service),
                status: stringField("Đã giao tài khoản"),
                progress: intField(100),
                eta: stringField("Đã giao"),
                note: stringField("Hệ thống đã tự động giao " + accounts.length + " tài khoản từ kho " + level + "."),
                updatedAt: { timestampValue: timestamp }
              }
            },
            currentDocument: { exists: false }
          });

          await firestoreRequest(base + ":commit", token, {
            method: "POST",
            body: JSON.stringify({ transaction, writes })
          });
          return Response.json({ orderId, delivered: accounts.length, alreadyProcessed: false }, { status: 200, headers: cors });
        } catch (transactionError) {
          try {
            await fetch(base + ":rollback", {
              method: "POST",
              headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
              body: JSON.stringify({ transaction })
            });
          } catch {}
          throw transactionError;
        }
      }

      if (action !== "spin") return Response.json({ error: "Thao tác không hợp lệ." }, { status: 400, headers: cors });
      const requestId = String(body.requestId || "");
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
        return Response.json({ error: "Mã lượt quay không hợp lệ." }, { status: 400, headers: cors });
      }
      const spinId = isAdmin ? user.uid + "_admin_" + requestId : user.uid + "_" + date;
      const spinName = base + "/luckyWheelSpins/" + encodeURIComponent(spinId);
      const walletDocumentName = documentRoot + "/wallets/" + encodeURIComponent(user.uid);
      const walletUrl = base + "/wallets/" + encodeURIComponent(user.uid);

      // Các thao tác đọc độc lập được chạy song song để giảm thời gian chờ.
      const [settings, existing, wallet] = await Promise.all([
        firestoreRequest(base + "/siteSettings/luckyWheel", token),
        fetch(spinName, { headers: { Authorization: "Bearer " + token } }),
        firestoreRequest(walletUrl, token)
      ]);
      if (existing.ok) {
        return Response.json({ error: isAdmin ? "Lượt quay này đã được xử lý." : "Bạn đã quay hôm nay rồi." }, { status: 409, headers: cors });
      }
      if (existing.status !== 404) {
        const errText = await existing.text();
        throw new Error("Không kiểm tra được lượt quay: " + errText);
      }

      const rawPrizes = settings.fields && settings.fields.prizes && settings.fields.prizes.arrayValue
        ? (settings.fields.prizes.arrayValue.values || []).map(v => v.stringValue || "")
        : [];
      const prizes = parsePrizes(rawPrizes);
      if (!isAdmin && settings.fields && settings.fields.freeDailyEnabled && settings.fields.freeDailyEnabled.booleanValue === false) {
        throw new Error("Lượt quay miễn phí hôm nay đang tạm khóa.");
      }
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
        prizes: prizes.map(prize => ({ label: prize.label, weight: prize.weight })),
        coinsAwarded: selected.coins,
        balance: newBalance,
        date
      }, { status: 200, headers: cors });
    } catch (error) {
      return Response.json({ error: error.message || "Lỗi máy chủ." }, { status: 400, headers: cors });
    }
  }
};